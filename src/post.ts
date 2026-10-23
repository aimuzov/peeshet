export const RUBRICS = ['девлог', 'разбор', 'релиз', 'мысль', 'неделя'] as const
export type Rubric = (typeof RUBRICS)[number]

export type Status =
	'draft' | 'scheduled' | 'publishing' | 'published' | 'failed' | 'deleted'

export type Post = {
	id: number
	rubric: Rubric
	/** Обычный текст: отправляется без parse_mode, ссылки Telegram подсвечивает сам. */
	text: string
	status: Status
	/** Unix-время публикации, только у `scheduled`. */
	publishAt: number | null
	/** Id первого сообщения поста в канале. */
	channelMsgId: number | null
	/** Оценка голоса от check_as_me, `null`, если не проверяли. */
	voice: number | null
	projects: string[]
	sources: string[]
	imagePrompt: string | null
	error: string | null
	createdAt: number
	updatedAt: number
}

export type InboxKind = 'message' | 'reply' | 'cover' | 'photo'

export type InboxItem = {
	id: number
	kind: InboxKind
	postId: number | null
	text: string | null
	createdAt: number
	takenAt: number | null
}

/** Ошибка, которую можно показать владельцу как есть. */
export class Invalid extends Error {}

export class NotFound extends Error {}

// Лимиты Bot API: текст сообщения, подпись к медиа, фото в альбоме.
export const TEXT_LIMIT = 4096
export const CAPTION_LIMIT = 1024
export const ALBUM_LIMIT = 10

export const isRubric = (value: unknown): value is Rubric =>
	RUBRICS.includes(value as Rubric)

/** Бросает {@link Invalid}, если пост с таким текстом и числом фото Telegram не примет. */
export function checkLimits(text: string, media: number): void {
	if (!text.trim()) throw new Invalid('Пустой текст.')

	if (media > ALBUM_LIMIT)
		throw new Invalid(`В альбоме не больше ${ALBUM_LIMIT} фото.`)

	const limit = media > 0 ? CAPTION_LIMIT : TEXT_LIMIT

	if (text.length > limit) {
		const what = media > 0 ? 'Подпись к фото' : 'Текст'

		throw new Invalid(`${what} длиннее ${limit} символов: ${text.length}.`)
	}
}
