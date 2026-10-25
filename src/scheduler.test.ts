import assert from 'node:assert/strict'
import { test } from 'node:test'

import { Cards } from '#src/cards.ts'
import { Db } from '#src/db.ts'
import { Scheduler } from '#src/scheduler.ts'
import {
	apiError,
	CHANNEL,
	fakeBot,
	MARKUP_ERROR,
	networkError,
	OWNER,
} from '#src/testing.ts'

const NOW = 1_790_000_000

let replyId = 2000

const reply = (p: Record<string, unknown>) => ({
	message_id: ++replyId,
	date: 0,
	chat: { id: p.chat_id, type: 'private' },
	rich_message: p.rich_message,
})

function setup() {
	const fake = fakeBot()
	const clock = { t: NOW }
	const db = new Db(':memory:', () => clock.t)
	const cfg = { ownerId: OWNER, channelId: CHANNEL }
	const cards = new Cards(fake.api, db, cfg)
	const scheduler = new Scheduler(fake.api, db, cards, cfg, async () => {})
	const post = db.create({ rubric: 'девлог', text: 'Пост' })

	return { fake, clock, db, scheduler, post, cards }
}

const toChannel = (fake: ReturnType<typeof fakeBot>) =>
	fake.named('sendRichMessage').filter((p) => p.chat_id === CHANNEL)
const cardsSent = (fake: ReturnType<typeof fakeBot>) =>
	fake.named('sendRichMessage').filter((p) => p.chat_id === OWNER)
const markdown = (p: Record<string, unknown>) =>
	(p.rich_message as { markdown: string }).markdown
const toOwner = (fake: ReturnType<typeof fakeBot>) =>
	fake
		.named('sendMessage')
		.filter((p) => p.chat_id === OWNER)
		.map((p) => String(p.text))

