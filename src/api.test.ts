import assert from 'node:assert/strict'
import { request } from 'node:http'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'

import { serve } from '#src/api.ts'
import { Cards } from '#src/cards.ts'
import { Db } from '#src/db.ts'
import { apiError, CHANNEL, fakeBot, OWNER } from '#src/testing.ts'

const NOW = 1_790_000_000
const TOKEN = 't'.repeat(32)

type Json = Record<string, any>

async function setup() {
	const fake = fakeBot()
	const db = new Db(':memory:', () => NOW)
	const cards = new Cards(fake.api, db, { ownerId: OWNER, channelId: CHANNEL })
	const server = serve({
		api: fake.api,
		db,
		cards,
		ownerId: OWNER,
		token: TOKEN,
		port: 0,
		pollStep: 10,
	})

	await new Promise((resolve) => server.once('listening', resolve))
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
	const call = async (
		method: string,
		path: string,
		body?: unknown,
		headers: Record<string, string> = {},
	) => {
		const res = await fetch(base + path, {
			method,
			headers: {
				authorization: `Bearer ${TOKEN}`,
				'content-type': 'application/json',
				...headers,
			},
			body:
				body instanceof Uint8Array
					? (body as Uint8Array<ArrayBuffer>)
					: body === undefined
						? undefined
						: JSON.stringify(body),
		})

		return { status: res.status, json: (await res.json()) as Json }
	}

	return { fake, db, server, base, call }
}

test('health is open, the rest needs the token', async (t) => {
	const { server, base, call } = await setup()

	t.after(() => server.close())
	assert.equal((await fetch(`${base}/health`)).status, 200)
	assert.equal((await fetch(`${base}/api/posts`)).status, 401)

	assert.equal(
		(
			await call('GET', '/api/posts', undefined, {
				authorization: 'Bearer wrong',
			})
		).status,
		401,
	)

	assert.equal((await call('GET', '/api/nope')).status, 404)
})

test('create, edit, revert, schedule', async (t) => {
	const { fake, db, server, call } = await setup()

	t.after(() => server.close())
	const created = await call('POST', '/api/posts', {
		rubric: 'девлог',
		text: 'v1',
		voice: 96,
		projects: ['sorebody'],
	})

	assert.equal(created.status, 201)
	const id = created.json.id
	const at = new Date((NOW + 60) * 1000).toISOString()

	assert.equal(fake.named('sendMessage')[0].text, 'v1') // карточка пришла

	assert.equal(
		(await call('PATCH', `/api/posts/${id}`, { text: 'v2' })).json.text,
		'v2',
	)

	assert.equal((await call('POST', `/api/posts/${id}/revert`)).json.text, 'v1')

	assert.equal(
		(await call('POST', `/api/posts/${id}/schedule`, { at })).json.publishAt,
		NOW + 60,
	)

	assert.equal(
		(await call('POST', `/api/posts/${id}/unschedule`)).json.status,
		'draft',
	)

	assert.equal(
		(await call('POST', `/api/posts/${id}/schedule`, { slot: 'next' })).json
			.status,
		'scheduled',
	)
	// v2 откатили, ревизия v1 ушла из истории

	assert.equal((await call('GET', `/api/posts/${id}`)).json.revisions.length, 0)
	assert.equal(db.list().length, 1)
})

test('validation errors are 400 with a message', async (t) => {
	const { server, call } = await setup()

	t.after(() => server.close())

	assert.equal(
		(await call('POST', '/api/posts', { rubric: 'новости', text: 'x' })).status,
		400,
	)

	assert.equal(
		(
			await call('POST', '/api/posts', {
				rubric: 'мысль',
				text: 'a'.repeat(5000),
			})
		).json.error,
		'Текст длиннее 4096 символов: 5000.',
	)

	assert.equal((await call('POST', '/api/posts', '[1]')).status, 400)
	assert.equal((await call('GET', '/api/posts/999')).status, 404)
})

test('a rejected patch field saves nothing', async (t) => {
	const { db, server, call } = await setup()

	t.after(() => server.close())
	const { json } = await call('POST', '/api/posts', {
		rubric: 'мысль',
		text: 'v1',
	})
	const res = await call('PATCH', `/api/posts/${json.id}`, {
		text: 'v2',
		voice: 'high',
	})

	assert.equal(res.status, 400)
	assert.equal(db.get(json.id).text, 'v1')
	assert.equal(db.revisions(json.id).length, 0)
})

test('media upload goes through the owner chat to get a file_id', async (t) => {
	const { fake, db, server, call } = await setup()

	t.after(() => server.close())

	fake.answer('sendPhoto', (p) => ({
		message_id: 1,
		date: 0,
		chat: { id: OWNER, type: 'private' },
		...(typeof p.photo === 'string'
			? {}
			: { photo: [{ file_id: 'small' }, { file_id: 'big' }] }),
	}))

	const { json } = await call('POST', '/api/posts', {
		rubric: 'мысль',
		text: 'x',
	})
	const res = await call(
		'POST',
		`/api/posts/${json.id}/media`,
		new Uint8Array([1, 2, 3]),
		{
			'content-type': 'image/png',
		},
	)

	assert.equal(res.status, 200)
	assert.deepEqual(db.media(json.id), ['big'])
	assert.ok(fake.named('deleteMessage').length >= 1) // служебная картинка убрана
})

