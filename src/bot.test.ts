import assert from 'node:assert/strict'
import { test } from 'node:test'

import { handlers } from '#src/bot.ts'
import { Cards } from '#src/cards.ts'
import { Db } from '#src/db.ts'
import { Scheduler } from '#src/scheduler.ts'
import {
	apiError,
	CHANNEL,
	fakeBot,
	OWNER,
	photo,
	press,
	text,
} from '#src/testing.ts'
import { mskDayStart } from '#src/time.ts'

// Чт 2026-10-22 12:00 МСК.
const NOW = Date.UTC(2026, 9, 22, 9) / 1000

function setup(
	kickWith?: (deps: {
		fake: ReturnType<typeof fakeBot>
		db: Db
		cards: Cards
	}) => () => void,
) {
	const fake = fakeBot()
	const clock = { t: NOW }
	const db = new Db(':memory:', () => clock.t)
	const cards = new Cards(fake.api, db, { ownerId: OWNER, channelId: CHANNEL })
	let kicks = 0
	const inner = kickWith?.({ fake, db, cards })
	const kick = () => {
		kicks++
		inner?.()
	}

	fake.bot.use(handlers({ db, cards, ownerId: OWNER, kick }))

	const post = db.create({ rubric: 'девлог', text: 'Пост' })

	return { fake, clock, db, post, kicks: () => kicks }
}

test('strangers are ignored', async () => {
	const { fake, db } = setup()

	await fake.feed(text('привет', { from: 5 }))
	await fake.feed(press('x:1', { from: 5 }))
	assert.equal(fake.calls.length, 0)
	assert.equal(db.take(), null)
})

test('plain text goes to the inbox with a reaction instead of a reply', async () => {
	const { fake, db } = setup()
	const update = text('девлог по sorebody')

	await fake.feed(update)
	const item = db.take()

	assert.equal(item?.kind, 'message')
	assert.equal(item?.text, 'девлог по sorebody')
	assert.equal(item?.srcMsgId, update.message.message_id)
	assert.equal(fake.named('sendMessage').length, 0)

	assert.deepEqual(fake.named('setMessageReaction'), [
		{
			chat_id: OWNER,
			message_id: update.message.message_id,
			reaction: [{ type: 'emoji', emoji: '👀' }],
		},
	])
})

test('a failed reaction does not lose the message', async () => {
	const { fake, db } = setup()

	fake.fail(
		'setMessageReaction',
		apiError('setMessageReaction', 400, 'Bad Request: REACTION_INVALID'),
	)

	await fake.feed(text('привет'))
	assert.equal(db.take()?.text, 'привет')
})

test('the edit prompt is deleted once the answer arrives', async () => {
	const { fake, db, post } = setup()

	fake.answer('sendMessage', (p) => ({
		message_id: 4242,
		date: 0,
		chat: { id: p.chat_id, type: 'private' },
		text: p.text,
	}))

	await fake.feed(press(`e:${post.id}`))

	assert.equal(
		fake.named('sendMessage')[0].text,
		'Напиши, что поменять в посте.',
	)

	await fake.feed(text('убери второй абзац'))
	assert.equal(db.take()?.postId, post.id)

	assert.deepEqual(fake.named('deleteMessage'), [
		{ chat_id: OWNER, message_id: 4242 },
	])
})

test('the time prompt is deleted when another button cancels it', async () => {
	const { fake, post } = setup()

	await fake.feed(press(`s:${post.id}:custom`))
	assert.match(String(fake.named('sendMessage')[0].text), /Напиши дату/)
	await fake.feed(press(`u:${post.id}`)).catch(() => {})
	assert.equal(fake.named('deleteMessage').length, 1)
	await fake.feed(text('просто текст'))
	assert.equal(fake.named('deleteMessage').length, 1)
})

