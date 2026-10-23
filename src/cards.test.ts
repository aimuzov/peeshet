import assert from 'node:assert/strict'
import { test } from 'node:test'

import { Cards, dateMenu, statusLine } from '#src/cards.ts'
import { Db } from '#src/db.ts'
import { apiError, CHANNEL, fakeBot, notModified, OWNER } from '#src/testing.ts'

// Чт 2026-10-22 12:00 МСК.
const NOW = Date.UTC(2026, 9, 22, 9) / 1000

function setup() {
	const fake = fakeBot()
	const db = new Db(':memory:', () => NOW)
	const cards = new Cards(fake.api, db, { ownerId: OWNER, channelId: CHANNEL })
	const post = db.create({ rubric: 'мысль', text: 'Текст' })

	return { fake, db, cards, post }
}

type Button = { text: string; callback_data?: string; url?: string }
const rows = (markup: unknown) =>
	(markup as { inline_keyboard: Button[][] }).inline_keyboard
const buttons = (markup: unknown) => rows(markup).flat()
const deleted = (fake: ReturnType<typeof fakeBot>) =>
	fake.named('deleteMessages').flatMap((p) => p.message_ids as number[])

const quiet = () => {
	const log = console.error

	console.error = () => {}

	return () => void (console.error = log)
}

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

	assert.equal(
		statusLine(post, 3),
		'#девлог · черновик · голос 100 · sorebody · альбом, 3 фото',
	)

	assert.equal(statusLine(post, 1), statusLine(post))
	// Ошибка уходит отдельным сообщением, в кнопку статуса её не пишем.
	assert.equal(statusLine({ ...post, error: 'boom' }), statusLine(post))
})

test('a text card is one message with the status as the top button', async () => {
	const { fake, db, cards, post } = setup()

	await cards.show(post.id)
	const [sent] = fake.named('sendMessage')

	assert.equal(fake.named('sendMessage').length, 1)
	assert.equal(sent.text, 'Текст')

	assert.deepEqual(rows(sent.reply_markup)[0], [
		{ text: '#мысль · черновик · голос —', callback_data: `n:${post.id}` },
	])

	assert.deepEqual(
		rows(sent.reply_markup)
			.slice(1)
			.flat()
			.map((b) => b.text),
		['Дата', 'Править', 'Обложка', 'Удалить'],
	)

	assert.equal(db.card(post.id)?.kind, 'text')
})

test('a text card is edited in place', async () => {
	const { fake, db, cards, post } = setup()

	await cards.show(post.id)
	const msgId = db.card(post.id)?.msgId

	db.setText(post.id, 'Новый текст')
	await cards.show(post.id)
	assert.equal(fake.named('sendMessage').length, 1)
	const [edit] = fake.named('editMessageText')

	assert.equal(edit.message_id, msgId)
	assert.equal(edit.chat_id, OWNER)
	assert.equal(edit.text, 'Новый текст')
	assert.ok(edit.reply_markup)
	assert.equal(db.card(post.id)?.msgId, msgId)
	assert.deepEqual(deleted(fake), [])
})

test('«message is not modified» is swallowed and the keyboard still syncs', async () => {
	const { fake, db, cards, post } = setup()

	await cards.show(post.id)
	fake.fail('editMessageText', notModified('editMessageText'))
	fake.fail('editMessageReplyMarkup', notModified('editMessageReplyMarkup'))
	await cards.show(post.id)
	assert.equal(fake.named('editMessageReplyMarkup').length, 1)
	assert.equal(fake.named('sendMessage').length, 1)
	assert.equal(db.card(post.id)?.kind, 'text')
})

test('a photo turns the text card into a photo card', async () => {
	const { fake, db, cards, post } = setup()

	await cards.show(post.id)
	const old = db.card(post.id)?.msgId

	db.addMedia(post.id, 'f1')
	await cards.show(post.id)
	const [sent] = fake.named('sendPhoto')

	assert.equal(sent.photo, 'f1')
	assert.equal(sent.caption, 'Текст')
	assert.equal(rows(sent.reply_markup)[0][0].callback_data, `n:${post.id}`)
	assert.equal(db.card(post.id)?.kind, 'photo')
	assert.notEqual(db.card(post.id)?.msgId, old)
	assert.deepEqual(deleted(fake), [old])
	assert.equal(fake.named('editMessageText').length, 0)
})

test('a second photo edits the media of the same message', async () => {
	const { fake, db, cards, post } = setup()

	db.addMedia(post.id, 'f1')
	await cards.show(post.id)
	const msgId = db.card(post.id)?.msgId

	db.addMedia(post.id, 'f2')
	await cards.show(post.id)
	assert.equal(fake.named('sendPhoto').length, 1)
	const [edit] = fake.named('editMessageMedia')

	assert.equal(edit.message_id, msgId)

	assert.deepEqual(edit.media, {
		type: 'photo',
		media: 'f1',
		caption: 'Текст',
	})

	assert.match(rows(edit.reply_markup)[0][0].text, /альбом, 2 фото$/)

	assert.ok(
		buttons(edit.reply_markup).some(
			(b) => b.text === 'Альбом' && b.callback_data === `a:${post.id}`,
		),
	)

	assert.equal(db.card(post.id)?.msgId, msgId)
})

test('a single photo has no album button', async () => {
	const { fake, db, cards, post } = setup()

	db.addMedia(post.id, 'f1')
	await cards.show(post.id)

	assert.ok(
		!buttons(fake.named('sendPhoto')[0].reply_markup).some(
			(b) => b.text === 'Альбом',
		),
	)
})

