import assert from 'node:assert/strict'
import { test } from 'node:test'

import { Cards, dateMenu, statusLine } from '#src/cards.ts'
import { Db } from '#src/db.ts'
import { Invalid } from '#src/post.ts'
import {
	apiError,
	CHANNEL,
	fakeBot,
	MARKUP_ERROR,
	notModified,
	OWNER,
} from '#src/testing.ts'

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
type Rich = { markdown: string; media?: { id: string; media: unknown }[] }
const rows = (markup: unknown) =>
	(markup as { inline_keyboard: Button[][] }).inline_keyboard
const buttons = (markup: unknown) => rows(markup).flat()
const rich = (payload: Record<string, unknown> | undefined) =>
	payload?.rich_message as Rich
const deleted = (fake: ReturnType<typeof fakeBot>) =>
	fake.named('deleteMessages').flatMap((p) => p.message_ids as number[])
const photo = (key: string, caption?: string) =>
	`![](tg://photo?id=${key}${caption ? ` "${caption}"` : ''})`

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

	const long = db.create({
		rubric: 'девлог',
		text: 'x',
		voice: 100,
		projects: ['sorebody-frontend', 'peeshet-server', 'infra-server', 'thinks'],
	})
	const line = statusLine(long)

	// Кнопка не резиновая: строка статуса не длиннее 64 символов.
	assert.equal(line.length, 64)
	assert.ok(line.startsWith('#девлог · черновик · голос 100 · sorebody'))
	assert.ok(line.endsWith('…'))
	// Ошибка уходит отдельным сообщением, в кнопку статуса её не пишем.
	assert.equal(statusLine({ ...post, error: 'boom' }), statusLine(post))
})

test('a card is one rich message with the status as the top button', async () => {
	const { fake, cards, post } = setup()

	await cards.show(post.id)
	const [sent] = fake.named('sendRichMessage')

	assert.equal(fake.calls.length, 1)
	assert.equal(sent.chat_id, OWNER)
	assert.deepEqual(sent.rich_message, { markdown: 'Текст' })

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
})

test('the card carries only the photos the text refers to', async () => {
	const { fake, db, cards, post } = setup()

	db.addMedia(post.id, 'f1')
	db.addMedia(post.id, 'f2')
	db.setText(post.id, `Текст\n\n${photo('p2', 'второе')}`)
	await cards.show(post.id)

	assert.deepEqual(rich(fake.named('sendRichMessage')[0]), {
		markdown: `Текст\n\n${photo('p2', 'второе')}`,
		media: [{ id: 'p2', media: { type: 'photo', media: 'f2' } }],
	})

	assert.ok(
		!buttons(fake.named('sendRichMessage')[0].reply_markup).some(
			(b) => b.text === 'Альбом',
		),
	)
})

test('a card is edited in place, photos included', async () => {
	const { fake, db, cards, post } = setup()

	await cards.show(post.id)
	const msgId = db.card(post.id)?.msgId

	db.addMedia(post.id, 'f1')
	db.setText(post.id, `Новый текст\n\n${photo('p1')}`)
	await cards.show(post.id)
	assert.equal(fake.named('sendRichMessage').length, 1)
	const [edit] = fake.named('editMessageText')

	assert.equal(edit.message_id, msgId)
	assert.equal(edit.chat_id, OWNER)
	assert.equal(edit.text, undefined)

	assert.deepEqual(edit.rich_message, {
		markdown: `Новый текст\n\n${photo('p1')}`,
		media: [{ id: 'p1', media: { type: 'photo', media: 'f1' } }],
	})

	assert.equal(rows(edit.reply_markup)[0][0].callback_data, `n:${post.id}`)
	assert.equal(db.card(post.id)?.msgId, msgId)
	assert.deepEqual(deleted(fake), [])
})

