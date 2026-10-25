import assert from 'node:assert/strict'
import { test } from 'node:test'

import { ApiError, PeeshetClient } from '#src/mcp/client.ts'
import { stub } from '#src/mcp/testing.ts'

test('sends the bearer token and parses json', async (t) => {
	const { server, url } = await stub((req) => [
		200,
		{ auth: req.headers.authorization, path: req.url },
	])

	t.after(() => server.close())
	const api = new PeeshetClient(url, 'secret')

	assert.deepEqual(await api.request('GET', '/api/posts?status=draft'), {
		auth: 'Bearer secret',
		path: '/api/posts?status=draft',
	})
})

test('api errors keep the server message', async (t) => {
	const { server, url } = await stub(() => [
		400,
		{ error: 'Telegram не принял разметку: x' },
	])

	t.after(() => server.close())

	await assert.rejects(
		new PeeshetClient(url, 's').request('POST', '/api/posts', {}),
		(e) =>
			e instanceof ApiError && e.status === 400 && /не принял/.test(e.message),
	)
})

test('upload sends raw bytes with the image content type', async (t) => {
	let seen = { type: '', size: 0 }
	const { server, url } = await stub((req) => {
		seen = { type: String(req.headers['content-type']), size: req.body.length }

		return [200, { key: 'p1' }]
	})

	t.after(() => server.close())

	await new PeeshetClient(url, 's').upload(
		1,
		new Uint8Array([1, 2, 3]),
		'image/png',
	)

	assert.deepEqual(seen, { type: 'image/png', size: 3 })
})

test('unreachable server is a readable error', async () => {
	await assert.rejects(
		new PeeshetClient('http://127.0.0.1:9', 's').request('GET', '/health'),
		/peeshet недоступен/,
	)
})