test('the album preview replies to the card and goes away on the next render', async () => {
	const { fake, db, cards, post } = setup()

	db.addMedia(post.id, 'f1')
	db.addMedia(post.id, 'f2')
	await cards.show(post.id)
	const card = db.card(post.id)?.msgId

	await cards.album(post.id)
	const [group] = fake.named('sendMediaGroup')

	assert.equal((group.media as unknown[]).length, 2)

	assert.equal(
		(group.reply_parameters as { message_id: number }).message_id,
		card,
	)

	const first = db.extras(post.id, 'album')

	assert.equal(first.length, 2)
	// Ответ на фото из альбома — это ответ на пост.
	assert.equal(db.byPreview(first[1])?.id, post.id)

	// Повторное нажатие не плодит копии.
	await cards.album(post.id)
	assert.deepEqual(deleted(fake), first)
	const second = db.extras(post.id, 'album')

	await cards.show(post.id)
	assert.deepEqual(deleted(fake), [...first, ...second])
	assert.deepEqual(db.extras(post.id), [])
})

test('published card links to the channel', async () => {
	const { fake, db, cards, post } = setup()

	db.schedule(post.id, NOW)
	db.claim(post.id)
	db.published(post.id, 55)
	await cards.show(post.id)
	const markup = fake.named('sendMessage')[0].reply_markup

	assert.equal(rows(markup)[0][0].text, '#мысль · опубликован · голос —')

	assert.deepEqual(rows(markup)[1], [
		{ text: 'Открыть в канале', url: 'https://t.me/aimuzov_peeshet/55' },
	])
})

test('date menu hides today 19:00 once it has passed', () => {
	const late = Date.UTC(2026, 9, 22, 17) / 1000 // 20:00 МСК

	assert.ok(buttons(dateMenu(1, NOW)).some((b) => b.text === 'Сегодня 19:00'))
	assert.ok(!buttons(dateMenu(1, late)).some((b) => b.text === 'Сегодня 19:00'))
})

test('hide deletes the card and its extras', async () => {
	const { fake, db, cards, post } = setup()

	await cards.show(post.id)
	const msgId = db.card(post.id)?.msgId

	db.addExtra(post.id, 900, 'album')
	await cards.hide(post.id)
	assert.deepEqual(deleted(fake), [msgId, 900])
	assert.equal(db.card(post.id), null)
	assert.deepEqual(db.extras(post.id), [])
})

test('a card that cannot be edited is sent anew', async () => {
	const { fake, db, cards, post } = setup()

	await cards.show(post.id)
	const old = db.card(post.id)?.msgId

	fake.fail(
		'editMessageText',
		apiError('editMessageText', 400, 'Bad Request: message to edit not found'),
	)

	await cards.show(post.id)
	assert.equal(fake.named('sendMessage').length, 2)
	assert.notEqual(db.card(post.id)?.msgId, old)
	assert.deepEqual(deleted(fake), [old])
})

test('a server error on edit is not hidden', async () => {
	const { fake, db, cards, post } = setup()

	await cards.show(post.id)
	const old = db.card(post.id)?.msgId

	fake.fail('editMessageText', apiError('editMessageText', 500, 'boom'))
	await assert.rejects(cards.show(post.id), /boom/)
	assert.equal(fake.named('sendMessage').length, 1)
	assert.equal(db.card(post.id)?.msgId, old)
})

test('a failed new card keeps the old one', async () => {
	const { fake, db, cards, post } = setup()

	await cards.show(post.id)
	const before = db.card(post.id)

	db.addMedia(post.id, 'f1')
	fake.fail('sendPhoto', apiError('sendPhoto', 500, 'boom'))
	await assert.rejects(cards.show(post.id), /boom/)
	assert.deepEqual(db.card(post.id), before)
	assert.deepEqual(deleted(fake), [])
})

test('failure edits the card and replies with the reason', async () => {
	const { fake, db, cards, post } = setup()

	await cards.show(post.id)
	const msgId = db.card(post.id)?.msgId

	db.schedule(post.id, NOW)
	db.claim(post.id)
	db.failed(post.id, 'Forbidden')
	await cards.failure(post.id)

	assert.match(
		String(rows(fake.named('editMessageText')[0].reply_markup)[0][0].text),
		/не вышел/,
	)

	const notice = fake.named('sendMessage').at(-1) ?? {}

	assert.equal(notice.text, 'Не вышел: Forbidden')

	assert.equal(
		(notice.reply_parameters as { message_id: number }).message_id,
		msgId,
	)

	// Следующая удачная отрисовка убирает уведомление.
	db.unschedule(post.id)
	await cards.show(post.id)
	assert.equal(deleted(fake).length, 1)
	assert.deepEqual(db.extras(post.id), [])
})

test('failure notice is sent even when the card cannot be drawn', async () => {
	const { fake, db, cards, post } = setup()
	const restore = quiet()

	db.schedule(post.id, NOW)
	db.claim(post.id)
	db.failed(post.id, 'Forbidden')

	let n = 0

	fake.answer('sendMessage', (p) => {
		if (++n === 1) throw apiError('sendMessage', 500, 'boom')

		return {
			message_id: 5000,
			date: 0,
			chat: { id: p.chat_id, type: 'private' },
			text: p.text,
		}
	})

	await cards.failure(post.id)
	restore()
	assert.equal(fake.named('sendMessage').at(-1)?.text, 'Не вышел: Forbidden')
	assert.equal(fake.named('sendMessage').at(-1)?.reply_parameters, undefined)
	assert.equal(db.byPreview(5000)?.id, post.id)
})
