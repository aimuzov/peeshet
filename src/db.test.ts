import assert from 'node:assert/strict'
import { test } from 'node:test'

import { Db } from '#src/db.ts'
import { Invalid, NotFound } from '#src/post.ts'

const NOW = 1_790_000_000

function open() {
	const clock = { t: NOW }
	const db = new Db(':memory:', () => clock.t)

	return { db, clock }
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

	assert.throws(() => draft(db, 'a'.repeat(5000)), Invalid)
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

test('media counts against caption limit', () => {
	const { db } = open()
	const post = draft(db, 'a'.repeat(2000))

	assert.throws(() => db.addMedia(post.id, 'f1'), /1024/)
	db.setText(post.id, 'short')
	db.addMedia(post.id, 'f1')
	db.addMedia(post.id, 'f2')
	assert.deepEqual(db.media(post.id), ['f1', 'f2'])
	assert.throws(() => db.setText(post.id, 'a'.repeat(2000)), /1024/)
})

test('preview messages map back to their post', () => {
	const { db } = open()
	const post = draft(db)

	assert.deepEqual(db.setPreview(post.id, [10, 11]), [])
	assert.equal(db.byPreview(11)?.id, post.id)
	assert.deepEqual(db.setPreview(post.id, [12]), [10, 11])
	assert.equal(db.byPreview(10), null)
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
