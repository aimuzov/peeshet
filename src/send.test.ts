import assert from 'node:assert/strict'
import { test } from 'node:test'

import { reason, retry, send } from '#src/send.ts'
import { apiError, fakeBot, networkError } from '#src/testing.ts'

const noSleep = async () => {}

test('text, photo and album go through the right method', async () => {
	const fake = fakeBot()

	assert.equal((await send(fake.api, 5, 'hi', [])).length, 1)
	await send(fake.api, 5, 'cap', ['f1'])
	const album = await send(fake.api, 5, 'cap', ['f1', 'f2', 'f3'])

	assert.equal(album.length, 3)
	assert.equal(fake.named('sendMessage')[0].text, 'hi')
	assert.equal(fake.named('sendPhoto')[0].caption, 'cap')
	const media = fake.named('sendMediaGroup')[0].media as { caption?: string }[]

	assert.equal(media[0].caption, 'cap')
	assert.equal(media[1].caption, undefined)
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
