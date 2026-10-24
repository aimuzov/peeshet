// Бот без сети для тестов: каждый вызов Bot API записывается и получает ответ здесь.

import { Bot, GrammyError, HttpError } from 'grammy'
import type { Update, UserFromGetMe } from 'grammy/types'

export type Call = { method: string; payload: Record<string, unknown> }
type Answer = (payload: Record<string, unknown>) => unknown

export const OWNER = 77
export const CHANNEL = '@aimuzov_peeshet'

const ME = {
	id: 1,
	is_bot: true,
	first_name: 'Алёша пишет',
	username: 'aimuzov_peeshet_bot',
	can_join_groups: false,
	can_read_all_group_messages: false,
	supports_inline_queries: false,
	can_connect_to_business: false,
	has_main_web_app: false,
} as UserFromGetMe

/** Ошибка Bot API, чтобы бросить её из ответа. */
export const apiError = (
	method: string,
	code: number,
	description: string,
	parameters = {},
) =>
	new GrammyError(
		`Call to '${method}' failed!`,
		{ ok: false, error_code: code, description, parameters },
		method,
		{},
	)

/** Telegram не ответил вовсе. */
export const networkError = (method: string, code = 'ECONNREFUSED') =>
	new HttpError(
		`Network request for '${method}' failed!`,
		Object.assign(new TypeError('fetch failed'), { cause: { code } }),
	)

const OK_TRUE = new Set([
	'deleteMessage',
	'deleteMessages',
	'answerCallbackQuery',
	'setMyCommands',
	'setMessageReaction',
])

// Правка возвращает то же сообщение: id не меняется.
const EDITS = new Set(['editMessageText', 'editMessageReplyMarkup'])

/**
 * Бот с подменённым транспортом: вызовы Bot API не уходят в сеть, а копятся в `calls`.
 *
 * Ответ из `answer` может быть промисом: так тест придерживает вызов. Метод без своего
 * ответа отвечает сообщением с новым `message_id`, rich-сообщение — с `rich_message`, правки
 * `editMessage*` — тем же сообщением. `fail` роняет следующие вызовы метода заданными
 * ошибками по очереди.
 */
export function fakeBot() {
	const bot = new Bot('1:token', { botInfo: ME })
	const calls: Call[] = []
	const answers = new Map<string, Answer>()
	const failures = new Map<string, Error[]>()
	let messageId = 1000

	const message = (p: Record<string, unknown>) => ({
		message_id: ++messageId,
		date: 0,
		chat: {
			id: p.chat_id,
			type:
				typeof p.chat_id === 'string' && p.chat_id.startsWith('@')
					? 'channel'
					: 'private',
		},
		...(p.rich_message ? { rich_message: p.rich_message } : { text: p.text }),
	})

	bot.api.config.use(async (_prev, method, payload) => {
		const p = (payload ?? {}) as Record<string, unknown>

		calls.push({ method, payload: p })
		const queue = failures.get(method)

		if (queue?.length) throw queue.shift()

		const answer = answers.get(method)
		let result: unknown

		if (answer) result = await answer(p)
		else if (method === 'sendPhoto')
			result = {
				...message(p),
				photo: [
					{
						file_id: (p.photo as string) ?? 'uploaded',
						file_unique_id: 'u',
						width: 1,
						height: 1,
					},
				],
				caption: p.caption,
			}
		else if (OK_TRUE.has(method)) result = true
		else if (EDITS.has(method))
			result = {
				...message(p),
				message_id: p.message_id,
				edit_date: 1,
				chat: { id: p.chat_id, type: 'private' },
			}
		else result = message(p)

		return { ok: true, result } as never
	})

	return {
		bot,
		api: bot.api,
		calls,
		named: (method: string) =>
			calls.filter((c) => c.method === method).map((c) => c.payload),
		answer: (method: string, fn: Answer) => answers.set(method, fn),
		fail: (method: string, ...errors: Error[]) =>
			failures.set(method, [...(failures.get(method) ?? []), ...errors]),
		feed: (update: object) =>
			bot.handleUpdate({ update_id: ++messageId, ...update } as Update),
	}
}

let nextId = 1

/** Апдейт с текстом от `from` (по умолчанию владелец). */
export const text = (
	body: string,
	opts: { from?: number; replyTo?: number } = {},
) => {
	const from = opts.from ?? OWNER
	const command = body.startsWith('/')
		? [{ type: 'bot_command', offset: 0, length: body.split(' ')[0].length }]
		: undefined

	return {
		message: {
			message_id: nextId++,
			date: 0,
			chat: { id: from, type: 'private' },
			from: { id: from, is_bot: false, first_name: 'A' },
			text: body,
			...(command ? { entities: command } : {}),
			...(opts.replyTo
				? {
						reply_to_message: {
							message_id: opts.replyTo,
							date: 0,
							chat: { id: OWNER, type: 'private' },
						},
					}
				: {}),
		},
	}
}

/** Нажатие инлайн-кнопки. */
export const press = (
	data: string,
	opts: { from?: number; msgId?: number } = {},
) => ({
	callback_query: {
		id: String(nextId++),
		from: { id: opts.from ?? OWNER, is_bot: false, first_name: 'A' },
		chat_instance: '1',
		data,
		message: {
			message_id: opts.msgId ?? 1,
			date: 0,
			chat: { id: OWNER, type: 'private' },
			text: 'card',
		},
	},
})

/** Фото от владельца, по умолчанию ответом на сообщение `replyTo`. */
export const photo = (
	fileId: string,
	opts: { replyTo?: number; caption?: string } = {},
) => ({
	message: {
		message_id: nextId++,
		date: 0,
		chat: { id: OWNER, type: 'private' },
		from: { id: OWNER, is_bot: false, first_name: 'A' },
		photo: [
			{
				file_id: `${fileId}-small`,
				file_unique_id: 's',
				width: 90,
				height: 90,
			},
			{ file_id: fileId, file_unique_id: 'b', width: 1280, height: 1280 },
		],
		...(opts.caption ? { caption: opts.caption } : {}),
		...(opts.replyTo
			? {
					reply_to_message: {
						message_id: opts.replyTo,
						date: 0,
						chat: { id: OWNER, type: 'private' },
					},
				}
			: {}),
	},
})

/** Telegram так отвечает на правку, которая ничего не меняет. */
export const notModified = (method: string) =>
	apiError(
		method,
		400,
		'Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message',
	)
