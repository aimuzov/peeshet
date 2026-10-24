import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'

import { Db } from '#src/db.ts'
import { Invalid, NotFound } from '#src/post.ts'

const NOW = 1_790_000_000

function open() {
	const clock = { t: NOW }
	const db = new Db(':memory:', () => clock.t)

	return { db, clock }
}

/** Абзацы со всеми фото поста. */
const all = (db: Db, id: number) =>
	db.media(id).map((m) => `![](tg://photo?id=${m.key})`)

const quiet = () => {
	const log = console.error

	console.error = () => {}

	return () => void (console.error = log)
}

const draft = (db: Db, text = 'Привет') =>
	db.create({ rubric: 'девлог', text, projects: ['sorebody'] })

test('create stores a draft', () => {
	const { db } = open()
	const post = draft(db)

	assert.equal(post.status, 'draft')
	assert.deepEqual(post.projects, ['sorebody'])
	assert.deepEqual(db.get(post.id), post)
	assert.throws(() => db.get(999), NotFound)
})

test('create checks limits', () => {
	const { db } = open()

	assert.throws(() => draft(db, 'a'.repeat(32769)), Invalid)
	assert.throws(() => draft(db, '![](tg://photo?id=p1)'), /p1/)
})

test('edit keeps revisions and revert restores them', () => {
	const { db } = open()
	const post = draft(db, 'v1')

	db.setText(post.id, 'v2')
	db.setText(post.id, 'v3')

	assert.deepEqual(
		db.revisions(post.id).map((r) => r.text),
		['v2', 'v1'],
	)

	assert.equal(db.revert(post.id).text, 'v2')
	assert.equal(db.revert(post.id).text, 'v1')
	assert.throws(() => db.revert(post.id), /ревизий/)
})

test('schedule needs a moment not in the past', () => {
	const { db } = open()
	const post = draft(db)

	assert.throws(() => db.schedule(post.id, NOW - 1), Invalid)
	assert.equal(db.schedule(post.id, NOW + 60).publishAt, NOW + 60)
	assert.equal(db.schedule(post.id, NOW + 120).publishAt, NOW + 120) // перенос
	assert.equal(db.unschedule(post.id).status, 'draft')
	assert.equal(db.get(post.id).publishAt, null)
})

test('due, claim, published', () => {
	const { db, clock } = open()
	const post = draft(db)

	db.schedule(post.id, NOW + 60)
	assert.deepEqual(db.due(), [])
	clock.t = NOW + 60

	assert.deepEqual(
		db.due().map((p) => p.id),
		[post.id],
	)

	assert.ok(db.claim(post.id))
	assert.ok(!db.claim(post.id)) // второй раз не забрать
	db.published(post.id, 42)
	assert.equal(db.get(post.id).status, 'published')
	assert.equal(db.get(post.id).channelMsgId, 42)
})

test('published posts cannot change', () => {
	const { db } = open()
	const post = draft(db)

	db.schedule(post.id, NOW)
	db.claim(post.id)
	db.published(post.id, 1)
	assert.throws(() => db.setText(post.id, 'new'), Invalid)
	assert.throws(() => db.unschedule(post.id), Invalid)
	assert.throws(() => db.remove(post.id), Invalid)
})

test('failed post can be rescheduled', () => {
	const { db } = open()
	const post = draft(db)

	db.schedule(post.id, NOW)
	db.claim(post.id)
	db.failed(post.id, 'Forbidden')
	assert.equal(db.get(post.id).error, 'Forbidden')
	assert.equal(db.schedule(post.id, NOW + 10).error, null)
})

test('recover marks stuck publishing as failed', () => {
	const { db } = open()
	const post = draft(db)

	db.schedule(post.id, NOW)
	db.claim(post.id)
	assert.deepEqual(db.recoverPublishing(), [post.id])
	assert.equal(db.get(post.id).status, 'failed')
	assert.match(db.get(post.id).error ?? '', /проверь канал/)
})

test('overdue goes back to drafts', () => {
	const { db, clock } = open()
	const late = draft(db)
	const fresh = draft(db)

	db.schedule(late.id, NOW)
	db.schedule(fresh.id, NOW + 600)
	clock.t = NOW + 601

	assert.deepEqual(
		db.unscheduleOverdue(300).map((p) => p.id),
		[late.id],
	)

	assert.equal(db.get(late.id).status, 'draft')
	assert.equal(db.get(fresh.id).status, 'scheduled')
})