test('«message is not modified» is swallowed and the keyboard still syncs', async () => {
	const { fake, cards, post } = setup()

	await cards.show(post.id)
	fake.fail('editMessageText', notModified('editMessageText'))
	fake.fail('editMessageReplyMarkup', notModified('editMessageReplyMarkup'))
	await cards.show(post.id)
	assert.equal(fake.named('editMessageReplyMarkup').length, 1)
	assert.equal(fake.named('sendRichMessage').length, 1)
})

test('published card links to the channel', async () => {
	const { fake, db, cards, post } = setup()

	db.schedule(post.id, NOW)
	db.claim(post.id)
	db.published(post.id, 55)
	await cards.show(post.id)
	const markup = fake.named('sendRichMessage')[0].reply_markup

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

	db.addExtra(post.id, 900, 'error')
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
	assert.equal(fake.named('sendRichMessage').length, 2)
	assert.notEqual(db.card(post.id)?.msgId, old)
	assert.deepEqual(deleted(fake), [old])
})

test('a server error on edit is not hidden', async () => {
	const { fake, db, cards, post } = setup()

	await cards.show(post.id)
	const old = db.card(post.id)?.msgId

	fake.fail('editMessageText', apiError('editMessageText', 500, 'boom'))
	await assert.rejects(cards.show(post.id), /boom/)
	assert.equal(fake.named('sendRichMessage').length, 1)
	assert.equal(db.card(post.id)?.msgId, old)
})

test('a failed new card keeps the old one', async () => {
	const { fake, db, cards, post } = setup()

	await cards.show(post.id)
	const before = db.card(post.id)

	fake.fail(
		'editMessageText',
		apiError('editMessageText', 400, 'Bad Request: message to edit not found'),
	)

	fake.fail('sendRichMessage', apiError('sendRichMessage', 500, 'boom'))
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

	// Пока пост не вышел, перерисовка («Назад», обновление) уведомление не трогает.
	await cards.show(post.id)
	assert.equal(deleted(fake).length, 0)
	assert.equal(db.extras(post.id, 'error').length, 1)

	// После переноса уведомление больше не нужно.
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
	fake.fail('sendRichMessage', apiError('sendRichMessage', 500, 'boom'))

	fake.answer('sendMessage', (p) => ({
		message_id: 5000,
		date: 0,
		chat: { id: p.chat_id, type: 'private' },
		text: p.text,
	}))

	await cards.failure(post.id)
	restore()
	assert.equal(fake.named('sendMessage').at(-1)?.text, 'Не вышел: Forbidden')
	assert.equal(fake.named('sendMessage').at(-1)?.reply_parameters, undefined)
	assert.equal(db.byPreview(5000)?.id, post.id)
})

test('concurrent renders of one post leave exactly one card', async () => {
	const { fake, db, cards, post } = setup()

	await Promise.all([
		cards.show(post.id),
		cards.show(post.id),
		cards.show(post.id),
	])

	assert.equal(fake.named('sendRichMessage').length, 1)
	assert.equal(fake.named('editMessageText').length, 2)
	assert.deepEqual(deleted(fake), [])
	assert.ok(db.card(post.id))
})

test('a queued render reads the post when its turn comes', async () => {
	const { fake, db, cards, post } = setup()
	let release = () => {}
	const gate = new Promise<void>((resolve) => (release = resolve))

	fake.answer('sendRichMessage', async (p) => {
		await gate

		return {
			message_id: 3000,
			date: 0,
			chat: { id: p.chat_id, type: 'private' },
			rich_message: p.rich_message,
		}
	})

	db.schedule(post.id, NOW)
	const first = cards.show(post.id)
	const second = cards.show(post.id)

	db.claim(post.id)
	db.published(post.id, 55)
	release()
	await Promise.all([first, second])
	assert.equal(fake.named('sendRichMessage').length, 1)

	assert.match(
		JSON.stringify(fake.named('editMessageText').at(-1)?.reply_markup),
		/опубликован/,
	)
})

