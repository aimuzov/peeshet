import assert from 'node:assert/strict'
import { test } from 'node:test'

import { checkLimits, Invalid, isRubric, photoKeys } from '#src/post.ts'

test('text fits 32768 characters', () => {
	checkLimits('a'.repeat(32768), [])
	assert.throws(() => checkLimits('a'.repeat(32769), []), /32768/)
	// Символ за пределами BMP — один символ, хоть в строке JS он из двух половинок.
	checkLimits('😀'.repeat(32768), [])
})

test('a post shows up to 50 photos', () => {
	const keys = (n: number) => Array.from({ length: n }, (_, i) => `p${i + 1}`)
	const text = (n: number) =>
		keys(n)
			.map((k) => `![](tg://photo?id=${k})`)
			.join('\n\n')

	checkLimits(text(50), keys(60))
	assert.throws(() => checkLimits(text(51), keys(51)), /50/)
	// Фото, которых нет в тексте, в сообщение не идут и лимит не тратят.
	checkLimits('a', keys(60))
})

test('photo links must point at photos of the post', () => {
	const text = 'a\n\n![](tg://photo?id=p1 "x")\n\n![](tg://photo?id=p3)'

	checkLimits(text, ['p1', 'p2', 'p3'])

	assert.throws(
		() => checkLimits(`${text}\n\n![](tg://photo?id=p9)`, ['p1', 'p3']),
		(e) => e instanceof Invalid && /p9/.test(e.message),
	)

	assert.throws(() => checkLimits(text, ['p1']), /p3/)
})

test('photo keys are unique and in order', () => {
	assert.deepEqual(
		photoKeys(
			'![](tg://photo?id=p2)\n\n![](tg://photo?id=p1 "a")\n\n![](tg://photo?id=p2)',
		),
		['p2', 'p1'],
	)

	assert.deepEqual(photoKeys('просто текст'), [])
})

test('empty text is rejected', () => {
	assert.throws(() => checkLimits('  \n', []), Invalid)
})

test('rubrics', () => {
	assert.ok(isRubric('девлог'))
	assert.ok(!isRubric('новости'))
})
