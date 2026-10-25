import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
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

test('network errors include the cause', async () => {
	const server = createServer()

	await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))

	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

	await new Promise((r) => server.close(r))

	await assert.rejects(
		new PeeshetClient(url, 's').request('GET', '/health'),
		/ECONNREFUSED/,
	)
})

test('a 2xx answer that is not json points at the url', async (t) => {
	const server = createServer((_, res) => res.end('<html>'))

	await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
	t.after(() => server.close())

	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

	await assert.rejects(
		new PeeshetClient(url, 's').request('GET', '/health'),
		/не JSON \(проверь PEESHET_API_URL\)/,
	)
})

test('a silent server hits the timeout', async (t) => {
	const server = createServer(() => {})

	await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))

	t.after(() => {
		server.closeAllConnections()
		server.close()
	})

	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

	await assert.rejects(
		new PeeshetClient(url, 's').request('GET', '/x', undefined, {
			timeoutMs: 50,
		}),
		/peeshet не ответил за 0 с/,
	)
})

test('an aborted signal is a cancelled request', async (t) => {
	const server = createServer(() => {})

	await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))

	t.after(() => {
		server.closeAllConnections()
		server.close()
	})

	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
	const ctl = new AbortController()
	const pending = new PeeshetClient(url, 's').request('GET', '/x', undefined, {
		signal: ctl.signal,
	})

	ctl.abort()
	await assert.rejects(pending, /Запрос отменён/)
})
