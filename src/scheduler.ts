// Публикация по дате. Пост сперва забирается в `publishing`, и только потом уходит в канал:
// если процесс упадёт посреди отправки, после рестарта пост не уйдёт второй раз.

import { setTimeout as delay } from 'node:timers/promises'
import { InlineKeyboard, type Api } from 'grammy'

import type { Cards, CardsConfig } from '#src/cards.ts'
import type { Db } from '#src/db.ts'
import type { Post } from '#src/post.ts'
import { reason, retry, send } from '#src/send.ts'
import { report } from '#src/sentry.ts'

const TICK = 30_000
// Опоздание до 5 минут ещё считается вовремя, больше — решает владелец.
const GRACE = 300

const TITLE = 24

/** Строка текста без Markdown: картинки уходят, от ссылок остаётся текст. */
const plain = (line: string) =>
	line
		.replace(/!\[[^\]]*\]\([^)]*\)/g, '')
		.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
		.replace(/^\s*(#+|>)\s*/, '')
		.replace(/[*_`~]/g, '')
		.trim()

/** Начало текста поста для кнопки: первая непустая строка без разметки. */
function title(post: Post): string {
	const line = [...(post.text.split('\n').map(plain).find(Boolean) ?? '')]

	return line.length > TITLE
		? `${line.slice(0, TITLE).join('')}…`
		: line.join('')
}

const log = (what: string) => (e: unknown) => console.error(what, e)

export class Scheduler {
	readonly #api: Api
	readonly #db: Db
	readonly #cards: Cards
	readonly #cfg: CardsConfig
	readonly #sleep: (ms: number) => Promise<void>
	readonly #tickMs: number
	readonly #monitor: (tick: () => Promise<void>) => Promise<void>

	constructor(
		api: Api,
		db: Db,
		cards: Cards,
		cfg: CardsConfig,
		sleep = (ms: number) => delay(ms),
		tickMs = TICK,
		monitor = (tick: () => Promise<void>) => tick(),
	) {
		this.#api = api
		this.#db = db
		this.#cards = cards
		this.#cfg = cfg
		this.#sleep = sleep
		this.#tickMs = tickMs
		this.#monitor = monitor
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
	}

	async run(signal: AbortSignal): Promise<void> {
		while (!signal.aborted) {
			try {
				await this.#monitor(() => this.tick())
			} catch (e) {
				report('tick failed', e)
			}

			await delay(this.#tickMs, undefined, { signal }).catch(() => {})
		}
	}

	async #publish(snapshot: Post): Promise<void> {
		const id = snapshot.id
		// В очереди поста: правка, которую сейчас проверяет Telegram, сперва примется или
		// откатится, и в канал уйдёт уже её итог.
		const outcome = await this.#cards.exclusive(id, async () => {
			// Пока шли предыдущие посты, этот могли поправить или перенести: публикуем свежую версию.
			const post = this.#db.claim(id)

			if (!post) return 'skipped'

			const media = this.#db.media(id)

			// Ловим только ошибки отправки: если упадёт уведомление после неё, пост уже вышел,
			// и переводить его в failed нельзя.
			try {
				const msgId = await retry(
					() => send(this.#api, this.#cfg.channelId, post.text, media),
					this.#sleep,
				)

				this.#db.published(id, msgId)

				return 'published'
			} catch (e) {
				this.#db.failed(id, reason(e))

				return 'failed'
			}
		})

		// Карточки рисуются в той же очереди, поэтому уже после неё.
		if (outcome === 'failed')
			await this.#cards.failure(id).catch(log('failure card failed'))

		if (outcome !== 'published') return

		// Пост уже вышел: сбой карточки состояние не меняет.
		// Карточку повторяем при 429 и обрыве: иначе она застрянет в «публикуется».
		await retry(() => this.#cards.show(id), this.#sleep).catch(
			log('published card failed'),
		)
	}
}
