import assert from 'node:assert/strict'
import { test } from 'node:test'

import { Cards, dateMenu, statusLine } from '#src/cards.ts'
import { Db } from '#src/db.ts'
import { apiError, CHANNEL, fakeBot, OWNER } from '#src/testing.ts'

// Чт 2026-10-22 12:00 МСК.
const NOW = Date.UTC(2026, 9, 22, 9) / 1000

function setup() {
	const fake = fakeBot()
	const db = new Db(':memory:', () => NOW)
	const cards = new Cards(fake.api, db, { ownerId: OWNER, channelId: CHANNEL })

	return { fake, db, cards }
}

type Button = { text: string; callback_data?: string; url?: string }
const buttons = (markup: unknown) =>
	(markup as { inline_keyboard: Button[][] }).inline_keyboard.flat()

test('status line', () => {
	const { db } = setup()
	const post = db.create({
		rubric: 'девлог',
		text: 'x',
		voice: 100,
		projects: ['sorebody'],
	})

	assert.equal(statusLine(post), '#девлог · черновик · голос 100 · sorebody')

	assert.equal(
		statusLine(db.schedule(post.id, NOW + 3600)),
		'#девлог · запланирован на 22.10 13:00 · голос 100 · sorebody',
	)
})

test('show sends the post and a status message, replacing the old card', async () => {
	const { fake, db, cards } = setup()
	const post = db.create({ rubric: 'мысль', text: 'Текст' })

	await cards.show(post.id)
	const first = db.previewIds(post.id)

	assert.equal(fake.named('sendMessage')[0].text, 'Текст')

	assert.deepEqual(
		buttons(fake.named('sendMessage')[1].reply_markup).map((b) => b.text),
		['Дата', 'Править', 'Обложка', 'Удалить'],
	)

	await cards.show(post.id)
	assert.deepEqual(fake.named('deleteMessages')[0].message_ids, first)
	assert.equal(db.byPreview(first[0]), null)
})

test('published card links to the channel', async () => {
	const { fake, db, cards } = setup()
	const post = db.create({ rubric: 'мысль', text: 'Текст' })

	db.schedule(post.id, NOW)
	db.claim(post.id)
	db.published(post.id, 55)
	await cards.show(post.id)

	assert.deepEqual(buttons(fake.named('sendMessage')[1].reply_markup), [
		{ text: 'Открыть в канале', url: 'https://t.me/aimuzov_peeshet/55' },
	])
})

test('date menu hides today 19:00 once it has passed', () => {
	const late = Date.UTC(2026, 9, 22, 17) / 1000 // 20:00 МСК

	assert.ok(buttons(dateMenu(1, NOW)).some((b) => b.text === 'Сегодня 19:00'))
	assert.ok(!buttons(dateMenu(1, late)).some((b) => b.text === 'Сегодня 19:00'))
})

test('hide deletes the card and clears previews', async () => {
	const { fake, db, cards } = setup()
	const post = db.create({ rubric: 'мысль', text: 'Текст' })

	await cards.show(post.id)
	const ids = db.previewIds(post.id)

	await cards.hide(post.id)
	assert.deepEqual(fake.named('deleteMessages')[0].message_ids, ids)
	assert.deepEqual(db.previewIds(post.id), [])
})

test('album card registers all photos and the status message', async () => {
	const { db, cards } = setup()
	const post = db.create({ rubric: 'мысль', text: 'Текст' })

	db.addMedia(post.id, 'f1')
	db.addMedia(post.id, 'f2')
	await cards.show(post.id)
	assert.equal(db.previewIds(post.id).length, 3)
})

test('a failed status message removes the orphan post and keeps the old card', async () => {
	const { fake, db, cards } = setup()
	const post = db.create({ rubric: 'мысль', text: 'Текст' })

	await cards.show(post.id)
	const before = db.previewIds(post.id)

	let n = 0

	// Первый sendMessage (сам пост) проходит, второй (статус) падает.
	fake.answer('sendMessage', (p) => {
		if (++n === 2) throw apiError('sendMessage', 500, 'boom')

		return {
			message_id: 5000 + n,
			date: 0,
			chat: { id: p.chat_id, type: 'private' },
			text: p.text,
		}
	})

	await assert.rejects(cards.show(post.id), /boom/)
	assert.deepEqual(fake.named('deleteMessages').at(-1)?.message_ids, [5001])
	assert.deepEqual(db.previewIds(post.id), before)
})
