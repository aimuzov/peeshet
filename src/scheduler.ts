// Публикация по дате. Пост сперва забирается в `publishing`, и только потом уходит в канал:
// если процесс упадёт посреди отправки, после рестарта пост не уйдёт второй раз.

import { setTimeout as delay } from 'node:timers/promises'
import { InlineKeyboard, type Api } from 'grammy'

import type { Cards, CardsConfig } from '#src/cards.ts'
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

const log = (what: string) => (e: unknown) => console.error(what, e)

export class Scheduler {
	readonly #api: Api
	readonly #db: Db
	readonly #cards: Cards
	readonly #cfg: CardsConfig
	readonly #sleep: (ms: number) => Promise<void>
	readonly #tickMs: number
	#nudged = false

	constructor(
		api: Api,
		db: Db,
		cards: Cards,
		cfg: CardsConfig,
		sleep = (ms: number) => delay(ms),
		tickMs = TICK,
	) {
		this.#api = api
		this.#db = db
		this.#cards = cards
		this.#cfg = cfg
		this.#sleep = sleep
		this.#tickMs = tickMs
	}

	/** Разбор после рестарта, до первого тика. */
	async recover(): Promise<void> {
		for (const id of this.#db.recoverPublishing())
			await this.#cards.failure(id).catch(log('recover card failed'))

		const overdue = this.#db.unscheduleOverdue(GRACE)

		if (!overdue.length) return

		const kb = new InlineKeyboard()

		for (const post of overdue)
			kb.text(`Сейчас: ${title(post)}`, `s:${post.id}:now`)
				.text('Открыть', `o:${post.id}`)
				.row()

		await this.#notify(
			'Сервер не работал, и эти посты не вышли вовремя. Они вернулись в черновики.',
			{ reply_markup: kb },
		).catch(log('recover notice failed'))
	}

	/** Сообщение владельцу; сетевые сбои повторяются так же, как при публикации. */
	#notify(
		text: string,
		other?: Parameters<Api['sendMessage']>[2],
	): Promise<unknown> {
		return retry(
			() => this.#api.sendMessage(this.#cfg.ownerId, text, other),
			this.#sleep,
		)
	}

	async tick(): Promise<void> {
		for (const post of this.#db.due()) await this.#publish(post)

		await this.#nudge()
	}

	async run(signal: AbortSignal): Promise<void> {
		while (!signal.aborted) {
			try {
				await this.tick()
			} catch (e) {
				console.error('tick failed', e)
			}

			await delay(this.#tickMs, undefined, { signal }).catch(() => {})
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
			await this.#cards.failure(post.id).catch(log('failure card failed'))

			return null
		})

		if (!ids) return

		this.#db.published(post.id, ids[0])

		// Пост уже вышел: сбой карточки состояние не меняет.
		// Карточку повторяем при 429 и обрыве: иначе она застрянет в «публикуется».
		await retry(() => this.#cards.show(post.id), this.#sleep).catch(
			log('published card failed'),
		)
	}

	async #nudge(): Promise<void> {
		if (!this.#db.untaken(0).length) {
			this.#nudged = false

			return
		}

		if (this.#nudged || !this.#db.untaken(INBOX_IDLE).length) return

		// Флаг до отправки: пересёкшиеся тики не пришлют два напоминания.
		this.#nudged = true

		try {
			await this.#notify(
				'Сессия на маке не запущена, займусь, когда запустишь.',
			)
		} catch (e) {
			// Сбросили флаг: следующий тик попробует снова.
			this.#nudged = false
			console.error('nudge failed', e)
		}
	}
}
