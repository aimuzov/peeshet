// Карточка поста в личке владельца: сам пост ровно как в канале и строка статуса с кнопками.
// Данные кнопок: `<действие>:<id поста>[:<аргумент>]`, разбирает их bot.ts.

import { GrammyError, InlineKeyboard, type Api } from 'grammy'

import { STATUS_RU, type Db } from '#src/db.ts'
import type { Post } from '#src/post.ts'
import { send } from '#src/send.ts'
import { formatMsk, todayAt } from '#src/time.ts'

export type CardsConfig = { ownerId: number; channelId: string }

/** Ссылка на пост в канале; у канала без username её нет. */
export const channelLink = (channelId: string, msgId: number) =>
	channelId.startsWith('@')
		? `https://t.me/${channelId.slice(1)}/${msgId}`
		: null

export function statusLine(post: Post): string {
	const when =
		post.status === 'scheduled' && post.publishAt
			? ` на ${formatMsk(post.publishAt)}`
			: ''
	const parts = [
		`#${post.rubric}`,
		`${STATUS_RU[post.status]}${when}`,
		`голос ${post.voice ?? '—'}`,
	]

	if (post.projects.length) parts.push(post.projects.join(', '))

	const line = parts.join(' · ')

	return post.error ? `${line}\n${post.error}` : line
}

export function keyboard(post: Post, channelId: string): InlineKeyboard {
	const id = post.id
	const kb = new InlineKeyboard()

	switch (post.status) {
		case 'draft':
			return kb
				.text('Дата', `d:${id}`)
				.text('Править', `e:${id}`)
				.text('Обложка', `c:${id}`)
				.text('Удалить', `x:${id}`)

		case 'scheduled':
			return kb
				.text('Перенести', `d:${id}`)
				.text('Снять', `u:${id}`)
				.text('Править', `e:${id}`)
				.text('Удалить', `x:${id}`)

		case 'failed':
			return kb.text('Повторить', `s:${id}:now`).text('Перенести', `d:${id}`)

		case 'published': {
			const url = post.channelMsgId
				? channelLink(channelId, post.channelMsgId)
				: null

			return url ? kb.url('Открыть в канале', url) : kb
		}

		default:
			return kb
	}
}

export function dateMenu(id: number, now: number): InlineKeyboard {
	const kb = new InlineKeyboard().text('Сейчас', `s:${id}:now`)

	if (todayAt(now, 19) > now) kb.text('Сегодня 19:00', `s:${id}:today`)

	return kb
		.text('Завтра 10:00', `s:${id}:tomorrow`)
		.row()
		.text('Ближайшее свободное', `s:${id}:next`)
		.text('Своё время', `s:${id}:custom`)
		.row()
		.text('Назад', `o:${id}`)
}

export const deleteMenu = (id: number) =>
	new InlineKeyboard().text('Да, удалить', `xx:${id}`).text('Нет', `o:${id}`)

export class Cards {
	readonly #api: Api
	readonly #db: Db
	readonly #cfg: CardsConfig

	constructor(api: Api, db: Db, cfg: CardsConfig) {
		this.#api = api
		this.#db = db
		this.#cfg = cfg
	}

	/** Присылает свежую карточку поста и убирает прежнюю. */
	async show(id: number): Promise<void> {
		const post = this.#db.get(id)
		const ids = await send(
			this.#api,
			this.#cfg.ownerId,
			post.text,
			this.#db.media(id),
		)
		const status = await this.#api
			.sendMessage(this.#cfg.ownerId, statusLine(post), {
				reply_markup: keyboard(post, this.#cfg.channelId),
			})
			.catch(async (e: unknown) => {
				// Без статуса у поста нет кнопок: убираем осиротевшие сообщения, прежняя карточка остаётся.
				await this.#api.deleteMessages(this.#cfg.ownerId, ids).catch(() => {})

				throw e
			})

		await this.#delete(this.#db.setPreview(id, [...ids, status.message_id]))
	}

	/** Убирает карточку, например у удалённого или вышедшего поста. */
	async hide(id: number): Promise<void> {
		await this.#delete(this.#db.setPreview(id, []))
	}

	async #delete(msgIds: number[]): Promise<void> {
		if (!msgIds.length) return

		try {
			await this.#api.deleteMessages(this.#cfg.ownerId, msgIds)
		} catch (e) {
			// 400: старше 48 часов или уже удалено, это не повод ронять показ.
			if (!(e instanceof GrammyError && e.error_code === 400))
				console.error('card cleanup failed', e)
		}
	}
}
