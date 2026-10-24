// Карточка поста в личке владельца: одно rich-сообщение ровно как пост в канале и кнопки,
// строка статуса — верхняя кнопка.
// Данные кнопок: `<действие>:<id поста>[:<аргумент>]`, разбирает их bot.ts.

import { GrammyError, InlineKeyboard, type Api } from 'grammy'
import type { InlineKeyboardButton, InputRichMessage } from 'grammy/types'

import { STATUS_RU, type Db, type ExtraKind, type NewPost } from '#src/db.ts'
import { Invalid, type Post } from '#src/post.ts'
import { richMessage, send } from '#src/send.ts'
import { formatMsk, todayAt } from '#src/time.ts'

export type CardsConfig = { ownerId: number; channelId: string }

/** Ссылка на пост в канале; у канала без username её нет. */
export const channelLink = (channelId: string, msgId: number) =>
	channelId.startsWith('@')
		? `https://t.me/${channelId.slice(1)}/${msgId}`
		: null

const STATUS_LIMIT = 64
const SEP = ' · '

export function statusLine(post: Post): string {
	const when =
		post.status === 'scheduled' && post.publishAt
			? ` на ${formatMsk(post.publishAt)}`
			: ''
	const head = [
		`#${post.rubric}`,
		`${STATUS_RU[post.status]}${when}`,
		`голос ${post.voice ?? '—'}`,
	].join(' · ')
	const projects = [...post.projects.join(', ')]
	// Строка живёт в кнопке: длинный список проектов обрезаем, остальное важнее.
	const room = STATUS_LIMIT - head.length - SEP.length

	if (!projects.length || room < 2) return head

	const fit =
		projects.length > room
			? `${projects.slice(0, room - 1).join('')}…`
			: projects.join('')

	return head + SEP + fit
}

type Button = InlineKeyboardButton

function actions(post: Post, channelId: string): Button[] {
	const id = post.id
	const text = InlineKeyboard.text

	switch (post.status) {
		case 'draft':
			return [
				text('Дата', `d:${id}`),
				text('Править', `e:${id}`),
				text('Обложка', `c:${id}`),
				text('Удалить', `x:${id}`),
			]

		case 'scheduled':
			return [
				text('Перенести', `d:${id}`),
				text('Снять', `u:${id}`),
				text('Править', `e:${id}`),
				text('Удалить', `x:${id}`),
			]

		case 'failed':
			return [text('Повторить', `s:${id}:now`), text('Перенести', `d:${id}`)]

		case 'published': {
			const url = post.channelMsgId
				? channelLink(channelId, post.channelMsgId)
				: null

			return url ? [InlineKeyboard.url('Открыть в канале', url)] : []
		}

		default:
			return []
	}
}

