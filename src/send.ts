// Одна функция отправки и для предпросмотра, и для канала: так карточка совпадает с постом.

import { setTimeout as delay } from 'node:timers/promises'
import { GrammyError, HttpError, InputMediaBuilder, type Api } from 'grammy'

const ATTEMPTS = 4 // первая попытка и три повтора
const PAUSE = 5000

/** Отправляет пост и возвращает id всех его сообщений по порядку. */
export async function send(
	api: Api,
	chatId: number | string,
	text: string,
	media: string[],
): Promise<number[]> {
	if (media.length === 0)
		return [(await api.sendMessage(chatId, text)).message_id]

	if (media.length === 1)
		return [
			(await api.sendPhoto(chatId, media[0], { caption: text })).message_id,
		]

	const album = media.map((fileId, i) =>
		InputMediaBuilder.photo(fileId, i === 0 ? { caption: text } : {}),
	)

	return (await api.sendMediaGroup(chatId, album)).map((m) => m.message_id)
}

/** Повторяет `fn` при сетевой ошибке и 429; остальные ошибки Bot API пробрасывает сразу. */
export async function retry<T>(
	fn: () => Promise<T>,
	sleep = (ms: number) => delay(ms),
): Promise<T> {
	for (let attempt = 1; ; attempt++) {
		try {
			return await fn()
		} catch (e) {
			const tooMany = e instanceof GrammyError && e.error_code === 429
			const network = e instanceof HttpError

			if ((!tooMany && !network) || attempt === ATTEMPTS) throw e

			const after = tooMany ? e.parameters.retry_after : undefined

			await sleep(after ? after * 1000 : PAUSE)
		}
	}
}

/** Причина ошибки для владельца. */
export const reason = (e: unknown) =>
	e instanceof GrammyError
		? e.description
		: e instanceof Error
			? e.message
			: String(e)