test('list hides deleted and sorts by date', () => {
	const { db } = open()
	const a = draft(db)
	const b = draft(db)

	db.schedule(b.id, NOW + 10)
	db.remove(a.id)

	assert.deepEqual(
		db.list().map((p) => p.id),
		[b.id],
	)

	assert.deepEqual(
		db.list(['draft']).map((p) => p.id),
		[],
	)

	assert.deepEqual(db.scheduledTimes(), new Set([NOW + 10]))
})

test('text refers only to photos of its post, up to 50 of them', () => {
	const { db } = open()
	const post = draft(db)
	const withPhoto = 'Текст\n\n![](tg://photo?id=p1 "подпись")'

	assert.throws(() => db.setText(post.id, withPhoto), /p1/)
	db.addMedia(post.id, 'f1')
	assert.equal(db.setText(post.id, withPhoto).text, withPhoto)

	for (let i = 2; i <= 50; i++) db.addMedia(post.id, `f${i}`)

	// В тексте одно фото из 50: ещё одно поместится.
	assert.equal(db.addMedia(post.id, 'f51').key, 'p51')
	db.setText(post.id, all(db, post.id).slice(0, 50).join('\n\n'))
	assert.throws(() => db.addMedia(post.id, 'f52'), /50/)
	assert.equal(db.media(post.id).length, 51)
})

test('dropMedia forgets only a photo the text does not use', () => {
	const { db } = open()
	const post = draft(db)

	db.addMedia(post.id, 'f1')
	db.addMedia(post.id, 'f2')
	db.setText(post.id, '![](tg://photo?id=p1)')
	db.dropMedia(post.id, 'p1')
	db.dropMedia(post.id, 'p2')
	assert.deepEqual(db.media(post.id), [{ key: 'p1', fileId: 'f1' }])
})

test('photos get keys p1, p2… in their post', () => {
	const { db } = open()
	const post = draft(db)
	const other = draft(db)
	const first = db.addMedia(post.id, 'f1')

	assert.equal(first.key, 'p1')
	assert.equal(first.post.id, post.id)
	assert.equal(db.addMedia(post.id, 'f2').key, 'p2')
	assert.equal(db.addMedia(other.id, 'f3').key, 'p1')

	assert.deepEqual(db.media(post.id), [
		{ key: 'p1', fileId: 'f1' },
		{ key: 'p2', fileId: 'f2' },
	])
})

