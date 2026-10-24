import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'

import {
	checkLimits,
	Invalid,
	MEDIA_LIMIT,
	NotFound,
	photoKeys,
	tooManyPhotos,
	type InboxItem,
	type InboxKind,
	type Post,
	type Rubric,
	type Status,
} from '#src/post.ts'

// Ключ фото — его имя в тексте поста: `![](tg://photo?id=p1)`.
const MEDIA = `CREATE TABLE IF NOT EXISTS media (
	id INTEGER PRIMARY KEY,
	post_id INTEGER NOT NULL REFERENCES posts(id),
	key TEXT NOT NULL,
	file_id TEXT NOT NULL,
	UNIQUE (post_id, key)
)`

const CARDS = `CREATE TABLE IF NOT EXISTS cards (
	post_id INTEGER PRIMARY KEY REFERENCES posts(id),
	msg_id INTEGER NOT NULL UNIQUE
)`

const SCHEMA = [
	'PRAGMA journal_mode = WAL',
	'PRAGMA foreign_keys = ON',
	`CREATE TABLE IF NOT EXISTS posts (
		id INTEGER PRIMARY KEY,
		rubric TEXT NOT NULL,
		text TEXT NOT NULL,
		status TEXT NOT NULL,
		publish_at INTEGER,
		channel_msg_id INTEGER,
		voice INTEGER,
		projects TEXT NOT NULL DEFAULT '[]',
		sources TEXT NOT NULL DEFAULT '[]',
		image_prompt TEXT,
		error TEXT,
		created_at INTEGER NOT NULL,
		updated_at INTEGER NOT NULL,
		validated INTEGER NOT NULL DEFAULT 0
	)`,
	'CREATE INDEX IF NOT EXISTS posts_status ON posts(status, publish_at)',
	`CREATE TABLE IF NOT EXISTS revisions (
		id INTEGER PRIMARY KEY,
		post_id INTEGER NOT NULL REFERENCES posts(id),
		text TEXT NOT NULL,
		created_at INTEGER NOT NULL
	)`,
	MEDIA,
	// Прежняя схема карточки из нескольких сообщений, в базе разработки могла остаться.
	'DROP TABLE IF EXISTS previews',
	CARDS,
	`CREATE TABLE IF NOT EXISTS extras (
		msg_id INTEGER PRIMARY KEY,
		post_id INTEGER NOT NULL REFERENCES posts(id),
		kind TEXT NOT NULL
	)`,
	`CREATE TABLE IF NOT EXISTS inbox (
		id INTEGER PRIMARY KEY,
		kind TEXT NOT NULL,
		post_id INTEGER REFERENCES posts(id),
		text TEXT,
		src_msg_id INTEGER,
		created_at INTEGER NOT NULL,
		taken_at INTEGER,
		acked_at INTEGER
	)`,
]

// Вид входящего из прежней схемы: такие записи сессии не отдаём.
const LEGACY_PHOTO = 'photo'

// Из каких статусов пост можно править и планировать.
const EDITABLE: Status[] = ['draft', 'scheduled', 'failed']

export const STATUS_RU: Record<Status, string> = {
	draft: 'черновик',
	scheduled: 'запланирован',
	publishing: 'публикуется',
	published: 'опубликован',
	failed: 'не вышел',
	deleted: 'удалён',
}

export type NewPost = {
	rubric: Rubric
	text: string
	voice?: number | null
	projects?: string[]
	sources?: string[]
	imagePrompt?: string | null
}

export type Card = { msgId: number }
/** Сообщения вокруг карточки; осталось только уведомление о сбое. */
export type ExtraKind = 'error'

export type Media = { key: string; fileId: string }
export type Revision = { id: number; text: string; createdAt: number }

type Row = Record<string, SQLInputValue>

const num = (v: SQLInputValue) => (v === null ? null : Number(v))
const str = (v: SQLInputValue) => (v === null ? null : String(v))

const toPost = (r: Row): Post => ({
	id: Number(r.id),
	rubric: r.rubric as Rubric,
	text: String(r.text),
	status: r.status as Status,
	publishAt: num(r.publish_at),
	channelMsgId: num(r.channel_msg_id),
	voice: num(r.voice),
	projects: JSON.parse(String(r.projects)),
	sources: JSON.parse(String(r.sources)),
	imagePrompt: str(r.image_prompt),
	error: str(r.error),
	validated: Number(r.validated) === 1,
	createdAt: Number(r.created_at),
	updatedAt: Number(r.updated_at),
})