test('publishes when the time comes', async () => {
	const { fake, clock, db, scheduler, post } = setup()

	db.schedule(post.id, NOW + 60)
	await scheduler.tick()
	assert.equal(toChannel(fake).length, 0)
	clock.t = NOW + 60
	await scheduler.tick()
	assert.equal(toChannel(fake).length, 1)
	assert.equal(db.get(post.id).status, 'published')
	// Вместо «Вышло» карточка сама становится опубликованной.
	assert.ok(!toOwner(fake).some((t) => t.startsWith('Вышло')))
	const [card] = cardsSent(fake)
	const kb = JSON.stringify(card.reply_markup)

	assert.match(kb, /опубликован/)
	assert.match(kb, /https:\/\/t.me\/aimuzov_peeshet\//)
	assert.equal(db.card(post.id)?.msgId !== undefined, true)
	assert.equal(fake.named('deleteMessages').length, 0)
})

test('the channel gets the same rich message as the card, without buttons', async () => {
	const { fake, db, scheduler, post, cards } = setup()
	const text = 'Пост\n\n![](tg://photo?id=p2 "второе")'

	db.addMedia(post.id, 'f1')
	db.addMedia(post.id, 'f2')
	db.setText(post.id, text)
	await cards.show(post.id)
	db.schedule(post.id, NOW)
	await scheduler.tick()
	const [sent] = toChannel(fake)

	assert.deepEqual(sent.rich_message, {
		markdown: text,
		media: [{ id: 'p2', media: { type: 'photo', media: 'f2' } }],
	})

	assert.deepEqual(sent.rich_message, cardsSent(fake)[0].rich_message)
	assert.equal(sent.reply_markup, undefined)
	assert.equal(fake.named('sendMessage').length, 0)
	assert.equal(fake.named('sendPhoto').length, 0)
	assert.equal(fake.named('sendMediaGroup').length, 0)
})

test('publishing edits the existing card in place', async () => {
	const { fake, db, scheduler, post, cards } = setup()

	db.schedule(post.id, NOW)
	await cards.show(post.id)
	const msgId = db.card(post.id)?.msgId

	await scheduler.tick()
	assert.equal(cardsSent(fake).length, 1) // только сама карточка
	assert.equal(toOwner(fake).length, 0)
	const [edit] = fake.named('editMessageText')

	assert.equal(edit.message_id, msgId)
	assert.match(JSON.stringify(edit.reply_markup), /Открыть в канале/)
})

test('the published card survives a transient telegram error', async () => {
	const { fake, db, scheduler, post, cards } = setup()

	db.schedule(post.id, NOW)
	await cards.show(post.id)

	fake.fail(
		'editMessageText',
		apiError('editMessageText', 429, 'Too Many Requests', { retry_after: 1 }),
	)

	await scheduler.tick()
	const edits = fake.named('editMessageText')

	assert.equal(edits.length, 2)
	assert.match(JSON.stringify(edits[1].reply_markup), /опубликован/)
})

test('sends exactly once through retries', async () => {
	const { fake, db, scheduler, post } = setup()

	db.schedule(post.id, NOW)

	fake.fail(
		'sendRichMessage',
		networkError('sendRichMessage'),
		apiError('sendRichMessage', 429, 'Too Many Requests', { retry_after: 1 }),
	)

	await scheduler.tick()
	await scheduler.tick()
	assert.equal(db.get(post.id).status, 'published')
	// две упавшие попытки и одна удачная, второй тик ничего не шлёт
	assert.equal(toChannel(fake).length, 3)
})

test('failure is reported with the reason', async () => {
	const { fake, db, scheduler, post } = setup()

	db.schedule(post.id, NOW)

	fake.fail(
		'sendRichMessage',
		apiError(
			'sendRichMessage',
			403,
			'Forbidden: bot is not a member of the channel chat',
		),
	)

	await scheduler.tick()
	assert.equal(db.get(post.id).status, 'failed')
	const [notice] = fake.named('sendMessage').filter((p) => p.chat_id === OWNER)

	assert.match(JSON.stringify(cardsSent(fake)[0].reply_markup), /не вышел/)

	assert.equal(
		notice.text,
		'Не вышел: Forbidden: bot is not a member of the channel chat',
	)

	assert.equal(
		(notice.reply_parameters as { message_id: number }).message_id,
		db.card(post.id)?.msgId,
	)
})

test('recover: stuck posts fail, overdue ones go back to drafts', async () => {
	const { fake, clock, db, scheduler, post } = setup()
	const late = db.create({ rubric: 'мысль', text: 'Поздно' })

	db.schedule(post.id, NOW)
	db.claim(post.id)
	db.schedule(late.id, NOW)
	clock.t = NOW + 3600
	await scheduler.recover()
	assert.equal(db.get(post.id).status, 'failed')
	assert.equal(db.get(late.id).status, 'draft')
	await scheduler.tick()
	assert.equal(toChannel(fake).length, 0)
	assert.ok(toOwner(fake).some((t) => t.includes('не вышли вовремя')))
	assert.ok(toOwner(fake).some((t) => t.startsWith('Не вышел: Сервер упал')))
})

test('publishes the fresh text, not the due() snapshot', async () => {
	const { fake, db, scheduler, post } = setup()
	const second = db.create({ rubric: 'мысль', text: 'Старый текст' })

	db.schedule(post.id, NOW)
	db.schedule(second.id, NOW)

	fake.answer('sendRichMessage', (p) => {
		if (p.chat_id === CHANNEL && markdown(p) === 'Пост')
			db.setText(second.id, 'Новый текст')

		return reply(p)
	})

	await scheduler.tick()

	assert.deepEqual(toChannel(fake).map(markdown), ['Пост', 'Новый текст'])
})

test('a post rescheduled while the tick runs is not sent', async () => {
	const { fake, db, scheduler, post } = setup()
	const second = db.create({ rubric: 'мысль', text: 'Второй' })

	db.schedule(post.id, NOW)
	db.schedule(second.id, NOW)

	fake.answer('sendRichMessage', (p) => {
		if (p.chat_id === CHANNEL) db.schedule(second.id, NOW + 86400)

		return reply(p)
	})

	await scheduler.tick()
	assert.equal(toChannel(fake).length, 1)
	assert.equal(db.get(second.id).status, 'scheduled')
})

const quiet = () => {
	const orig = console.error

	console.error = () => {}

	return () => void (console.error = orig)
}

test('a failing card after publishing does not undo the publication', async () => {
	const { fake, db, scheduler, post } = setup()
	const restore = quiet()

	db.schedule(post.id, NOW)

	fake.answer('sendRichMessage', (p) => {
		if (p.chat_id === OWNER)
			throw apiError('sendRichMessage', 500, 'Internal Server Error')

		return reply(p)
	})

	await scheduler.tick()
	restore()
	assert.equal(db.get(post.id).status, 'published')
})

test('a failing card after a send failure still marks the post failed', async () => {
	const { fake, db, scheduler, post } = setup()
	const restore = quiet()

	db.schedule(post.id, NOW)
	fake.fail('sendRichMessage', apiError('sendRichMessage', 403, 'Forbidden'))

	fake.answer('sendRichMessage', (p) => {
		if (p.chat_id === OWNER)
			throw apiError('sendRichMessage', 500, 'Internal Server Error')

		return reply(p)
	})

	await scheduler.tick()
	restore()
	assert.equal(db.get(post.id).status, 'failed')
})

test('run survives a throwing tick', async () => {
	const { fake, db } = setup()
	const cfg = { ownerId: OWNER, channelId: CHANNEL }
	const scheduler = new Scheduler(
		fake.api,
		db,
		new Cards(fake.api, db, cfg),
		cfg,
		async () => {},
		1,
	)
	const restore = quiet()
	const ctl = new AbortController()
	let calls = 0

	db.due = () => {
		if (++calls === 1) throw new Error('boom')

		if (calls === 2) ctl.abort()

		return []
	}

	await scheduler.run(ctl.signal)
	restore()
	assert.equal(calls, 2)
})

test('recover survives a failing card and offers «Открыть»', async () => {
	const { fake, clock, db, scheduler, post } = setup()
	const late = db.create({ rubric: 'мысль', text: 'Поздно' })
	const restore = quiet()

	db.schedule(post.id, NOW)
	db.claim(post.id)
	db.schedule(late.id, NOW)
	clock.t = NOW + 3600
	fake.fail('sendRichMessage', apiError('sendRichMessage', 500, 'boom'))
	await scheduler.recover()
	restore()
	assert.equal(db.get(post.id).status, 'failed')
	const kb = JSON.stringify(
		fake.named('sendMessage').at(-1)?.reply_markup ?? {},
	)

	assert.match(kb, new RegExp(`o:${late.id}`))
	assert.doesNotMatch(kb, /"d:/)
})

test('publishing waits for a revise in flight and sends its final text', async () => {
	const { fake, db, scheduler, post, cards } = setup()
	let release = () => {}
	const gate = new Promise<void>((resolve) => (release = resolve))

	await cards.show(post.id)
	db.schedule(post.id, NOW)

	// Telegram думает над правкой карточки и в итоге её разметку не принимает.
	fake.answer('editMessageText', async (p) => {
		if (!markdown(p).includes('$$'))
			return { ...reply(p), message_id: p.message_id }

		await gate

		throw apiError('editMessageText', 400, MARKUP_ERROR)
	})

	fake.answer('sendRichMessage', (p) => {
		if (markdown(p).includes('$$'))
			throw apiError('sendRichMessage', 400, MARKUP_ERROR)

		return reply(p)
	})

	const revising = cards.revise(post.id, () => 'Формула $$')
	const ticking = scheduler.tick()

	await new Promise((resolve) => setImmediate(resolve))
	assert.equal(toChannel(fake).length, 0)
	assert.equal(db.get(post.id).status, 'scheduled')
	release()
	await assert.rejects(revising, /не принял/)
	await ticking
	assert.deepEqual(toChannel(fake).map(markdown), ['Пост'])
	assert.equal(db.get(post.id).status, 'published')
	assert.equal(db.revisions(post.id).length, 0)
})

test('overdue buttons name posts in plain text', async () => {
	const { fake, clock, db, scheduler } = setup()
	const md = db.create({
		rubric: 'мысль',
		text: '# Заголовок **жирный** [ссылка](https://example.com)\n\nдальше',
	})
	const pic = db.create({ rubric: 'мысль', text: 'x' })

	db.addMedia(pic.id, 'f1')

	db.setText(
		pic.id,
		'![](tg://photo?id=p1 "подпись")\n\n> _Цитата_ с `кодом` и длинным хвостом',
	)

	db.schedule(md.id, NOW)
	db.schedule(pic.id, NOW)
	clock.t = NOW + 3600
	await scheduler.recover()
	const markup = fake.named('sendMessage').at(-1)?.reply_markup as {
		inline_keyboard: { text: string }[][]
	}

	assert.deepEqual(
		markup.inline_keyboard
			.flat()
			.map((b) => b.text)
			.filter((t) => t.startsWith('Сейчас: ')),
		['Сейчас: Заголовок жирный ссылка', 'Сейчас: Цитата с кодом и длинным…'],
	)
})
