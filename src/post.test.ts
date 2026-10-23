import assert from 'node:assert/strict'
import { test } from 'node:test'

import { checkLimits, Invalid, isRubric } from '#src/post.ts'

test('text without media fits 4096', () => {
	checkLimits('a'.repeat(4096), 0)
	assert.throws(() => checkLimits('a'.repeat(4097), 0), Invalid)
})

test('caption with media fits 1024', () => {
	checkLimits('a'.repeat(1024), 1)
	assert.throws(() => checkLimits('a'.repeat(1025), 3), /1024/)
})

test('album holds up to 10 photos', () => {
	checkLimits('a', 10)
	assert.throws(() => checkLimits('a', 11), /10/)
})

test('empty text is rejected', () => {
	assert.throws(() => checkLimits('  \n', 0), Invalid)
})

test('rubrics', () => {
	assert.ok(isRubric('девлог'))
	assert.ok(!isRubric('новости'))
})
