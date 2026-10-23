// Всё, что владелец делает в боте. Кнопки сервер обрабатывает сам, а текст, где нужен LLM,
// складывает во входящие для сессии Claude Code на маке.

import { Composer, GrammyError, type Context } from 'grammy'

import { dateMenu, deleteMenu, statusLine, type Cards } from '#src/cards.ts'
import type { Db } from '#src/db.ts'
import { Invalid, NotFound } from '#src/post.ts'
import { nextFreeSlot, todayAt, tomorrowAt } from '#src/time.ts'

export type BotDeps = {
	db: Db
	cards: Cards
	ownerId: number
	/** Запустить тик планировщика сразу, например после «Сейчас». */
	kick: () => void
}

// Сколько секунд после кнопки «Править» или «Своё время» ждём ответ.
const AWAIT_TTL = 600
const FORWARDED = 'Передал в сессию.'

type Markup = Parameters<Context['editMessageReplyMarkup']>[0]

/** Повторное нажатие даёт тот же набор кнопок, и Telegram отвечает 400: это не ошибка. */
async function swapMarkup(
	ctx: Context,
	reply_markup: NonNullable<Markup>['reply_markup'],
): Promise<void> {
	try {
		await ctx.editMessageReplyMarkup({ reply_markup })
	} catch (e) {
		if (
			e instanceof GrammyError &&
			e.error_code === 400 &&
			e.description.includes('message is not modified')
		)
			return

		throw e
	}
}

export function handlers({
	db,
	cards,
	ownerId,
	kick,
}: BotDeps): Composer<Context> {
	const bot = new Composer<Context>()
	// Чего ждём следующим сообщением после кнопки: правку или время для поста.
	let awaiting: { kind: 'edit' | 'time'; postId: number; at: number } | null =
		null

	// Чужим бот не отвечает вовсе, как и в группах.
	bot.use(async (ctx, next) => {
		if (ctx.from?.id === ownerId && ctx.chat?.type === 'private') await next()
	})

	bot.command('queue', async (ctx) => {
		const posts = db.list(['draft', 'scheduled', 'failed'])

		if (!posts.length) return void (await ctx.reply('Очередь пуста.'))

		const lines = posts.map(
			(p) => `${p.id}. ${statusLine({ ...p, error: null })}`,
		)
		const kb = posts.map((p) => [
			{ text: `Открыть ${p.id}`, callback_data: `o:${p.id}` },
		])

		await ctx.reply(lines.join('\n'), { reply_markup: { inline_keyboard: kb } })
	})

	async function act(
		action: string,
		id: number,
		arg: string | undefined,
		ctx: Context,
	): Promise<string | void> {
		const now = db.now()

		switch (action) {
			case 'o':
				return cards.show(id)

			case 'd':
				db.get(id)

				return void (await swapMarkup(ctx, dateMenu(id, now)))

			case 's': {
				if (arg === 'custom') {
					db.editable(id)
					awaiting = { kind: 'time', postId: id, at: now }

					return void (await ctx.reply(
						'Напиши дату и время, например «в пятницу в 12».',
					))
				}

				const { rubric } = db.get(id)
				const presets: Record<string, () => number> = {
					now: () => now,
					today: () => todayAt(now, 19),
					tomorrow: () => tomorrowAt(now, 10),
					next: () => nextFreeSlot(now, rubric, db.scheduledTimes()),
				}
				const at = arg ? presets[arg]?.() : undefined

				if (at === undefined) throw new Invalid('Не понял кнопку.')

				db.schedule(id, at)

				await cards.show(id)

				// Тик после карточки: иначе «публикуется» нарисуется уже после того, как планировщик её убрал.
				if (arg === 'now') kick()

				return
			}

			case 'u':
				db.unschedule(id)

				return cards.show(id)

			case 'e':
				db.editable(id)
				awaiting = { kind: 'edit', postId: id, at: now }

				return void (await ctx.reply('Напиши, что поменять в посте.'))

			case 'c':
				db.editable(id)
				db.push('cover', id, null)

				return FORWARDED

			case 'x':
				db.get(id)

				return void (await swapMarkup(ctx, deleteMenu(id)))

			case 'xx':
				db.remove(id)
				await cards.hide(id)

				return 'Удалено.'

			default:
				throw new Invalid('Не понял кнопку.')
		}
	}

	bot.on('callback_query:data', async (ctx) => {
		const [action, rawId, arg] = ctx.callbackQuery.data.split(':')

		// Любая кнопка, кроме ожидающих текста, отменяет прежний вопрос.
		if (action !== 'e' && !(action === 's' && arg === 'custom')) awaiting = null

		try {
			const notice = await act(action, Number(rawId), arg, ctx)

			await ctx.answerCallbackQuery(notice ? { text: notice } : undefined)
		} catch (e) {
			if (!(e instanceof Invalid || e instanceof NotFound)) {
				await ctx
					.answerCallbackQuery({ text: 'Не получилось, попробуй ещё раз.' })
					.catch(() => {})

				throw e
			}

			await ctx.answerCallbackQuery({ text: e.message, show_alert: true })
		}
	})

	bot.on('message:photo', async (ctx) => {
		const replyTo = ctx.msg.reply_to_message?.message_id
		const post = replyTo ? db.byPreview(replyTo) : null

		if (!post)
			return void (await ctx.reply('Пришли фото ответом на карточку поста.'))

		const best = ctx.msg.photo.at(-1)

		if (!best) return

		try {
			db.addMedia(post.id, best.file_id)
		} catch (e) {
			if (!(e instanceof Invalid)) throw e

			return void (await ctx.reply(e.message))
		}

		db.push('photo', post.id, ctx.msg.caption ?? null)

		try {
			await cards.show(post.id)
		} catch (e) {
			console.error('card refresh failed', e)
			await ctx.reply('Фото прикрепил, а карточку обновить не вышло.')
		}
	})

	bot.command('start', (ctx) =>
		ctx.reply(
			'Присылай идеи и правки текстом, ответом на карточку — правку к посту. /queue — очередь.',
		),
	)

	bot.on('message:voice', (ctx) =>
		ctx.reply('Голосовые пока не понимаю, напиши текстом.'),
	)

	bot.on('message:text', async (ctx) => {
		if (ctx.msg.text.startsWith('/'))
			return void (await ctx.reply('Не знаю такой команды. /queue — очередь.'))

		const replyTo = ctx.msg.reply_to_message?.message_id
		const card = replyTo ? db.byPreview(replyTo) : null

		// Ответ на карточку точнее, чем ожидание после кнопки.
		const pending =
			!card && awaiting && awaiting.at + AWAIT_TTL >= db.now() ? awaiting : null

		awaiting = null

		if (pending) {
			const { kind, postId } = pending

			db.push(
				'reply',
				postId,
				kind === 'time' ? `Время публикации: ${ctx.msg.text}` : ctx.msg.text,
			)
		} else if (card) {
			db.push('reply', card.id, ctx.msg.text)
		} else {
			db.push('message', null, ctx.msg.text)
		}

		await ctx.reply(FORWARDED)
	})

	return bot
}