test('inbox long poll and ack', async (t) => {
	const { db, server, call } = await setup()

	t.after(() => server.close())

	assert.deepEqual((await call('GET', '/api/inbox/next?wait=0')).json, {
		item: null,
	})

	setTimeout(() => db.push('message', null, 'привет'), 30)
	const { json } = await call('GET', '/api/inbox/next?wait=2')

	assert.equal(json.item.text, 'привет')

	assert.equal(
		(await call('POST', `/api/inbox/${json.item.id}/ack`)).status,
		200,
	)
})

test('ack deletes the owner message the item came from', async (t) => {
	const { fake, db, server, call } = await setup()

	t.after(() => server.close())
	const plain = db.push('message', null, 'привет', 42)
	const cover = db.push(
		'cover',
		db.create({ rubric: 'мысль', text: 'x' }).id,
		null,
	)

	assert.equal((await call('GET', '/api/inbox/next')).json.item.srcMsgId, 42)

	fake.fail(
		'deleteMessage',
		apiError('deleteMessage', 400, 'Bad Request: message to delete not found'),
	)

	assert.equal((await call('POST', `/api/inbox/${plain.id}/ack`)).status, 200)

	assert.deepEqual(fake.named('deleteMessage'), [
		{ chat_id: OWNER, message_id: 42 },
	])

	assert.equal((await call('POST', `/api/inbox/${cover.id}/ack`)).status, 200)
	assert.equal(fake.named('deleteMessage').length, 1)
	assert.equal((await call('POST', '/api/inbox/999/ack')).status, 404)
})

const quiet = () => {
	const log = console.error

	console.error = () => {}

	return () => void (console.error = log)
}

test('a failing card refresh does not fail the request', async (t) => {
	const { fake, db, server, call } = await setup()
	const restore = quiet()

	t.after(() => server.close())
	// Первая карточка (текст) не уйдёт.
	fake.fail('sendMessage', apiError('sendMessage', 400, 'Bad Request'))

	const created = await call('POST', '/api/posts', {
		rubric: 'мысль',
		text: 'x',
	})

	assert.equal(created.status, 201)
	assert.equal(created.json.card, false)
	assert.equal(db.list().length, 1)

	const ok = await call('POST', `/api/posts/${created.json.id}/preview`)

	restore()
	assert.equal(ok.status, 200)
	assert.equal(ok.json.card, true)
})

test('a telegram error on upload is a 502 with its description', async (t) => {
	const { fake, db, server, call } = await setup()

	t.after(() => server.close())
	fake.fail('sendPhoto', apiError('sendPhoto', 400, 'Bad Request: bad photo'))

	const { json } = await call('POST', '/api/posts', {
		rubric: 'мысль',
		text: 'x',
	})
	const res = await call(
		'POST',
		`/api/posts/${json.id}/media`,
		new Uint8Array([1]),
		{ 'content-type': 'image/png' },
	)

	assert.equal(res.status, 502)
	assert.equal(res.json.error, 'Bad Request: bad photo')
	assert.deepEqual(db.media(json.id), [])
})

test('schedule needs an explicit utc offset', async (t) => {
	const { server, call } = await setup()

	t.after(() => server.close())
	const { json } = await call('POST', '/api/posts', {
		rubric: 'мысль',
		text: 'x',
	})
	const url = `/api/posts/${json.id}/schedule`

	for (const at of ['2026-10-24T12:00:00', '2026-10-24', 'tomorrow']) {
		const res = await call('POST', url, { at })

		assert.equal(res.status, 400, at)
	}

	assert.match(
		(await call('POST', url, { at: '2026-10-24T12:00:00' })).json.error,
		/часовым поясом/,
	)

	const msk = await call('POST', url, { at: '2026-10-24T12:00:00+03:00' })
	const utc = await call('POST', url, { at: '2026-10-24T09:00:00Z' })

	assert.equal(msk.status, 200)
	assert.equal(msk.json.publishAt, utc.json.publishAt)
})

test('a body over the limit is a 413', async (t) => {
	const { server, base, call } = await setup()

	t.after(() => server.close())
	const { json } = await call('POST', '/api/posts', {
		rubric: 'мысль',
		text: 'x',
	})
	const path = `/api/posts/${json.id}/media`
	const headers = {
		authorization: `Bearer ${TOKEN}`,
		'content-type': 'image/png',
	}
	const send = (extra: Record<string, string>, chunks: number) =>
		new Promise<{ status: number; connection?: string }>((resolve, reject) => {
			const req = request(
				base + path,
				{ method: 'POST', headers: { ...headers, ...extra } },
				(res) => {
					res.resume()

					resolve({
						status: res.statusCode ?? 0,
						connection: res.headers.connection,
					})
				},
			)

			req.on('error', reject)

			// Заголовок объявляет большое тело, но само оно не уходит.
			for (let i = 0; i < chunks; i++) req.write(Buffer.alloc(1024 * 1024))

			if (chunks) req.end()
			else req.flushHeaders()
		})

	const declared = await send({ 'content-length': String(11 * 1024 * 1024) }, 0)

	assert.equal(declared.status, 413)
	assert.equal(declared.connection, 'close')

	// Без content-length: переполнение ловится по ходу чтения.
	const streamed = await send({ 'transfer-encoding': 'chunked' }, 11)

	assert.equal(streamed.status, 413)
})

test('a doomed upload never reaches the owner chat', async (t) => {
	const { fake, server, call } = await setup()

	t.after(() => server.close())
	const { json } = await call('POST', '/api/posts', {
		rubric: 'мысль',
		text: 'a'.repeat(2000),
	})
	const res = await call(
		'POST',
		`/api/posts/${json.id}/media`,
		new Uint8Array([1]),
		{ 'content-type': 'image/png' },
	)

	assert.equal(res.status, 400)
	assert.equal(fake.named('sendPhoto').length, 0)
})