test('an extra that failed to delete is retried on the next render', async () => {
	const { fake, db, cards, post } = setup()
	const restore = quiet()

	await cards.show(post.id)
	db.addExtra(post.id, 900, 'error')
	fake.fail('deleteMessages', apiError('deleteMessages', 500, 'boom'))
	await cards.show(post.id)
	assert.deepEqual(db.extras(post.id), [900])
	await cards.show(post.id)
	restore()
	assert.deepEqual(db.extras(post.id), [])
	assert.equal(fake.named('deleteMessages').length, 2)
})

test('an extra that is already gone is forgotten', async () => {
	const { fake, db, cards, post } = setup()

	await cards.show(post.id)
	db.addExtra(post.id, 900, 'error')

	fake.fail(
		'deleteMessages',
		apiError('deleteMessages', 400, 'Bad Request: message to delete not found'),
	)

	await cards.show(post.id)
	assert.deepEqual(db.extras(post.id), [])
})

const rejection = (e: unknown) =>
	e instanceof Invalid &&
	e.message === `Telegram не принял разметку: ${MARKUP_ERROR}`

test('revise saves the text and edits the card', async () => {
	const { fake, db, cards, post } = setup()

	await cards.show(post.id)
	assert.equal(await cards.revise(post.id, (t) => `${t}, дополнен`), true)
	assert.equal(db.get(post.id).text, 'Текст, дополнен')

	assert.deepEqual(
		db.revisions(post.id).map((r) => r.text),
		['Текст'],
	)

	assert.deepEqual(rich(fake.named('editMessageText')[0]), {
		markdown: 'Текст, дополнен',
	})
})

test('markup telegram rejects is rolled back and the card stays', async () => {
	const { fake, db, cards, post } = setup()

	await cards.show(post.id)
	const card = db.card(post.id)

	fake.rejectMarkup('$$')

	await assert.rejects(
		cards.revise(post.id, () => 'Формула $$'),
		rejection,
	)

	assert.equal(db.get(post.id).text, 'Текст')
	assert.deepEqual(db.revisions(post.id), [])
	assert.deepEqual(db.card(post.id), card)
	assert.deepEqual(deleted(fake), [])
})

test('markup is rejected for a post without a card too', async () => {
	const { fake, db, cards, post } = setup()

	fake.rejectMarkup('$$')

	await assert.rejects(
		cards.revise(post.id, () => 'Формула $$'),
		rejection,
	)

	assert.equal(db.get(post.id).text, 'Текст')
	assert.equal(db.card(post.id), null)
})

test('limits are checked before telegram sees the text', async () => {
	const { fake, cards, post } = setup()

	await assert.rejects(
		cards.revise(post.id, () => '![](tg://photo?id=p1)'),
		/p1/,
	)

	assert.equal(fake.calls.length, 0)
})

test('a card that fails for another reason keeps the new text', async () => {
	const { fake, db, cards, post } = setup()
	const restore = quiet()

	await cards.show(post.id)
	fake.fail('editMessageText', apiError('editMessageText', 500, 'boom'))
	const shown = await cards.revise(post.id, () => 'Новый')

	restore()
	assert.equal(shown, false)
	assert.equal(db.get(post.id).text, 'Новый')
})

test('create shows the card of the new post', async () => {
	const { fake, db, cards } = setup()
	const { post, card } = await cards.create({ rubric: 'релиз', text: 'Вышло' })

	assert.equal(card, true)
	assert.equal(db.get(post.id).text, 'Вышло')
	assert.ok(db.card(post.id))
	assert.equal(fake.named('sendRichMessage').length, 1)
})

test('a new post with rejected markup does not stay in the queue', async () => {
	const { fake, db, cards, post } = setup()

	fake.rejectMarkup('$$')

	await assert.rejects(
		cards.create({ rubric: 'релиз', text: 'Формула $$' }),
		rejection,
	)

	assert.deepEqual(
		db.list().map((p) => p.id),
		[post.id],
	)
})