test('a second edit press replaces the prompt', async () => {
	const { fake, post } = setup()

	await fake.feed(press(`e:${post.id}`))
	await fake.feed(press(`e:${post.id}`))
	assert.equal(fake.named('sendMessage').length, 2)
	assert.equal(fake.named('deleteMessage').length, 1)
})

test('an expired prompt is deleted with the next message', async () => {
	const { fake, clock, db, post } = setup()

	await fake.feed(press(`e:${post.id}`))
	clock.t = NOW + 601
	await fake.feed(text('давно было'))
	assert.equal(db.take()?.kind, 'message')
	assert.equal(fake.named('deleteMessage').length, 1)
})

test('reply to a card is an edit request for that post', async () => {
	const { fake, db, post } = setup()

	db.setCard(post.id, 500, 'text')
	await fake.feed(text('сократи', { replyTo: 500 }))
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

test('photo in reply to a card is attached and the owner message removed', async () => {
	const { fake, db, post } = setup()

	db.setCard(post.id, 600, 'text')
	const update = photo('big', { replyTo: 600 })

	await fake.feed(update)
	assert.deepEqual(db.media(post.id), [{ key: 'p1', fileId: 'big' }])
	assert.equal(fake.named('sendPhoto')[0].photo, 'big')

	assert.deepEqual(fake.named('deleteMessage'), [
		{ chat_id: OWNER, message_id: update.message.message_id },
	])

	// Фото разобрал сервер, сессии тут делать нечего.
	assert.equal(db.take(), null)
	assert.equal(fake.named('sendMessage').length, 0)
})

test('a photo in reply to an album preview goes to that post', async () => {
	const { fake, db, post } = setup()

	db.addMedia(post.id, 'f1')
	db.addMedia(post.id, 'f2')
	db.setCard(post.id, 600, 'photo')
	db.addExtra(post.id, 601, 'album')
	await fake.feed(photo('f3', { replyTo: 601 }))

	assert.deepEqual(
		db.media(post.id).map((m) => m.fileId),
		['f1', 'f2', 'f3'],
	)

	assert.equal(fake.named('editMessageMedia')[0].message_id, 600)
	assert.deepEqual(db.extras(post.id), [])
})

test('a photo caption still reaches the session', async () => {
	const { fake, db, post } = setup()

	db.setCard(post.id, 600, 'text')
	await fake.feed(photo('big', { replyTo: 600, caption: 'поставь первой' }))
	const item = db.take()

	assert.equal(item?.kind, 'reply')
	assert.equal(item?.postId, post.id)
	assert.equal(item?.text, 'поставь первой')
	// Само фото уже удалено, удалять при ack нечего.
	assert.equal(item?.srcMsgId, null)
})

test('a photo without a card gets a hint', async () => {
	const { fake, db } = setup()

	await fake.feed(photo('big'))
	assert.match(String(fake.named('sendMessage')[0].text), /ответом на карточку/)
	assert.equal(fake.named('deleteMessage').length, 0)
	assert.equal(db.take(), null)
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

test('a successful button press answers the callback', async () => {
	const { fake, db, post } = setup()

	db.schedule(post.id, NOW + 60)
	await fake.feed(press(`u:${post.id}`))
	assert.equal(db.get(post.id).status, 'draft')
	assert.equal(fake.named('answerCallbackQuery').length, 1)
	assert.equal(fake.named('answerCallbackQuery')[0].show_alert, undefined)
})

test('«message is not modified» from editMessageReplyMarkup is a normal answer', async () => {
	const { fake, post } = setup()

	for (let i = 0; i < 2; i++)
		fake.fail(
			'editMessageReplyMarkup',
			apiError(
				'editMessageReplyMarkup',
				400,
				'Bad Request: message is not modified',
			),
		)

	await fake.feed(press(`d:${post.id}`))
	await fake.feed(press(`x:${post.id}`))
	const answers = fake.named('answerCallbackQuery')

	assert.equal(answers.length, 2)
	assert.equal(answers[0].show_alert, undefined)
	assert.equal(answers[1].show_alert, undefined)
})

test('another failure of editMessageReplyMarkup still answers the callback', async () => {
	const { fake, post } = setup()
	const log = console.error

	console.error = () => {}

	fake.fail(
		'editMessageReplyMarkup',
		apiError('editMessageReplyMarkup', 500, 'Internal Server Error'),
	)

	await fake.feed(press(`x:${post.id}`)).catch(() => {})
	console.error = log
	assert.equal(fake.named('answerCallbackQuery').length, 1)
})

test('edit on one card, then a reply to another card goes to the other post', async () => {
	const { fake, db, post } = setup()
	const other = db.create({ rubric: 'мысль', text: 'Другой' })

	db.setCard(other.id, 700, 'text')
	await fake.feed(press(`e:${post.id}`))
	await fake.feed(text('сократи', { replyTo: 700 }))
	const item = db.take()

	assert.equal(item?.postId, other.id)
	await fake.feed(text('просто текст'))
	assert.equal(db.take()?.kind, 'message')
})

test('awaiting expires after ten minutes', async () => {
	const { fake, clock, db, post } = setup()

	await fake.feed(press(`e:${post.id}`))
	clock.t = NOW + 601
	await fake.feed(text('давно было'))
	assert.equal(db.take()?.kind, 'message')
})

test('another button cancels awaiting', async () => {
	const { fake, db, post } = setup()

	await fake.feed(press(`e:${post.id}`))
	await fake.feed(press(`u:${post.id}`))
	await fake.feed(text('текст'))
	assert.equal(db.take()?.kind, 'message')
})

test('edit on a published post shows an alert', async () => {
	const { fake, db, post } = setup()

	db.schedule(post.id, NOW)
	db.claim(post.id)
	db.published(post.id, 5)
	await fake.feed(press(`e:${post.id}`))
	assert.equal(fake.named('answerCallbackQuery').at(-1)?.show_alert, true)
	await fake.feed(text('текст'))
	assert.equal(db.take()?.kind, 'message')
})

test('today and next presets schedule the post', async () => {
	const { fake, db, post } = setup()

	await fake.feed(press(`s:${post.id}:today`))
	assert.equal(db.get(post.id).publishAt, mskDayStart(NOW) + 19 * 3600)
	await fake.feed(press(`s:${post.id}:next`))
	assert.equal(db.get(post.id).status, 'scheduled')
	assert.ok((db.get(post.id).publishAt ?? 0) > NOW)
})

test('delete flow shows the confirm menu and xx hides the card', async () => {
	const { fake, db, post } = setup()

	db.setCard(post.id, 800, 'text')
	db.addExtra(post.id, 801, 'album')
	await fake.feed(press(`x:${post.id}`, { msgId: 800 }))
	assert.equal(fake.named('editMessageReplyMarkup').length, 1)
	assert.equal(fake.named('editMessageReplyMarkup')[0].message_id, 800)
	await fake.feed(press(`xx:${post.id}`, { msgId: 800 }))
	assert.deepEqual(fake.named('deleteMessages').at(-1)?.message_ids, [800, 801])
	assert.equal(db.card(post.id), null)
})

test('«Назад» from a menu restores the card in place', async () => {
	const { fake, db, post } = setup()

	db.setCard(post.id, 800, 'text')
	await fake.feed(press(`d:${post.id}`, { msgId: 800 }))
	await fake.feed(press(`o:${post.id}`, { msgId: 800 }))
	const [edit] = fake.named('editMessageText')

	assert.equal(edit.message_id, 800)
	assert.match(JSON.stringify(edit.reply_markup), new RegExp(`"n:${post.id}"`))
	assert.equal(fake.named('sendMessage').length, 0)
})

test('the status button answers silently', async () => {
	const { fake, post } = setup()

	await fake.feed(press(`n:${post.id}`))
	assert.equal(fake.calls.length, 1)
	assert.deepEqual(fake.named('answerCallbackQuery')[0].text, undefined)
})

test('the album button sends the whole album', async () => {
	const { fake, db, post } = setup()

	db.addMedia(post.id, 'f1')
	db.addMedia(post.id, 'f2')
	db.setCard(post.id, 800, 'photo')
	await fake.feed(press(`a:${post.id}`, { msgId: 800 }))
	assert.equal(fake.named('sendMediaGroup').length, 1)
	assert.equal(db.extras(post.id, 'album').length, 2)
	assert.equal(fake.named('answerCallbackQuery').length, 1)
})

test('a reply to an album preview goes to that post', async () => {
	const { fake, db, post } = setup()

	db.setCard(post.id, 800, 'photo')
	db.addExtra(post.id, 802, 'album')
	await fake.feed(text('поменяй порядок', { replyTo: 802 }))
	const item = db.take()

	assert.equal(item?.kind, 'reply')
	assert.equal(item?.postId, post.id)
})

test('/queue «Открыть» sends a fresh card when there is none', async () => {
	const { fake, post } = setup()

	await fake.feed(press(`o:${post.id}`))
	assert.equal(fake.named('sendMessage').length, 1)
	assert.equal(fake.named('sendMessage')[0].text, 'Пост')
})

test('owner messages in a group are ignored', async () => {
	const { fake, db } = setup()
	const update = text('привет')

	await fake.feed({
		message: {
			...update.message,
			chat: { id: -100, type: 'supergroup', title: 'g' },
		},
	})

	assert.equal(fake.calls.length, 0)
	assert.equal(db.take(), null)
})

test('«Сейчас» turns the card into the published one', async () => {
	let running: Promise<void> = Promise.resolve()
	let cardAtKick: number | undefined
	const { fake, db, post } = setup(({ fake, db, cards }) => {
		const scheduler = new Scheduler(
			fake.api,
			db,
			cards,
			{ ownerId: OWNER, channelId: CHANNEL },
			async () => {},
		)

		return () => {
			cardAtKick = db.card(db.list()[0].id)?.msgId
			running = scheduler.tick()
		}
	})

	await fake.feed(press(`s:${post.id}:now`))
	await running
	// Планировщик стартует, когда карточка уже нарисована, и правит её же.
	assert.ok(cardAtKick)
	assert.equal(db.get(post.id).status, 'published')
	assert.equal(db.card(post.id)?.msgId, cardAtKick)

	assert.match(
		JSON.stringify(fake.named('editMessageText').at(-1)?.reply_markup),
		/опубликован/,
	)

	assert.equal(fake.named('deleteMessages').length, 0)
})

test('/start replies with help and goes nowhere else', async () => {
	const { fake, db } = setup()

	await fake.feed(text('/start'))
	assert.match(String(fake.named('sendMessage').at(-1)?.text), /Присылай идеи/)
	assert.equal(db.take(), null)
})

test('an unknown command is not pushed to the inbox', async () => {
	const { fake, db } = setup()

	await fake.feed(text('/foo bar'))

	assert.equal(
		fake.named('sendMessage').at(-1)?.text,
		'Не знаю такой команды. /queue — очередь.',
	)

	assert.equal(db.take(), null)
})

test('a photo is kept even when the card refresh fails', async () => {
	const { fake, db, post } = setup()
	const log = console.error

	console.error = () => {}
	db.setCard(post.id, 600, 'text')
	fake.fail('sendPhoto', apiError('sendPhoto', 500, 'oops'))

	await fake.feed(photo('big', { replyTo: 600 }))
	console.error = log
	assert.deepEqual(db.media(post.id), [{ key: 'p1', fileId: 'big' }])
	assert.equal(db.take(), null)
	// Карточку не обновили: фото владельца остаётся, чтобы было видно, что пришло.
	assert.equal(fake.named('deleteMessage').length, 0)

	assert.equal(
		fake.named('sendMessage').at(-1)?.text,
		'Фото прикрепил, а карточку обновить не вышло.',
	)
})
