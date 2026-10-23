import assert from 'node:assert/strict'
import { test } from 'node:test'

import { Cards } from '#src/cards.ts'
import { Db } from '#src/db.ts'
import { Scheduler } from '#src/scheduler.ts'
import {
	apiError,
	CHANNEL,
	fakeBot,
	networkError,
	OWNER,
} from '#src/testing.ts'

const NOW = 1_790_000_000

function setup() {
	const fake = fakeBot()
	const clock = { t: NOW }
	const db = new Db(':memory:', () => clock.t)
	const cfg = { ownerId: OWNER, channelId: CHANNEL }
	const scheduler = new Scheduler(
		fake.api,
		db,
		new Cards(fake.api, db, cfg),
		cfg,
		async () => {},
	)
	const post = db.create({ rubric: 'девлог', text: 'Пост' })

	return { fake, clock, db, scheduler, post }
}

const toChannel = (fake: ReturnType<typeof fakeBot>) =>
	fake.named('sendMessage').filter((p) => p.chat_id === CHANNEL)
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

	assert.ok(
		toOwner(fake).some((t) =>
			t.startsWith('Вышло: https://t.me/aimuzov_peeshet/'),
		),
	)
})

test('sends exactly once through retries', async () => {
	const { fake, db, scheduler, post } = setup()

	db.schedule(post.id, NOW)

	fake.fail(
		'sendMessage',
		networkError('sendMessage'),
		apiError('sendMessage', 429, 'Too Many Requests', { retry_after: 1 }),
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
		'sendMessage',
		apiError(
			'sendMessage',
			403,
			'Forbidden: bot is not a member of the channel chat',
		),
	)

	await scheduler.tick()
	assert.equal(db.get(post.id).status, 'failed')
	const status = toOwner(fake).find((t) => t.startsWith('#девлог · не вышел'))

	assert.match(String(status), /Forbidden/)
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
})

test('nudges once when nobody takes the inbox', async () => {
	const { fake, clock, db, scheduler } = setup()
	const nudges = () =>
		toOwner(fake).filter((t) => t.includes('Сессия на маке не запущена'))

	db.push('message', null, 'привет')
	await scheduler.tick()
	assert.equal(nudges().length, 0)
	clock.t = NOW + 120
	await scheduler.tick()
	await scheduler.tick()
	assert.equal(nudges().length, 1)
	db.take()
	await scheduler.tick() // входящих не осталось — флаг сбрасывается
	db.push('message', null, 'ещё')
	clock.t = NOW + 300
	await scheduler.tick()
	assert.equal(nudges().length, 2)
})

test('publishes the fresh text, not the due() snapshot', async () => {
	const { fake, db, scheduler, post } = setup()
	const second = db.create({ rubric: 'мысль', text: 'Старый текст' })

	db.schedule(post.id, NOW)
	db.schedule(second.id, NOW)

	fake.answer('sendMessage', (p) => {
		if (p.chat_id === CHANNEL && p.text === 'Пост')
			db.setText(second.id, 'Новый текст')

		return {
			message_id: 2000,
			date: 0,
			chat: { id: p.chat_id, type: 'channel' },
			text: p.text,
		}
	})

	await scheduler.tick()

	assert.deepEqual(
		toChannel(fake).map((p) => p.text),
		['Пост', 'Новый текст'],
	)
})

test('a post rescheduled while the tick runs is not sent', async () => {
	const { fake, db, scheduler, post } = setup()
	const second = db.create({ rubric: 'мысль', text: 'Второй' })

	db.schedule(post.id, NOW)
	db.schedule(second.id, NOW)

	fake.answer('sendMessage', (p) => {
		if (p.chat_id === CHANNEL) db.schedule(second.id, NOW + 86400)

		return {
			message_id: 2000,
			date: 0,
			chat: { id: p.chat_id, type: 'channel' },
			text: p.text,
		}
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

const reply = (p: Record<string, unknown>) => ({
	message_id: 2000,
	date: 0,
	chat: { id: p.chat_id, type: 'private' },
	text: p.text,
})

test('a failing «Вышло» notice does not undo the publication', async () => {
	const { fake, db, scheduler, post } = setup()
	const restore = quiet()

	db.schedule(post.id, NOW)

	fake.answer('sendMessage', (p) => {
		if (p.chat_id === OWNER) throw apiError('sendMessage', 400, 'Bad Request')

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
	fake.fail('sendMessage', apiError('sendMessage', 403, 'Forbidden'))

	fake.answer('sendMessage', (p) => {
		if (p.chat_id === OWNER) throw apiError('sendMessage', 400, 'Bad Request')

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

test('nudge is retried after a failed send', async () => {
	const { fake, clock, db, scheduler } = setup()
	const restore = quiet()

	db.push('message', null, 'привет')
	clock.t = NOW + 120
	fake.fail('sendMessage', apiError('sendMessage', 400, 'Bad Request'))
	await scheduler.tick()
	await scheduler.tick()
	restore()

	assert.equal(
		toOwner(fake).filter((t) => t.includes('Сессия на маке не запущена'))
			.length,
		2,
	)
})

test('recover survives a failing card and offers «Открыть»', async () => {
	const { fake, clock, db, scheduler, post } = setup()
	const late = db.create({ rubric: 'мысль', text: 'Поздно' })
	const restore = quiet()

	db.schedule(post.id, NOW)
	db.claim(post.id)
	db.schedule(late.id, NOW)
	clock.t = NOW + 3600
	fake.fail('sendMessage', apiError('sendMessage', 400, 'Bad Request'))
	await scheduler.recover()
	restore()
	assert.equal(db.get(post.id).status, 'failed')
	const kb = JSON.stringify(
		fake.named('sendMessage').at(-1)?.reply_markup ?? {},
	)

	assert.match(kb, new RegExp(`o:${late.id}`))
	assert.doesNotMatch(kb, /"d:/)
})

test('overlapping ticks send one nudge', async () => {
	const { fake, clock, db, scheduler } = setup()

	db.push('message', null, 'привет')
	clock.t = NOW + 120
	await Promise.all([scheduler.tick(), scheduler.tick()])

	assert.equal(
		toOwner(fake).filter((t) => t.includes('Сессия на маке не запущена'))
			.length,
		1,
	)
})
