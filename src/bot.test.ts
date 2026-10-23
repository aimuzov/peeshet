import assert from 'node:assert/strict'
import { test } from 'node:test'

import { handlers } from '#src/bot.ts'
import { Cards } from '#src/cards.ts'
import { Db } from '#src/db.ts'
import { CHANNEL, fakeBot, OWNER, press, text } from '#src/testing.ts'
import { mskDayStart } from '#src/time.ts'

// Чт 2026-10-22 12:00 МСК.
const NOW = Date.UTC(2026, 9, 22, 9) / 1000

function setup() {
	const fake = fakeBot()
	const db = new Db(':memory:', () => NOW)
	const cards = new Cards(fake.api, db, { ownerId: OWNER, channelId: CHANNEL })
	let kicks = 0

	fake.bot.use(
		handlers({ db, cards, ownerId: OWNER, kick: () => void kicks++ }),
	)

	const post = db.create({ rubric: 'девлог', text: 'Пост' })

	return { fake, db, post, kicks: () => kicks }
}

test('strangers are ignored', async () => {
	const { fake, db } = setup()

	await fake.feed(text('привет', { from: 5 }))
	await fake.feed(press('x:1', { from: 5 }))
	assert.equal(fake.calls.length, 0)
	assert.equal(db.take(), null)
})

test('plain text goes to the inbox', async () => {
	const { fake, db } = setup()

	await fake.feed(text('девлог по sorebody'))
	const item = db.take()

	assert.equal(item?.kind, 'message')
	assert.equal(item?.text, 'девлог по sorebody')

	assert.ok(
		fake.named('sendMessage').some((p) => String(p.text).includes('Передал')),
	)
})

test('reply to a card is an edit request for that post', async () => {
	const { fake, db, post } = setup()

	db.setPreview(post.id, [500, 501])
	await fake.feed(text('сократи', { replyTo: 501 }))
	const item = db.take()

	assert.equal(item?.kind, 'reply')
	assert.equal(item?.postId, post.id)
	assert.equal(item?.text, 'сократи')
})

test('edit button waits for the next message', async () => {
	const { fake, db, post } = setup()

	await fake.feed(press(`e:${post.id}`))
	await fake.feed(text('убери второй абзац'))
	const item = db.take()

	assert.equal(item?.kind, 'reply')
	assert.equal(item?.postId, post.id)
})

test('date presets schedule the post', async () => {
	const { fake, db, post, kicks } = setup()

	await fake.feed(press(`s:${post.id}:tomorrow`))
	assert.equal(db.get(post.id).publishAt, mskDayStart(NOW) + 34 * 3600)
	await fake.feed(press(`s:${post.id}:now`))
	assert.equal(db.get(post.id).publishAt, NOW)
	assert.equal(kicks(), 1)
	await fake.feed(press(`u:${post.id}`))
	assert.equal(db.get(post.id).status, 'draft')
})

test('custom time asks and forwards the answer', async () => {
	const { fake, db, post } = setup()

	await fake.feed(press(`s:${post.id}:custom`))
	await fake.feed(text('в пятницу в 12'))
	const item = db.take()

	assert.equal(item?.kind, 'reply')
	assert.equal(item?.postId, post.id)
	assert.equal(item?.text, 'Время публикации: в пятницу в 12')
})

test('delete asks first', async () => {
	const { fake, db, post } = setup()

	await fake.feed(press(`x:${post.id}`))
	assert.equal(db.get(post.id).status, 'draft')
	await fake.feed(press(`xx:${post.id}`))
	assert.equal(db.get(post.id).status, 'deleted')
})

test('photo in reply to a card is attached', async () => {
	const { fake, db, post } = setup()

	db.setPreview(post.id, [600])

	await fake.feed({
		message: {
			message_id: 9,
			date: 0,
			chat: { id: OWNER, type: 'private' },
			from: { id: OWNER, is_bot: false, first_name: 'A' },
			photo: [
				{ file_id: 'small', file_unique_id: 's', width: 90, height: 90 },
				{ file_id: 'big', file_unique_id: 'b', width: 1280, height: 1280 },
			],
			reply_to_message: {
				message_id: 600,
				date: 0,
				chat: { id: OWNER, type: 'private' },
			},
		},
	})

	assert.deepEqual(db.media(post.id), ['big'])
	assert.equal(db.take()?.kind, 'photo')
})

test('voice gets a polite refusal', async () => {
	const { fake, db } = setup()

	await fake.feed({
		message: {
			message_id: 10,
			date: 0,
			chat: { id: OWNER, type: 'private' },
			from: { id: OWNER, is_bot: false, first_name: 'A' },
			voice: { file_id: 'v', file_unique_id: 'v', duration: 3 },
		},
	})

	assert.match(String(fake.named('sendMessage').at(-1)?.text), /Голосовые/)
	assert.equal(db.take(), null)
})

test('invalid action shows an alert', async () => {
	const { fake, db, post } = setup()

	db.remove(post.id)
	await fake.feed(press(`s:${post.id}:now`))
	const answer = fake.named('answerCallbackQuery').at(-1)

	assert.equal(answer?.show_alert, true)
	assert.match(String(answer?.text), /удалён/)
})

test('queue lists drafts and scheduled posts', async () => {
	const { fake } = setup()

	await fake.feed(text('/queue'))

	assert.match(
		String(fake.named('sendMessage').at(-1)?.text),
		/#девлог · черновик/,
	)
})