/** Кнопки карточки: сверху статус, нажатие на него ничего не делает, ниже действия. */
export function keyboard(post: Post, channelId: string): InlineKeyboard {
	const rows = [
		[InlineKeyboard.text(statusLine(post), `n:${post.id}`)],
		actions(post, channelId),
	]

	return new InlineKeyboard(rows.filter((r) => r.length))
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

const is400 = (e: unknown, text = ''): e is GrammyError =>
	e instanceof GrammyError &&
	e.error_code === 400 &&
	e.description.includes(text)

/** Правка без изменений: Telegram отвечает 400, но карточка и так верная. */
export const notModified = (e: unknown) => is400(e, 'message is not modified')

/**
 * Telegram не принял содержимое поста. Правка карточки на любой 400 откатывается к отправке
 * новой, поэтому 400 на саму отправку — это уже разметка, а не старое или удалённое сообщение.
 */
const rejected = (e: unknown): e is GrammyError =>
	is400(e) && e.method === 'sendRichMessage'

/**
 * Карточка поста в личке владельца — одно rich-сообщение, которое правится на месте, сверху
 * клавиатуры строка статуса.
 */
export class Cards {
	readonly #api: Api
	readonly #db: Db
	readonly #cfg: CardsConfig
	readonly #queue = new Map<number, Promise<unknown>>()

	constructor(api: Api, db: Db, cfg: CardsConfig) {
		this.#api = api
		this.#db = db
		this.#cfg = cfg
	}

	/** Перерисовывает карточку на месте; новую присылает, только если старую не поправить. */
	show(id: number): Promise<void> {
		return this.#serial(id, () => this.#show(id))
	}

	/**
	 * Меняет текст поста и показывает его в карточке. Разметку проверяет Telegram: если он
	 * не принял новый текст, правка откатывается, а наружу уходит {@link Invalid} с его
	 * причиной. `change` получает текст уже в очереди поста, поэтому дописывания по очереди
	 * не теряют друг друга. `false` — текст сохранён, а карточку обновить не вышло.
	 */
	revise(id: number, change: (text: string) => string): Promise<boolean> {
		return this.#serial(id, async () => {
			this.#db.setText(id, change(this.#db.get(id).text))
			const [revision] = this.#db.revisions(id)

			return this.#validated(id, () => this.#db.undoText(id, revision.id))
		})
	}

	/** Заводит пост и показывает его карточку; пост с негодной разметкой сразу удаляется. */
	async create(p: NewPost): Promise<{ post: Post; card: boolean }> {
		const post = this.#db.create(p)
		const card = await this.#serial(post.id, () =>
			this.#validated(post.id, () => this.#db.remove(post.id)),
		)

		return { post, card }
	}

	/**
	 * Пост не вышел: карточка показывает это сама, а причина приходит отдельным ответом
	 * на неё, чтобы владелец получил уведомление.
	 */
	failure(id: number): Promise<void> {
		return this.#serial(id, async () => {
			await this.#show(id).catch((e: unknown) =>
				console.error('failure card failed', e),
			)

			// Прежнее уведомление заменяем новым.
			await this.#clean(id, 'error')
			const { error } = this.#db.get(id)
			const msg = await this.#api.sendMessage(
				this.#cfg.ownerId,
				`Не вышел: ${error ?? 'причина неизвестна'}`,
				this.#replyTo(id),
			)

			this.#db.addExtra(id, msg.message_id, 'error')
		})
	}

	/** Убирает карточку, например у удалённого поста. */
	hide(id: number): Promise<void> {
		return this.#serial(id, async () => {
			const card = this.#db.card(id)
			const extras = this.#db.extras(id)
			const ids = [...(card ? [card.msgId] : []), ...extras]

			this.#db.dropCard(id)

			if (ids.length && (await this.#delete(ids))) this.#db.dropExtras(extras)
		})
	}

	/**
	 * Показы одного поста идут по очереди: параллельные апдейты иначе пришлют несколько
	 * карточек, а в базе останется одна. Пост читается уже в своей очереди, а не при вызове.
	 */
	#serial<T>(id: number, step: () => Promise<T>): Promise<T> {
		const run = (this.#queue.get(id) ?? Promise.resolve()).then(step, step)
		const tail = run.catch(() => {})

		this.#queue.set(id, tail)

		void tail.then(() => {
			if (this.#queue.get(id) === tail) this.#queue.delete(id)
		})

		return run
	}

	/** Показывает карточку после записи; если Telegram не принял разметку, `undo` её отменяет. */
	async #validated(id: number, undo: () => void): Promise<boolean> {
		try {
			await this.#show(id)

			return true
		} catch (e) {
			if (!rejected(e)) {
				console.error('card refresh failed', e)

				return false
			}

			undo()

			throw new Invalid(`Telegram не принял разметку: ${e.description}`)
		}
	}

	async #show(id: number): Promise<void> {
		const post = this.#db.get(id)
		const media = this.#db.media(id)
		const reply_markup = keyboard(post, this.#cfg.channelId)
		const card = this.#db.card(id)

		if (
			!card ||
			!(await this.#edit(
				card.msgId,
				richMessage(post.text, media),
				reply_markup,
			))
		) {
			const msgId = await send(this.#api, this.#cfg.ownerId, post.text, media, {
				reply_markup,
			})
			const old = this.#db.setCard(id, msgId)

			if (old !== null && old !== msgId) await this.#delete([old])
		}

		// Пока пост не вышел, причина нужна владельцу и после перерисовки.
		if (post.status !== 'failed') await this.#clean(id, 'error')
	}

	/** Удаляет сообщения вокруг карточки; забывает их, только когда в чате их уже нет. */
	async #clean(id: number, kind?: ExtraKind): Promise<void> {
		const ids = this.#db.extras(id, kind)

		if (ids.length && (await this.#delete(ids))) this.#db.dropExtras(ids)
	}

	#replyTo(id: number) {
		const card = this.#db.card(id)

		return card
			? {
					reply_parameters: {
						message_id: card.msgId,
						allow_sending_without_reply: true,
					},
				}
			: {}
	}

	/** `false`, если сообщение уже не поправить: старое, удалённое и прочие 400. */
	async #edit(
		msgId: number,
		rich: InputRichMessage,
		reply_markup: InlineKeyboard,
	): Promise<boolean> {
		const owner = this.#cfg.ownerId

		try {
			await this.#api.editMessageText(owner, msgId, rich, { reply_markup })

			return true
		} catch (e) {
			if (!is400(e)) throw e

			if (!notModified(e)) return false
		}

		// Содержимое то же: на случай, если Telegram не сравнил кнопки, обновляем их отдельно.
		try {
			await this.#api.editMessageReplyMarkup(owner, msgId, {
				reply_markup,
			})
		} catch (e) {
			if (!notModified(e)) throw e
		}

		return true
	}

	/** `true`, если сообщений в чате больше нет или их уже не удалить. */
	async #delete(msgIds: number[]): Promise<boolean> {
		try {
			await this.#api.deleteMessages(this.#cfg.ownerId, msgIds)

			return true
		} catch (e) {
			// 400: старше 48 часов или уже удалено, это не повод ронять показ.
			if (is400(e)) return true

			console.error('card cleanup failed', e)

			return false
		}
	}
}
