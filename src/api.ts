// JSON API для локального MCP и облачных рутин. Удаления здесь нет: удаляет только владелец кнопкой.

import { timingSafeEqual } from 'node:crypto'
import {
	createServer,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import { GrammyError, InputFile, type Api } from 'grammy'

import type { Cards } from '#src/cards.ts'
import type { Db } from '#src/db.ts'
import {
	checkLimits,
	Invalid,
	isRubric,
	NotFound,
	type Post,
	type Rubric,
	type Status,
} from '#src/post.ts'
import { nextFreeSlot } from '#src/time.ts'

export type ApiDeps = {
	api: Api
	db: Db
	cards: Cards
	ownerId: number
	token: string
	port: number
	/** Шаг опроса входящих в long poll, мс. */
	pollStep?: number
}

// Столько же принимает sendPhoto.
const MAX_BODY = 10 * 1024 * 1024
const MAX_WAIT = 25
// Без явного пояса Date.parse берёт пояс сервера, а он не всегда московский.
const OFFSET = /(Z|[+-]\d\d:\d\d)$/

class ApiError extends Error {
	readonly status: number

	constructor(status: number, message: string) {
		super(message)
		this.status = status
	}
}

const notFound = () => new ApiError(404, 'Нет такого адреса.')

const reply = (
	res: ServerResponse,
	status: number,
	body: unknown,
	headers: Record<string, string> = {},
) => {
	res.writeHead(status, {
		'content-type': 'application/json; charset=utf-8',
		...headers,
	})

	res.end(JSON.stringify(body))
}

const TOO_BIG = 'Слишком большое тело запроса.'

async function readBody(req: IncomingMessage): Promise<Buffer> {
	// Заведомо большое тело не читаем вовсе: соединение закроется после ответа.
	if (Number(req.headers['content-length']) > MAX_BODY)
		throw new ApiError(413, TOO_BIG)

	const chunks: Buffer[] = []
	let size = 0

	for await (const chunk of req) {
		size += chunk.length

		if (size > MAX_BODY) {
			// Дочитываем в никуда, иначе клиент не получит ответ.
			req.resume()

			throw new ApiError(413, TOO_BIG)
		}

		chunks.push(chunk)
	}

	return Buffer.concat(chunks)
}

async function readJson(
	req: IncomingMessage,
): Promise<Record<string, unknown>> {
	const raw = (await readBody(req)).toString('utf8')

	if (!raw) return {}

	let value: unknown

	try {
		value = JSON.parse(raw)
	} catch {
		throw new ApiError(400, 'Тело должно быть JSON-объектом.')
	}

	if (!value || typeof value !== 'object' || Array.isArray(value))
		throw new ApiError(400, 'Тело должно быть JSON-объектом.')

	return value as Record<string, unknown>
}

const isString = (x: unknown): x is string => typeof x === 'string'
const isNumber = (x: unknown): x is number =>
	typeof x === 'number' && Number.isFinite(x)

function strings(v: unknown, name: string): string[] | undefined {
	if (v === undefined) return undefined

	if (Array.isArray(v) && v.every(isString)) return v

	throw new Invalid(`${name} должен быть массивом строк.`)
}

function optional<T>(
	v: unknown,
	check: (x: unknown) => x is T,
	name: string,
): T | null | undefined {
	if (v === undefined || v === null) return v

	if (check(v)) return v

	throw new Invalid(`Неверное поле ${name}.`)
}

export function serve(deps: ApiDeps): Server {
	const { db, cards, api, ownerId } = deps
	const expected = Buffer.from(`Bearer ${deps.token}`)
	const step = deps.pollStep ?? 1000

	const authorized = (req: IncomingMessage) => {
		const got = Buffer.from(req.headers.authorization ?? '')

		return got.length === expected.length && timingSafeEqual(got, expected)
	}

	const full = (post: Post) => ({
		...post,
		media: db.media(post.id),
		revisions: db.revisions(post.id),
	})

	/** Запись уже сделана: сбой карточки не должен превращаться в ошибку запроса. */
	async function refresh(id: number): Promise<boolean> {
		try {
			await cards.show(id)

			return true
		} catch (e) {
			console.error('card refresh failed', e)

			return false
		}
	}

	async function scheduleAt(id: number, req: IncomingMessage): Promise<number> {
		const body = await readJson(req)

		if (body.slot === 'next')
			return nextFreeSlot(db.now(), db.get(id).rubric, db.scheduledTimes())

		if (isString(body.at)) {
			if (!OFFSET.test(body.at))
				throw new Invalid(
					'Время нужно с часовым поясом, например 2026-10-24T12:00:00+03:00.',
				)

			if (!Number.isNaN(Date.parse(body.at)))
				return Math.floor(Date.parse(body.at) / 1000)
		}

		throw new Invalid('Нужен at (ISO-время) или slot: "next".')
	}

	async function upload(id: number, req: IncomingMessage): Promise<void> {
		if (!(req.headers['content-type'] ?? '').startsWith('image/'))
			throw new Invalid('Нужен Content-Type image/*.')

		// Заранее: негодный пост не должен получить картинку в личку владельцу.
		const post = db.editable(id)

		checkLimits(post.text, db.media(id).length + 1)
		const bytes = await readBody(req)
		// Bot API отдаёт file_id только у отправленного файла, поэтому картинка уходит
		// владельцу и сразу удаляется: дальше пост ссылается на file_id.
		const msg = await api
			.sendPhoto(ownerId, new InputFile(bytes, 'image'))
			.catch((e: unknown) => {
				if (e instanceof GrammyError) throw new ApiError(502, e.description)

				throw e
			})
		const fileId = msg.photo?.at(-1)?.file_id

		await api.deleteMessage(ownerId, msg.message_id).catch(() => {})

		if (!fileId) throw new ApiError(502, 'Telegram не вернул file_id.')

		db.addMedia(id, fileId)
	}

	async function posts(
		req: IncomingMessage,
		res: ServerResponse,
		url: URL,
		id?: number,
		action?: string,
	) {
		const method = req.method

		if (id === undefined) {
			if (method === 'GET') {
				const status = url.searchParams.get('status')

				return reply(
					res,
					200,
					db.list(status ? (status.split(',') as Status[]) : undefined),
				)
			}

			if (method !== 'POST') throw notFound()

			const body = await readJson(req)

			if (!isRubric(body.rubric)) throw new Invalid('Неизвестная рубрика.')

			if (!isString(body.text)) throw new Invalid('Нужен text.')

			const post = db.create({
				rubric: body.rubric,
				text: body.text,
				voice: optional(body.voice, isNumber, 'voice'),
				projects: strings(body.projects, 'projects'),
				sources: strings(body.sources, 'sources'),
				imagePrompt: optional(body.imagePrompt, isString, 'imagePrompt'),
			})

			return reply(res, 201, {
				...full(post),
				card: await refresh(post.id),
			})
		}

		if (method === 'GET' && !action) return reply(res, 200, full(db.get(id)))

		if (method === 'PATCH' && !action) {
			const body = await readJson(req)

			if (body.rubric !== undefined && !isRubric(body.rubric))
				throw new Invalid('Неизвестная рубрика.')

			if (body.text !== undefined && !isString(body.text))
				throw new Invalid('Неверное поле text.')

			// Все поля проверяем до первой записи: плохой voice не должен оставить сохранённый текст.
			const meta = {
				rubric: body.rubric as Rubric | undefined,
				voice: optional(body.voice, isNumber, 'voice'),
				imagePrompt: optional(body.imagePrompt, isString, 'imagePrompt'),
			}

			if (body.text !== undefined) db.setText(id, body.text)

			db.setMeta(id, meta)
		} else if (method === 'POST' && action === 'revert') {
			db.revert(id)
		} else if (method === 'POST' && action === 'schedule') {
			db.schedule(id, await scheduleAt(id, req))
		} else if (method === 'POST' && action === 'unschedule') {
			db.unschedule(id)
		} else if (method === 'POST' && action === 'media') {
			await upload(id, req)
		} else if (!(method === 'POST' && action === 'preview')) {
			throw notFound()
		}

		const card = await refresh(id)

		return reply(res, 200, { ...full(db.get(id)), card })
	}

	async function inbox(
		req: IncomingMessage,
		res: ServerResponse,
		url: URL,
		segment?: string,
		action?: string,
	) {
		if (req.method === 'GET' && segment === 'next') {
			const wait = Math.min(Number(url.searchParams.get('wait')) || 0, MAX_WAIT)
			const until = Date.now() + wait * 1000

			for (;;) {
				// Клиент ушёл: take() пометил бы запись взятой, а ответ никто не получит.
				if (res.destroyed) return

				const item = db.take()

				if (item || Date.now() >= until) return reply(res, 200, { item })

				await delay(step)
			}
		}

		const id = Number(segment)

		if (req.method === 'POST' && action === 'ack' && Number.isSafeInteger(id)) {
			db.ack(id)

			return reply(res, 200, { ok: true })
		}

		throw notFound()
	}

	async function route(
		req: IncomingMessage,
		res: ServerResponse,
	): Promise<void> {
		const url = new URL(req.url ?? '/', 'http://localhost')

		if (req.method === 'GET' && url.pathname === '/health')
			return reply(res, 200, { ok: true })

		const [prefix, resource, segment, action, ...rest] = url.pathname
			.split('/')
			.filter(Boolean)

		if (prefix !== 'api' || rest.length) throw notFound()

		if (!authorized(req)) throw new ApiError(401, 'Нужен токен.')

		if (resource === 'inbox') return inbox(req, res, url, segment, action)

		if (resource !== 'posts') throw notFound()

		if (segment === undefined) return posts(req, res, url)

		const id = Number(segment)

		if (!Number.isSafeInteger(id)) throw notFound()

		return posts(req, res, url, id, action)
	}

	const server = createServer((req, res) => {
		route(req, res).catch((e) => {
			if (e instanceof ApiError)
				return reply(
					res,
					e.status,
					{ error: e.message },
					e.status === 413 ? { connection: 'close' } : {},
				)

			if (e instanceof Invalid) return reply(res, 400, { error: e.message })

			if (e instanceof NotFound) return reply(res, 404, { error: e.message })

			console.error('api request failed', e)
			reply(res, 500, { error: 'Внутренняя ошибка.' })
		})
	})

	server.listen(deps.port)

	return server
}
