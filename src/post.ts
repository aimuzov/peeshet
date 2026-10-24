export const RUBRICS = ['девлог', 'разбор', 'релиз', 'мысль', 'неделя'] as const
export type Rubric = (typeof RUBRICS)[number]

export type Status =
	'draft' | 'scheduled' | 'publishing' | 'published' | 'failed' | 'deleted'

export type Post = {
	id: number
	rubric: Rubric
	/** Исходник rich-сообщения в Markdown Telegram; фото — абзацы `![](tg://photo?id=p1)`. */
	text: string
	status: Status
	/** Unix-время публикации, только у `scheduled`. */
	publishAt: number | null
	/** Id сообщения поста в канале. */
	channelMsgId: number | null
	/** Оценка голоса от check_as_me, `null`, если не проверяли. */
	voice: number | null
	projects: string[]
	sources: string[]
	imagePrompt: string | null
	error: string | null
	/** Telegram уже принял текущий текст: карточка с ним показалась. */
	validated: boolean
	createdAt: number
	updatedAt: number
}

export type InboxKind = 'message' | 'reply' | 'cover'

export type InboxItem = {
	id: number
	kind: InboxKind
	postId: number | null
	text: string | null
	/** Сообщение владельца, из которого пришло входящее: его удаляем после ack. */
	srcMsgId: number | null
	createdAt: number
	takenAt: number | null
}

/** Ошибка, которую можно показать владельцу как есть. */
export class Invalid extends Error {}

export class NotFound extends Error {}

// Лимиты rich-сообщения. Документация пишет «32768 символов UTF-8»: считаем символы Unicode,
// а не байты и не половинки UTF-16. Лимит в 500 блоков проверяет сам Telegram.
export const RICH_LIMIT = 32768
export const MEDIA_LIMIT = 50

const PHOTO_LINK = /tg:\/\/photo\?id=([\w-]+)/g

/** Ключи фото, на которые ссылается текст, без повторов, в порядке появления. */
export const photoKeys = (text: string): string[] => [
	...new Set(Array.from(text.matchAll(PHOTO_LINK), (m) => m[1])),
]

export const isRubric = (value: unknown): value is Rubric =>
	RUBRICS.includes(value as Rubric)

/**
 * Бросает {@link Invalid}, если пост с таким текстом и фото с ключами `keys` Telegram заведомо
 * не примет. Разметку проверяет он сам, когда пост приходит в карточку.
 */
export function checkLimits(text: string, keys: string[]): void {
	if (!text.trim()) throw new Invalid('Пустой текст.')

	if (keys.length > MEDIA_LIMIT)
		throw new Invalid(`В посте не больше ${MEDIA_LIMIT} фото.`)

	const length = [...text].length

	if (length > RICH_LIMIT)
		throw new Invalid(`Текст длиннее ${RICH_LIMIT} символов: ${length}.`)

	const unknown = photoKeys(text).filter((key) => !keys.includes(key))

	if (unknown.length)
		throw new Invalid(
			`В тексте фото, которых у поста нет: ${unknown.join(', ')}.`,
		)
}
