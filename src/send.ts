// Одна функция отправки и для предпросмотра, и для канала: так карточка совпадает с постом.

import { setTimeout as delay } from 'node:timers/promises'
import { GrammyError, HttpError, InputMediaBuilder, type Api } from 'grammy'
import type { InputRichMessage } from 'grammy/types'

import type { Media } from '#src/db.ts'
import { photoKeys } from '#src/post.ts'

const ATTEMPTS = 4 // первая попытка и три повтора
const PAUSE = 5000

/** Rich-сообщение поста: из фото берём только те, что стоят в тексте. */
export function richMessage(text: string, media: Media[]): InputRichMessage {
	const fileIds = new Map(media.map((m) => [m.key, m.fileId]))
	const used = photoKeys(text).flatMap((key) => {
		const fileId = fileIds.get(key)

		return fileId ? [{ id: key, media: InputMediaBuilder.photo(fileId) }] : []
	})

	return used.length ? { markdown: text, media: used } : { markdown: text }
}

type Other = Parameters<Api['sendRichMessage']>[2]

/** Отправляет пост одним rich-сообщением и возвращает его id. */
export async function send(
	api: Api,
	chatId: number | string,
	text: string,
	media: Media[],
	other?: Other,
): Promise<number> {
	const msg = await api.sendRichMessage(chatId, richMessage(text, media), other)

	return msg.message_id
}

const NOT_SENT = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'])
const MAX_WAIT = 60 // секунд; дольше ждать не стоит, лучше показать ошибку

/** Запрос заведомо не ушёл: соединение не установилось. */
function neverLeft(e: HttpError): boolean {
	for (
		let err: unknown = e.error;
		err && typeof err === 'object';
		err = (err as { cause?: unknown }).cause
	) {
		const code = (err as { code?: unknown }).code

		if (typeof code === 'string' && NOT_SENT.has(code)) return true
	}

	return false
}

/**
 * Повторяет `fn` при 429 и когда запрос заведомо не дошёл до Telegram.
 * Остальные сетевые ошибки не повторяются: пост мог выйти, а дубль хуже пропуска.
 */
export async function retry<T>(
	fn: () => Promise<T>,
	sleep = (ms: number) => delay(ms),
): Promise<T> {
	for (let attempt = 1; ; attempt++) {
		try {
			return await fn()
		} catch (e) {
			const tooMany = e instanceof GrammyError && e.error_code === 429
			const unsent = e instanceof HttpError && neverLeft(e)

			if ((!tooMany && !unsent) || attempt === ATTEMPTS) throw e

			const after = tooMany ? e.parameters.retry_after : undefined

			if (after && after > MAX_WAIT) throw e

			await sleep(after ? after * 1000 : PAUSE)
		}
	}
}

/** Причина ошибки для владельца. */
export const reason = (e: unknown) =>
	e instanceof HttpError
		? 'Связь с Telegram оборвалась, проверь канал: пост мог выйти.'
		: e instanceof GrammyError
			? e.description
			: e instanceof Error
				? e.message
				: String(e)
