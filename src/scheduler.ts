// Публикация по дате. Пост сперва забирается в `publishing`, и только потом уходит в канал:
// если процесс упадёт посреди отправки, после рестарта пост не уйдёт второй раз.

import { setTimeout as delay } from 'node:timers/promises'
import { InlineKeyboard, type Api } from 'grammy'

import { channelLink, type Cards, type CardsConfig } from '#src/cards.ts'
import type { Db } from '#src/db.ts'
import type { Post } from '#src/post.ts'
import { reason, retry, send } from '#src/send.ts'

const TICK = 30_000
// Опоздание до 5 минут ещё считается вовремя, больше — решает владелец.
const GRACE = 300
// Через сколько секунд невзятое входящее значит, что сессия на маке не запущена.
const INBOX_IDLE = 120

/** Начало текста поста для кнопки. */
const title = (post: Post) =>
	post.text.length > 24 ? `${post.text.slice(0, 24)}…` : post.text

export class Scheduler {
	readonly #api: Api
	readonly #db: Db
	readonly #cards: Cards
	readonly #cfg: CardsConfig
	readonly #sleep: (ms: number) => Promise<void>
	#nudged = false

	constructor(
		api: Api,
		db: Db,
		cards: Cards,
		cfg: CardsConfig,
		sleep = (ms: number) => delay(ms),
	) {
		this.#api = api
		this.#db = db
		this.#cards = cards
		this.#cfg = cfg
		this.#sleep = sleep
	}

	/** Разбор после рестарта, до первого тика. */
	async recover(): Promise<void> {
		for (const id of this.#db.recoverPublishing()) await this.#cards.show(id)

		const overdue = this.#db.unscheduleOverdue(GRACE)

		if (!overdue.length) return

		const kb = new InlineKeyboard()

		for (const post of overdue)
			kb.text(`Сейчас: ${title(post)}`, `s:${post.id}:now`)
				.text('Дата', `d:${post.id}`)
				.row()

		await this.#api.sendMessage(
			this.#cfg.ownerId,
			'Сервер не работал, и эти посты не вышли вовремя. Они вернулись в черновики.',
			{ reply_markup: kb },
		)
	}

	async tick(): Promise<void> {
		for (const post of this.#db.due()) await this.#publish(post)

		await this.#nudge()
	}

	async run(signal: AbortSignal): Promise<void> {
		while (!signal.aborted) {
			await this.tick()
			await delay(TICK, undefined, { signal }).catch(() => {})
		}
	}

	async #publish(snapshot: Post): Promise<void> {
		// Пока шли предыдущие посты, этот могли поправить или перенести: публикуем свежую версию.
		const post = this.#db.claim(snapshot.id)

		if (!post) return

		const media = this.#db.media(post.id)
		// Ловим только ошибки отправки: если упадёт уведомление после неё, пост уже вышел,
		// и переводить его в failed нельзя.
		const ids = await retry(
			() => send(this.#api, this.#cfg.channelId, post.text, media),
			this.#sleep,
		).catch(async (e: unknown) => {
			this.#db.failed(post.id, reason(e))
			await this.#cards.show(post.id)

			return null
		})

		if (!ids) return

		this.#db.published(post.id, ids[0])
		const url = channelLink(this.#cfg.channelId, ids[0])

		await this.#api.sendMessage(
			this.#cfg.ownerId,
			url ? `Вышло: ${url}` : 'Вышло.',
		)

		await this.#cards.hide(post.id)
	}

	async #nudge(): Promise<void> {
		if (!this.#db.untaken(0).length) {
			this.#nudged = false

			return
		}

		if (this.#nudged || !this.#db.untaken(INBOX_IDLE).length) return

		this.#nudged = true

		await this.#api.sendMessage(
			this.#cfg.ownerId,
			'Сессия на маке не запущена, займусь, когда запустишь.',
		)
	}
}
