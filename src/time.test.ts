import assert from 'node:assert/strict'
import { test } from 'node:test'

import { Invalid } from '#src/post.ts'
import {
	formatMsk,
	mskDayStart,
	nextFreeSlot,
	todayAt,
	tomorrowAt,
} from '#src/time.ts'

// Чт 2026-10-22 12:00 МСК = 09:00 UTC.
const THU_NOON = Date.UTC(2026, 9, 22, 9) / 1000
const H = 3600

test('day starts at Moscow midnight', () => {
	assert.equal(mskDayStart(THU_NOON), Date.UTC(2026, 9, 21, 21) / 1000)
})

test('presets', () => {
	assert.equal(todayAt(THU_NOON, 19), mskDayStart(THU_NOON) + 19 * H)
	assert.equal(tomorrowAt(THU_NOON, 10), mskDayStart(THU_NOON) + 34 * H)
})

test('next weekday slot skips past and taken times', () => {
	const fri10 = mskDayStart(THU_NOON) + 34 * H
	const mon10 = fri10 + 3 * 24 * H

	// Чт 10:00 уже прошло, ближайшее — Пт 10:00.
	assert.equal(nextFreeSlot(THU_NOON, 'девлог', new Set()), fri10)
	// Пт занята, выходные пропускаются.
	assert.equal(nextFreeSlot(THU_NOON, 'девлог', new Set([fri10])), mon10)
})

test('weekly digest goes on Sunday evening', () => {
	const sun19 = mskDayStart(THU_NOON) + 3 * 24 * H + 19 * H

	assert.equal(nextFreeSlot(THU_NOON, 'неделя', new Set()), sun19)
})

test('format', () => {
	assert.equal(formatMsk(THU_NOON), '22.10 12:00')
})

test('a post at another time still takes the day', () => {
	const fri10 = mskDayStart(THU_NOON) + 34 * H
	const mon10 = fri10 + 3 * 24 * H

	assert.equal(nextFreeSlot(THU_NOON, 'девлог', new Set([fri10 + 1800])), mon10)
})

test('no free slot is an Invalid error', () => {
	const sun19 = mskDayStart(THU_NOON) + 3 * 24 * H + 19 * H
	const taken = new Set(
		Array.from({ length: 10 }, (_, i) => sun19 + i * 7 * 24 * H),
	)

	assert.throws(() => nextFreeSlot(THU_NOON, 'неделя', taken), Invalid)
})
