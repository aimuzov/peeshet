// Карточка поста в личке владельца: одно сообщение с постом и кнопками, строка статуса — верхняя кнопка.
// Данные кнопок: `<действие>:<id поста>[:<аргумент>]`, разбирает их bot.ts.

import {
	GrammyError,
	InlineKeyboard,
	InputMediaBuilder,
	type Api,
} from 'grammy'
import type { InlineKeyboardButton } from 'grammy/types'

import { STATUS_RU, type Card, type CardKind, type Db } from '#src/db.ts'
import type { Post } from '#src/post.ts'
import { formatMsk, todayAt } from '#src/time.ts'

export type CardsConfig = { ownerId: number; channelId: string }

/** Ссылка на пост в канале; у канала без username её нет. */
export const channelLink = (channelId: string, msgId: number) =>
	channelId.startsWith('@')
		? `https://t.me/${channelId.slice(1)}/${msgId}`
		: null

export function statusLine(post: Post, media = 0): string {
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

	if (media > 1) parts.push(`альбом, ${media} фото`)

	return parts.join(' · ')
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
export function keyboard(
	post: Post,
	channelId: string,
	media = 0,
): InlineKeyboard {
	const rows = [
		[InlineKeyboard.text(statusLine(post, media), `n:${post.id}`)],
		actions(post, channelId),
		media > 1 ? [InlineKeyboard.text('Альбом', `a:${post.id}`)] : [],
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
 * Карточка поста в личке владельца — одно сообщение, которое правится на месте: текст
 * поста или первое фото с подписью, сверху клавиатуры строка статуса.
 */
export class Cards {
	readonly #api: Api
	readonly #db: Db
	readonly #cfg: CardsConfig

	constructor(api: Api, db: Db, cfg: CardsConfig) {
		this.#api = api
		this.#db = db
		this.#cfg = cfg
	}

	/** Перерисовывает карточку на месте; новую присылает, только если старую не поправить. */
	async show(id: number): Promise<void> {
		const post = this.#db.get(id)
		const media = this.#db.media(id)
		const kind: CardKind = media.length ? 'photo' : 'text'
		const reply_markup = keyboard(post, this.#cfg.channelId, media.length)
		const card = this.#db.card(id)

		if (
			!card ||
			card.kind !== kind ||
			!(await this.#edit(card, post.text, media, reply_markup))
		) {
			const owner = this.#cfg.ownerId
			const msg = media.length
				? await this.#api.sendPhoto(owner, media[0], {
						caption: post.text,
						reply_markup,
					})
				: await this.#api.sendMessage(owner, post.text, { reply_markup })

			this.#db.setCard(id, msg.message_id, kind)

			if (card) await this.#delete([card.msgId])
		}

		await this.#delete(this.#db.takeExtras(id))
	}

	/** Карточка показывает только первое фото, а весь альбом присылаем по кнопке. */
	async album(id: number): Promise<void> {
		const post = this.#db.get(id)
		const media = this.#db.media(id)

		if (media.length < 2) return

		await this.#delete(this.#db.takeExtras(id, 'album'))
		const msgs = await this.#api.sendMediaGroup(
			this.#cfg.ownerId,
			media.map((fileId, i) =>
				InputMediaBuilder.photo(fileId, i === 0 ? { caption: post.text } : {}),
			),
			this.#replyTo(id),
		)

		for (const m of msgs) this.#db.addExtra(id, m.message_id, 'album')
	}

	/**
	 * Пост не вышел: карточка показывает это сама, а причина приходит отдельным ответом
	 * на неё, чтобы владелец получил уведомление.
	 */
	async failure(id: number): Promise<void> {
		await this.show(id).catch((e: unknown) =>
			console.error('failure card failed', e),
		)

		const { error } = this.#db.get(id)
		const msg = await this.#api.sendMessage(
			this.#cfg.ownerId,
			`Не вышел: ${error ?? 'причина неизвестна'}`,
			this.#replyTo(id),
		)

		this.#db.addExtra(id, msg.message_id, 'error')
	}

	/** Убирает карточку, например у удалённого поста. */
	async hide(id: number): Promise<void> {
		const card = this.#db.card(id)

		this.#db.dropCard(id)

		await this.#delete([
			...(card ? [card.msgId] : []),
			...this.#db.takeExtras(id),
		])
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
		card: Card,
		text: string,
		media: string[],
		reply_markup: InlineKeyboard,
	): Promise<boolean> {
		const owner = this.#cfg.ownerId

		try {
			if (card.kind === 'text')
				await this.#api.editMessageText(owner, card.msgId, text, {
					reply_markup,
				})
			else
				await this.#api.editMessageMedia(
					owner,
					card.msgId,
					InputMediaBuilder.photo(media[0], { caption: text }),
					{ reply_markup },
				)

			return true
		} catch (e) {
			if (!is400(e)) throw e

			if (!notModified(e)) return false
		}

		// Содержимое то же: на случай, если Telegram не сравнил кнопки, обновляем их отдельно.
		try {
			await this.#api.editMessageReplyMarkup(owner, card.msgId, {
				reply_markup,
			})
		} catch (e) {
			if (!notModified(e)) throw e
		}

		return true
	}

	async #delete(msgIds: number[]): Promise<void> {
		if (!msgIds.length) return

		try {
			await this.#api.deleteMessages(this.#cfg.ownerId, msgIds)
		} catch (e) {
			// 400: старше 48 часов или уже удалено, это не повод ронять показ.
			if (!is400(e)) console.error('card cleanup failed', e)
		}
	}
}