/** База в старой схеме: media без ключей, cards с видом карточки, превью альбома в extras. */
function legacy(status: string) {
	const dir = mkdtempSync(join(tmpdir(), 'peeshet-'))
	const path = join(dir, 'p.db')
	const raw = new DatabaseSync(path)

	for (const sql of [
		`CREATE TABLE posts (id INTEGER PRIMARY KEY, rubric TEXT NOT NULL, text TEXT NOT NULL, status TEXT NOT NULL, publish_at INTEGER, channel_msg_id INTEGER, voice INTEGER, projects TEXT NOT NULL DEFAULT '[]', sources TEXT NOT NULL DEFAULT '[]', image_prompt TEXT, error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
		`INSERT INTO posts (rubric, text, status, created_at, updated_at) VALUES ('мысль', 'x', '${status}', 1, 1)`,
		'CREATE TABLE media (id INTEGER PRIMARY KEY, post_id INTEGER NOT NULL REFERENCES posts(id), file_id TEXT NOT NULL)',
		`INSERT INTO media (post_id, file_id) VALUES (1, 'old')`,
		'CREATE TABLE cards (post_id INTEGER PRIMARY KEY REFERENCES posts(id), msg_id INTEGER NOT NULL UNIQUE, kind TEXT NOT NULL)',
		`INSERT INTO cards (post_id, msg_id, kind) VALUES (1, 10, 'photo')`,
		'CREATE TABLE extras (msg_id INTEGER PRIMARY KEY, post_id INTEGER NOT NULL REFERENCES posts(id), kind TEXT NOT NULL)',
		`INSERT INTO extras (msg_id, post_id, kind) VALUES (11, 1, 'album'), (12, 1, 'error')`,
	])
		raw.prepare(sql).run()

	raw.close()

	return { path, done: () => rmSync(dir, { recursive: true }) }
}

test('old media and cards tables are recreated when every post is out', () => {
	const { path, done } = legacy('published')
	const db = new Db(path, () => NOW)

	assert.deepEqual(db.media(1), [])
	assert.equal(db.card(1), null)
	assert.equal(db.setCard(1, 20), null)
	assert.deepEqual(db.card(1), { msgId: 20 })
	// Превью альбома больше нет, а уведомление о сбое остаётся.
	assert.deepEqual(db.extras(1), [12])
	const fresh = db.create({ rubric: 'мысль', text: 'y' })

	assert.equal(db.addMedia(fresh.id, 'new').key, 'p1')
	done()
})

test('old tables with unpublished posts are left for the owner to sort out', () => {
	for (const status of ['draft', 'scheduled', 'failed', 'publishing']) {
		const { path, done } = legacy(status)

		assert.throws(() => new Db(path, () => NOW), /Старая схема базы/, status)
		// Ничего не потеряно: фото на месте.
		const raw = new DatabaseSync(path)

		assert.equal(raw.prepare('SELECT count(*) AS n FROM media').get()?.n, 1)
		raw.close()
		done()
	}
})

test('card and extra messages map back to their post', () => {
	const { db } = open()
	const post = draft(db)

	assert.equal(db.card(post.id), null)
	assert.equal(db.setCard(post.id, 10), null)
	assert.deepEqual(db.card(post.id), { msgId: 10 })
	db.addExtra(post.id, 11, 'error')
	db.addExtra(post.id, 12, 'error')
	assert.equal(db.byPreview(10)?.id, post.id)
	assert.equal(db.byPreview(11)?.id, post.id)
	// Возвращает прежнее сообщение карточки, чтобы удалить именно его.
	assert.equal(db.setCard(post.id, 20), 10)
	assert.equal(db.byPreview(10), null)
	assert.deepEqual(db.card(post.id), { msgId: 20 })
	assert.deepEqual(db.extras(post.id, 'error'), [11, 12])
	assert.deepEqual(db.extras(post.id), [11, 12])
	db.dropExtras([11])
	assert.equal(db.byPreview(11), null)
	assert.deepEqual(db.extras(post.id), [12])
	db.dropCard(post.id)
	assert.equal(db.card(post.id), null)
	assert.equal(db.byPreview(20), null)
})

test('a stale previews table is dropped on open', () => {
	const dir = mkdtempSync(join(tmpdir(), 'peeshet-'))
	const path = join(dir, 'p.db')
	const raw = new DatabaseSync(path)

	raw.exec(`
		CREATE TABLE previews (msg_id INTEGER PRIMARY KEY, post_id INTEGER);
		CREATE TABLE inbox (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, post_id INTEGER, text TEXT, created_at INTEGER NOT NULL, taken_at INTEGER, acked_at INTEGER);`)

	raw.close()

	const db = new Db(path, () => NOW)
	const tables = new DatabaseSync(path)
		.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
		.all()
		.map((r) => r.name)

	assert.ok(!tables.includes('previews'))
	assert.ok(tables.includes('cards'))
	// В старой inbox нет src_msg_id: колонка добавляется при открытии.
	assert.equal(db.push('message', null, 'x', 5).srcMsgId, 5)
	rmSync(dir, { recursive: true })
})

test('inbox take, ack and reclaim', () => {
	const { db, clock } = open()
	const post = draft(db)
	const a = db.push('message', null, 'девлог по sorebody')
	const b = db.push('reply', post.id, 'сократи')

	assert.equal(db.take()?.id, a.id)
	assert.equal(db.take()?.id, b.id)
	assert.equal(db.take(), null)
	db.ack(a.id)
	clock.t = NOW + 601
	// b взят, но не подтверждён — через 10 минут отдаётся снова.
	assert.equal(db.take()?.id, b.id)
	assert.throws(() => db.ack(999), NotFound)
})

test('untaken inbox items by age', () => {
	const { db, clock } = open()

	db.push('message', null, 'привет')
	assert.deepEqual(db.untaken(120), [])
	clock.t = NOW + 120
	assert.equal(db.untaken(120).length, 1)
	db.take()
	assert.deepEqual(db.untaken(120), [])
})

test('claim ignores posts that are not due anymore', () => {
	const { db, clock } = open()
	const moved = draft(db)
	const unscheduled = draft(db)
	const removed = draft(db)

	for (const p of [moved, unscheduled, removed]) db.schedule(p.id, NOW + 60)

	clock.t = NOW + 60
	db.schedule(moved.id, NOW + 86_400)
	db.unschedule(unscheduled.id)
	db.remove(removed.id)

	assert.equal(db.claim(moved.id), null)
	assert.equal(db.claim(unscheduled.id), null)
	assert.equal(db.claim(removed.id), null)
})

test('claim returns the fresh version of the post', () => {
	const { db, clock } = open()
	const post = draft(db, 'старый')

	db.schedule(post.id, NOW + 60)
	db.setText(post.id, 'новый')
	clock.t = NOW + 60

	const claimed = db.claim(post.id)

	assert.equal(claimed?.text, 'новый')
	assert.equal(claimed?.status, 'publishing')
})

test('inbox keeps the source message and ack returns it', () => {
	const { db } = open()
	const a = db.push('message', null, 'привет', 42)
	const b = db.push('cover', draft(db).id, null)

	assert.equal(a.srcMsgId, 42)
	assert.equal(b.srcMsgId, null)
	assert.equal(db.take()?.srcMsgId, 42)
	assert.equal(db.ack(a.id).srcMsgId, 42)
})

test('legacy photo items never reach the session', () => {
	const dir = mkdtempSync(join(tmpdir(), 'peeshet-'))
	const path = join(dir, 'p.db')

	new Db(path, () => NOW).push('message', null, 'привет')
	const raw = new DatabaseSync(path)
	const legacy = `INSERT INTO inbox (kind, text, created_at) VALUES ('photo', NULL, ${NOW})`

	raw.exec(legacy)
	raw.close()

	// Старая запись разбирается при открытии, новая — пропускается при выдаче.
	const db = new Db(path, () => NOW + 600)

	new DatabaseSync(path).exec(legacy)
	assert.equal(db.untaken(120).length, 1)
	assert.equal(db.take()?.text, 'привет')
	assert.equal(db.take(), null)
	assert.deepEqual(db.untaken(0), [])
	rmSync(dir, { recursive: true })
})

test('push rejects an unknown post', () => {
	const { db } = open()

	assert.throws(() => db.push('reply', 999, 'текст'), NotFound)
})

test('undoText takes back an edit telegram did not accept', () => {
	const { db } = open()
	const post = draft(db, 'v1')

	db.setText(post.id, 'v2')
	db.setText(post.id, 'v3')
	const [last] = db.revisions(post.id)

	assert.equal(db.undoText(post.id, last.id), true)
	assert.equal(db.get(post.id).text, 'v2')

	assert.deepEqual(
		db.revisions(post.id).map((r) => r.text),
		['v1'],
	)

	// Ревизию уже забрали: отменять нечего, и это не ошибка запроса.
	const restore = quiet()

	assert.equal(db.undoText(post.id, last.id), false)
	restore()
	assert.equal(db.get(post.id).text, 'v2')
})

test('undoText leaves a published post alone', () => {
	const { db } = open()
	const post = draft(db, 'v1')

	db.setText(post.id, 'v2')
	const [last] = db.revisions(post.id)

	db.schedule(post.id, NOW)
	db.claim(post.id)
	db.published(post.id, 7)
	const restore = quiet()

	assert.equal(db.undoText(post.id, last.id), false)
	restore()
	assert.equal(db.get(post.id).text, 'v2')
	assert.equal(db.revisions(post.id).length, 1)
})

test('validated marks only the current text', () => {
	const { db } = open()
	const post = draft(db, 'v1')

	assert.equal(post.validated, false)
	db.markValidated(post.id, 'старый')
	assert.equal(db.get(post.id).validated, false)
	db.markValidated(post.id, 'v1')
	assert.equal(db.get(post.id).validated, true)
	db.setText(post.id, 'v2')
	assert.equal(db.get(post.id).validated, false)
	db.markValidated(post.id, 'v2')
	db.revert(post.id)
	assert.equal(db.get(post.id).validated, false)
})

test('posts without the validated column get it on open', () => {
	const dir = mkdtempSync(join(tmpdir(), 'peeshet-'))
	const path = join(dir, 'p.db')
	const raw = new DatabaseSync(path)

	for (const sql of [
		`CREATE TABLE posts (id INTEGER PRIMARY KEY, rubric TEXT NOT NULL, text TEXT NOT NULL, status TEXT NOT NULL, publish_at INTEGER, channel_msg_id INTEGER, voice INTEGER, projects TEXT NOT NULL DEFAULT '[]', sources TEXT NOT NULL DEFAULT '[]', image_prompt TEXT, error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
		`INSERT INTO posts (rubric, text, status, created_at, updated_at) VALUES ('мысль', 'x', 'published', 1, 1)`,
	])
		raw.prepare(sql).run()

	raw.close()
	assert.equal(new Db(path, () => NOW).get(1).validated, false)
	rmSync(dir, { recursive: true })
})