const toInbox = (r: Row): InboxItem => ({
	id: Number(r.id),
	kind: r.kind as InboxKind,
	postId: num(r.post_id),
	text: str(r.text),
	srcMsgId: num(r.src_msg_id),
	createdAt: Number(r.created_at),
	takenAt: num(r.taken_at),
})

export class Db {
	readonly #db: DatabaseSync
	readonly #now: () => number

	constructor(path: string, now = () => Math.floor(Date.now() / 1000)) {
		if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })

		this.#db = new DatabaseSync(path)

		for (const sql of SCHEMA) this.#db.prepare(sql).run()

		// В базе разработки inbox могла остаться без этой колонки.
		if (!this.#columns('inbox').includes('src_msg_id'))
			this.#db.prepare('ALTER TABLE inbox ADD COLUMN src_msg_id INTEGER').run()

		if (!this.#columns('posts').includes('validated'))
			this.#db
				.prepare(
					'ALTER TABLE posts ADD COLUMN validated INTEGER NOT NULL DEFAULT 0',
				)
				.run()

		// Фото без ключей в текст не вставить, а карточки с видом (текст или фото) rich-карточка
		// заменит сама. Пересоздаём, только если терять уже нечего.
		const stale = [
			!this.#columns('media').includes('key') && { table: 'media', sql: MEDIA },
			this.#columns('cards').includes('kind') && { table: 'cards', sql: CARDS },
		].filter((t) => t !== false)

		if (stale.length && this.#unpublished()) {
			this.#db.close()

			throw new Error(
				'Старая схема базы: есть неопубликованные посты, перенеси или удали data/peeshet.db вручную',
			)
		}

		for (const { table, sql } of stale) {
			this.#db.prepare(`DROP TABLE ${table}`).run()
			this.#db.prepare(sql).run()
		}

		// Превью альбома больше нет, его сообщения ни к чему.
		this.#db.prepare(`DELETE FROM extras WHERE kind = 'album'`).run()

		// Фото раньше писались во входящие событием; теперь их разбирает сервер, сессии они не нужны.
		this.#db
			.prepare(
				`UPDATE inbox SET acked_at = ? WHERE kind = '${LEGACY_PHOTO}' AND acked_at IS NULL`,
			)
			.run(now())

		this.#now = now
	}

	now(): number {
		return this.#now()
	}

	create(p: NewPost): Post {
		checkLimits(p.text, [])
		const t = this.#now()
		const { lastInsertRowid } = this.#db
			.prepare(
				`INSERT INTO posts (rubric, text, status, voice, projects, sources, image_prompt, created_at, updated_at)
				VALUES (?, ?, 'draft', ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				p.rubric,
				p.text,
				p.voice ?? null,
				JSON.stringify(p.projects ?? []),
				JSON.stringify(p.sources ?? []),
				p.imagePrompt ?? null,
				t,
				t,
			)

		return this.get(Number(lastInsertRowid))
	}

	get(id: number): Post {
		const row = this.#db.prepare('SELECT * FROM posts WHERE id = ?').get(id) as
			Row | undefined

		if (!row) throw new NotFound(`Поста ${id} нет.`)

		return toPost(row)
	}

	/** Посты кроме удалённых, ближайшие по дате первыми. */
	list(statuses?: Status[]): Post[] {
		const filter = statuses?.length
			? `status IN (${statuses.map(() => '?').join(', ')})`
			: `status != 'deleted'`
		const rows = this.#db
			.prepare(
				`SELECT * FROM posts WHERE ${filter} ORDER BY coalesce(publish_at, created_at), id`,
			)
			.all(...(statuses ?? [])) as Row[]

		return rows.map(toPost)
	}

	setText(id: number, text: string): Post {
		return this.#tx(() => {
			const post = this.editable(id)

			checkLimits(text, this.#keys(id))

			this.#db
				.prepare(
					'INSERT INTO revisions (post_id, text, created_at) VALUES (?, ?, ?)',
				)
				.run(id, post.text, this.#now())

			return this.#update(id, { text, validated: 0 })
		})
	}

	setMeta(
		id: number,
		meta: {
			rubric?: Rubric
			voice?: number | null
			imagePrompt?: string | null
		},
	): Post {
		this.editable(id)
		const fields: Row = {}

		if (meta.rubric !== undefined) fields.rubric = meta.rubric

		if (meta.voice !== undefined) fields.voice = meta.voice

		if (meta.imagePrompt !== undefined) fields.image_prompt = meta.imagePrompt

		return this.#update(id, fields)
	}

	/** Прошлые версии текста, последняя первой. */
	revisions(id: number): Revision[] {
		const rows = this.#db
			.prepare(
				'SELECT id, text, created_at FROM revisions WHERE post_id = ? ORDER BY id DESC',
			)
			.all(id) as Row[]

		return rows.map((r) => ({
			id: Number(r.id),
			text: String(r.text),
			createdAt: Number(r.created_at),
		}))
	}

	/** Возвращает текст прошлой ревизии и забирает её из истории. */
	revert(id: number): Post {
		return this.#tx(() => {
			this.editable(id)
			const [last] = this.revisions(id)

			if (!last) throw new Invalid('Прошлых ревизий нет.')

			checkLimits(last.text, this.#keys(id))
			this.#db.prepare('DELETE FROM revisions WHERE id = ?').run(last.id)

			return this.#update(id, { text: last.text, validated: 0 })
		})
	}

	/**
	 * Отменяет правку, которую не принял Telegram: возвращает текст ревизии `revisionId` и
	 * забирает её. `false` — отменять уже нечего или нельзя: ревизии нет, пост вышел или
	 * выходит. Это не ошибка запроса: владелец и так узнает, что Telegram правку не принял.
	 */
	undoText(id: number, revisionId: number, validated = false): boolean {
		return this.#tx(() => {
			const row = this.#db
				.prepare('SELECT text FROM revisions WHERE id = ? AND post_id = ?')
				.get(revisionId, id) as Row | undefined

			if (!this.#undoable(id, row !== undefined)) return false

			this.#db.prepare('DELETE FROM revisions WHERE id = ?').run(revisionId)

			this.#update(id, {
				text: String(row?.text),
				validated: Number(validated),
			})

			return true
		})
	}

	/** Отменяет откат, который не принял Telegram: ревизия возвращается в историю как была. */
	undoRevert(
		id: number,
		revision: Revision,
		text: string,
		validated: boolean,
	): boolean {
		return this.#tx(() => {
			const taken = this.#db
				.prepare('SELECT 1 FROM revisions WHERE id = ?')
				.get(revision.id)

			if (!this.#undoable(id, !taken)) return false

			this.#db
				.prepare(
					'INSERT INTO revisions (id, post_id, text, created_at) VALUES (?, ?, ?, ?)',
				)
				.run(revision.id, id, revision.text, revision.createdAt)

			this.#update(id, { text, validated: Number(validated) })

			return true
		})
	}

	/** Отмечает, что Telegram принял текст `text`, если он всё ещё текущий. */
	markValidated(id: number, text: string): void {
		this.#db
			.prepare('UPDATE posts SET validated = 1 WHERE id = ? AND text = ?')
			.run(id, text)
	}

	schedule(id: number, at: number): Post {
		if (at < this.#now()) throw new Invalid('Это время уже прошло.')

		return this.#move(id, EDITABLE, 'scheduled', {
			publish_at: at,
			error: null,
		})
	}

	unschedule(id: number): Post {
		return this.#move(id, ['scheduled', 'failed'], 'draft', {
			publish_at: null,
		})
	}

	remove(id: number): Post {
		return this.#move(id, EDITABLE, 'deleted', { publish_at: null })
	}

	/** Запланированные посты, у которых наступило время. */
	due(): Post[] {
		const rows = this.#db
			.prepare(
				`SELECT * FROM posts WHERE status = 'scheduled' AND publish_at <= ? ORDER BY publish_at, id`,
			)
			.all(this.#now()) as Row[]

		return rows.map(toPost)
	}

	/**
	 * Забирает созревший пост на публикацию и возвращает его свежую версию; `null`, если его
	 * уже забрали, сняли или перенесли.
	 */
	claim(id: number): Post | null {
		const t = this.#now()
		const row = this.#db
			.prepare(
				`UPDATE posts SET status = 'publishing', updated_at = ? WHERE id = ? AND status = 'scheduled' AND publish_at <= ? RETURNING *`,
			)
			.get(t, id, t) as Row | undefined

		return row ? toPost(row) : null
	}

	published(id: number, channelMsgId: number): Post {
		return this.#move(id, ['publishing'], 'published', {
			channel_msg_id: channelMsgId,
			error: null,
		})
	}

	failed(id: number, error: string): Post {
		return this.#move(id, ['publishing'], 'failed', { error })
	}

	/**
	 * После рестарта: посты, застрявшие в `publishing`, считаются невышедшими.
	 * Переотправлять их нельзя — сообщение могло уйти до падения.
	 */
	recoverPublishing(): number[] {
		const ids = this.list(['publishing']).map((p) => p.id)

		for (const id of ids)
			this.failed(
				id,
				'Сервер упал во время публикации, проверь канал: пост мог выйти.',
			)

		return ids
	}

	/** Посты, просроченные дольше `grace` секунд, возвращаются в черновики. */
	unscheduleOverdue(grace: number): Post[] {
		const rows = this.#db
			.prepare(
				`SELECT id FROM posts WHERE status = 'scheduled' AND publish_at < ? ORDER BY publish_at, id`,
			)
			.all(this.#now() - grace) as Row[]

		return rows.map((r) => this.unschedule(Number(r.id)))
	}

	scheduledTimes(): Set<number> {
		return new Set(this.list(['scheduled']).map((p) => p.publishAt as number))
	}

	/**
	 * Ключ следующего фото поста: `p` и номер на единицу больше наибольшего. Бросает
	 * {@link Invalid}, если фото к посту больше не добавить.
	 */
	nextKey(id: number): string {
		const post = this.editable(id)
		const keys = this.#keys(id)
		const last = Math.max(0, ...keys.map((k) => Number(k.slice(1)) || 0))

		// Новое фото встанет в текст, поэтому место под него ищем среди уже вставленных.
		if (photoKeys(post.text).length >= MEDIA_LIMIT) throw tooManyPhotos()

		return `p${last + 1}`
	}

	addMedia(id: number, fileId: string): { post: Post; key: string } {
		return this.#tx(() => {
			const key = this.nextKey(id)

			this.#db
				.prepare('INSERT INTO media (post_id, key, file_id) VALUES (?, ?, ?)')
				.run(id, key, fileId)

			return { post: this.#update(id, {}), key }
		})
	}

	/** Забывает фото, которое так и не попало в текст; вставленное не трогает. */
	dropMedia(id: number, key: string): void {
		if (photoKeys(this.get(id).text).includes(key)) return

		this.#db
			.prepare('DELETE FROM media WHERE post_id = ? AND key = ?')
			.run(id, key)
	}

	media(id: number): Media[] {
		const rows = this.#db
			.prepare('SELECT key, file_id FROM media WHERE post_id = ? ORDER BY id')
			.all(id) as Row[]

		return rows.map((r) => ({ key: String(r.key), fileId: String(r.file_id) }))
	}

	card(id: number): Card | null {
		const row = this.#db
			.prepare('SELECT msg_id FROM cards WHERE post_id = ?')
			.get(id) as Row | undefined

		return row ? { msgId: Number(row.msg_id) } : null
	}

	/** Запоминает сообщение карточки и возвращает прежнее, чтобы удалить именно его. */
	setCard(id: number, msgId: number): number | null {
		return this.#tx(() => {
			const old = this.card(id)?.msgId ?? null

			this.#db
				.prepare(
					`INSERT INTO cards (post_id, msg_id) VALUES (?, ?)
					ON CONFLICT (post_id) DO UPDATE SET msg_id = excluded.msg_id`,
				)
				.run(id, msgId)

			return old
		})
	}

	dropCard(id: number): void {
		this.#db.prepare('DELETE FROM cards WHERE post_id = ?').run(id)
	}

	addExtra(id: number, msgId: number, kind: ExtraKind): void {
		this.#db
			.prepare('INSERT INTO extras (msg_id, post_id, kind) VALUES (?, ?, ?)')
			.run(msgId, id, kind)
	}

	extras(id: number, kind?: ExtraKind): number[] {
		const rows = this.#db
			.prepare(
				'SELECT msg_id FROM extras WHERE post_id = ? AND (? IS NULL OR kind = ?) ORDER BY msg_id',
			)
			.all(id, kind ?? null, kind ?? null) as Row[]

		return rows.map((r) => Number(r.msg_id))
	}

	/** Забывает сообщения вокруг карточки, когда их уже нет в чате. */
	dropExtras(msgIds: number[]): void {
		const del = this.#db.prepare('DELETE FROM extras WHERE msg_id = ?')

		for (const msgId of msgIds) del.run(msgId)
	}

	/** Пост, к карточке которого относится сообщение: сама карточка или сообщение рядом. */
	byPreview(msgId: number): Post | null {
		const row = this.#db
			.prepare(
				'SELECT post_id FROM cards WHERE msg_id = ? UNION SELECT post_id FROM extras WHERE msg_id = ?',
			)
			.get(msgId, msgId) as Row | undefined

		return row ? this.get(Number(row.post_id)) : null
	}

	push(
		kind: InboxKind,
		postId: number | null,
		text: string | null,
		srcMsgId: number | null = null,
	): InboxItem {
		if (postId !== null) this.get(postId)

		const { lastInsertRowid } = this.#db
			.prepare(
				'INSERT INTO inbox (kind, post_id, text, src_msg_id, created_at) VALUES (?, ?, ?, ?, ?)',
			)
			.run(kind, postId, text, srcMsgId, this.#now())
		const row = this.#db
			.prepare('SELECT * FROM inbox WHERE id = ?')
			.get(Number(lastInsertRowid)) as Row

		return toInbox(row)
	}

	/**
	 * Следующее неразобранное входящее. Взятое больше `reclaimAfter` секунд назад и не
	 * подтверждённое отдаётся снова: сессия могла упасть посреди работы.
	 */
	take(reclaimAfter = 600): InboxItem | null {
		const t = this.#now()
		const row = this.#db
			.prepare(
				`SELECT * FROM inbox WHERE acked_at IS NULL AND kind != '${LEGACY_PHOTO}' AND (taken_at IS NULL OR taken_at < ?) ORDER BY id LIMIT 1`,
			)
			.get(t - reclaimAfter) as Row | undefined

		if (!row) return null

		this.#db
			.prepare('UPDATE inbox SET taken_at = ? WHERE id = ?')
			.run(t, Number(row.id))

		return { ...toInbox(row), takenAt: t }
	}

	ack(id: number): InboxItem {
		const row = this.#db
			.prepare('UPDATE inbox SET acked_at = ? WHERE id = ? RETURNING *')
			.get(this.#now(), id) as Row | undefined

		if (!row) throw new NotFound(`Входящего ${id} нет.`)

		return toInbox(row)
	}

	/** Входящие, которые никто не взял дольше `age` секунд. */
	untaken(age: number): InboxItem[] {
		const rows = this.#db
			.prepare(
				`SELECT * FROM inbox WHERE taken_at IS NULL AND acked_at IS NULL AND kind != '${LEGACY_PHOTO}' AND created_at <= ? ORDER BY id`,
			)
			.all(this.#now() - age) as Row[]

		return rows.map(toInbox)
	}

	#undoable(id: number, found: boolean): boolean {
		const { status } = this.get(id)

		if (found && EDITABLE.includes(status)) return true

		console.error(
			`post ${id}: undo skipped (${found ? status : 'revision conflict'})`,
		)

		return false
	}

	#keys(id: number): string[] {
		return this.media(id).map((m) => m.key)
	}

	#unpublished(): boolean {
		const row = this.#db
			.prepare(
				`SELECT count(*) AS n FROM posts WHERE status IN ('draft', 'scheduled', 'failed', 'publishing')`,
			)
			.get() as Row

		return Number(row.n) > 0
	}

	#columns(table: string): string[] {
		const rows = this.#db.prepare(`PRAGMA table_info(${table})`).all() as Row[]

		return rows.map((r) => String(r.name))
	}

	#tx<T>(fn: () => T): T {
		this.#db.prepare('BEGIN').run()

		try {
			const result = fn()

			this.#db.prepare('COMMIT').run()

			return result
		} catch (error) {
			this.#db.prepare('ROLLBACK').run()

			throw error
		}
	}

	editable(id: number): Post {
		const post = this.get(id)

		if (!EDITABLE.includes(post.status))
			throw new Invalid(`Пост ${STATUS_RU[post.status]}, менять его нельзя.`)

		return post
	}

	#move(id: number, from: Status[], to: Status, fields: Row = {}): Post {
		const post = this.get(id)

		if (!from.includes(post.status))
			throw new Invalid(`Пост ${STATUS_RU[post.status]}, так нельзя.`)

		return this.#update(id, { ...fields, status: to })
	}

	#update(id: number, fields: Row): Post {
		const all: Row = { ...fields, updated_at: this.#now() }
		const keys = Object.keys(all)

		this.#db
			.prepare(
				`UPDATE posts SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`,
			)
			.run(...keys.map((k) => all[k]), id)

		return this.get(id)
	}
}
