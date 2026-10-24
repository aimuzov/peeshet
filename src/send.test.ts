import assert from 'node:assert/strict'
import { test } from 'node:test'

import { reason, retry, richMessage, send } from '#src/send.ts'
import { apiError, fakeBot, networkError } from '#src/testing.ts'

const noSleep = async () => {}

const media = [
	{ key: 'p1', fileId: 'f1' },
	{ key: 'p2', fileId: 'f2' },
	{ key: 'p3', fileId: 'f3' },
]

test('a rich message carries only the photos the text refers to', () => {
	const text =
		'Привет\n\n![](tg://photo?id=p3 "третье")\n\n![](tg://photo?id=p1)'

	assert.deepEqual(richMessage(text, media), {
		markdown: text,
		media: [
			{ id: 'p3', media: { type: 'photo', media: 'f3' } },
			{ id: 'p1', media: { type: 'photo', media: 'f1' } },
		],
	})

	assert.deepEqual(richMessage('Без фото', media), { markdown: 'Без фото' })
})

test('a post goes out as one rich message', async () => {
	const fake = fakeBot()
	const text = 'Пост\n\n![](tg://photo?id=p2)'
	const id = await send(fake.api, 5, text, media, {
		reply_markup: { inline_keyboard: [] },
	})
	const [sent] = fake.named('sendRichMessage')

	assert.equal(typeof id, 'number')
	assert.equal(fake.calls.length, 1)
	assert.equal(sent.chat_id, 5)
	assert.deepEqual(sent.rich_message, richMessage(text, media))
	assert.deepEqual(sent.reply_markup, { inline_keyboard: [] })
})

test('retry repeats ECONNREFUSED and 429, then gives up after 4 calls', async () => {
	let calls = 0
	const waits: number[] = []
	const sleep = async (ms: number) => void waits.push(ms)

	const ok = await retry(async () => {
		calls += 1

		if (calls === 1) throw networkError('sendMessage')

		if (calls === 2)
			throw apiError('sendMessage', 429, 'Too Many Requests', {
				retry_after: 7,
			})

		return 'done'
	}, sleep)

	assert.equal(ok, 'done')
	assert.deepEqual(waits, [5000, 7000])

	calls = 0
	waits.length = 0

	await assert.rejects(
		retry(async () => {
			calls += 1

			throw networkError('sendMessage')
		}, sleep),
		/Network request/,
	)

	assert.equal(calls, 4)
	assert.equal(waits.length, 3)
})

test('retry does not repeat a network error that may have reached telegram', async () => {
	let calls = 0

	await assert.rejects(
		retry(async () => {
			calls += 1

			throw networkError('sendMessage', 'ECONNRESET')
		}, noSleep),
		/Network request/,
	)

	assert.equal(calls, 1)
})

test('retry throws instead of waiting out a long 429', async () => {
	const waits: number[] = []

	await assert.rejects(
		retry(
			async () => {
				throw apiError('sendMessage', 429, 'Too Many Requests', {
					retry_after: 120,
				})
			},
			async (ms) => void waits.push(ms),
		),
		/Too Many/,
	)

	assert.deepEqual(waits, [])
})

test('retry does not repeat other api errors', async () => {
	let calls = 0

	await assert.rejects(
		retry(async () => {
			calls += 1

			throw apiError('sendMessage', 403, 'Forbidden: bot is not a member')
		}, noSleep),
		/Forbidden/,
	)

	assert.equal(calls, 1)
})

test('reason of a network error asks to check the channel', () => {
	assert.equal(
		reason(networkError('sendMessage', 'ECONNRESET')),
		'Связь с Telegram оборвалась, проверь канал: пост мог выйти.',
	)

	assert.equal(reason(apiError('sendMessage', 403, 'Forbidden')), 'Forbidden')
})
