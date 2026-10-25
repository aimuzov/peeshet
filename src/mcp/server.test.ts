import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'

import { createServer } from '#src/mcp/server.ts'
import { stub } from '#src/mcp/testing.ts'

type Call = { method: string; url: string; type: unknown; body: Buffer }

/** Заглушка API плюс MCP-клиент, подключённый к серверу в памяти. */
async function setup(
	t: { after: (fn: () => void) => void },
	reply: (req: Call) => [number, unknown] = () => [200, { ok: true }],
	token = 'secret',
) {
	const calls: Call[] = []
	const { server, url } = await stub((req) => {
		const call = {
			method: req.method,
			url: req.url,
			type: req.headers['content-type'],
			body: req.body,
		}

		calls.push(call)

		return reply(call)
	})
	const [a, b] = InMemoryTransport.createLinkedPair()
	const client = new Client({ name: 'test', version: '0' })

	await createServer({ url, token }).connect(a)
	await client.connect(b)

	t.after(() => {
		void client.close()
		server.close()
	})

	const call = async (name: string, args: Record<string, unknown> = {}) => {
		const res = await client.callTool({ name, arguments: args })
		const content = res.content as { text: string }[]

		return { isError: res.isError, text: content[0]!.text }
	}

	return { calls, client, call }
}

test('lists all tools', async (t) => {
	const { client } = await setup(t)
	const names = (await client.listTools()).tools.map((x) => x.name).sort()

	assert.deepEqual(
		names,
		[
			'ack_inbox',
			'attach_image',
			'create_post',
			'get_post',
			'list_posts',
			'next_inbox',
			'preview_post',
			'revert_post',
			'schedule_post',
			'unschedule_post',
			'update_post',
		].sort(),
	)
})

test('create_post sends the arguments and returns the post json', async (t) => {
	const { calls, call } = await setup(t, () => [201, { id: 7, card: true }])
	const res = await call('create_post', { rubric: 'девлог', text: 'Привет' })

	assert.equal(calls[0]!.method, 'POST')
	assert.equal(calls[0]!.url, '/api/posts')

	assert.deepEqual(JSON.parse(calls[0]!.body.toString()), {
		rubric: 'девлог',
		text: 'Привет',
	})

	assert.deepEqual(JSON.parse(res.text), { id: 7, card: true })
})

test('update_post puts the id into the path only', async (t) => {
	const { calls, call } = await setup(t)

	await call('update_post', { id: 3, text: 'Новый' })
	assert.equal(calls[0]!.method, 'PATCH')
	assert.equal(calls[0]!.url, '/api/posts/3')
	assert.deepEqual(JSON.parse(calls[0]!.body.toString()), { text: 'Новый' })
})

test('api errors come back as isError with the server text', async (t) => {
	const { call } = await setup(t, () => [
		400,
		{ error: 'Время нужно с часовым поясом.' },
	])
	const res = await call('schedule_post', { id: 1, at: '2026-10-24T12:00:00' })

	assert.equal(res.isError, true)
	assert.match(res.text, /часовым поясом/)
})

test('attach_image uploads bytes with the type from the extension', async (t) => {
	const { calls, call } = await setup(t, () => [200, { key: 'p1' }])
	const dir = mkdtempSync(join(tmpdir(), 'peeshet-'))

	writeFileSync(join(dir, 'a.png'), Buffer.from([1, 2, 3]))
	writeFileSync(join(dir, 'b.jpg'), Buffer.from([4]))
	writeFileSync(join(dir, 'c.gif'), Buffer.from([5]))

	const png = await call('attach_image', { id: 2, path: join(dir, 'a.png') })

	assert.equal(JSON.parse(png.text).key, 'p1')
	assert.equal(calls[0]!.url, '/api/posts/2/media')
	assert.equal(calls[0]!.type, 'image/png')
	assert.equal(calls[0]!.body.length, 3)

	await call('attach_image', { id: 2, path: join(dir, 'b.jpg') })
	assert.equal(calls[1]!.type, 'image/jpeg')

	const gif = await call('attach_image', { id: 2, path: join(dir, 'c.gif') })

	assert.equal(gif.isError, true)
	assert.equal(calls.length, 2)
})

test('next_inbox passes wait and reports an empty inbox', async (t) => {
	const { calls, call } = await setup(t, () => [200, { item: null }])
	const res = await call('next_inbox', { wait: 5 })

	assert.equal(calls[0]!.url, '/api/inbox/next?wait=5')
	assert.equal(res.text, 'Входящих нет.')
})

test('next_inbox returns the item json', async (t) => {
	const { call } = await setup(t, () => [
		200,
		{ item: { id: 4, kind: 'reply', postId: 1, text: 'короче', srcMsgId: 9 } },
	])
	const res = await call('next_inbox', { wait: 0 })

	assert.equal(JSON.parse(res.text).item.kind, 'reply')
})

test('without a token every tool fails before any request', async (t) => {
	const { calls, call } = await setup(t, undefined, '')
	const res = await call('list_posts')

	assert.equal(res.isError, true)
	assert.equal(res.text, 'PEESHET_API_TOKEN не задан')
	assert.equal(calls.length, 0)
})
