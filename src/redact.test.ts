import assert from 'node:assert/strict'
import { test } from 'node:test'

import { redactConsole } from '#src/redact.ts'

const SECRET = '123456:AAEsecret_token'

test('the secret never reaches the log, even inside an error', () => {
	const lines: string[] = []
	const sink = { error: (...a: unknown[]) => lines.push(a.join(' ')) } as Pick<
		Console,
		'error'
	>
	const restore = redactConsole(SECRET, sink, ['error'])
	const cause = new Error(
		`request to https://api.telegram.org/bot${SECRET}/getUpdates failed`,
	)

	sink.error('fetch failed', new Error('outer', { cause }), `url bot${SECRET}`)
	restore()
	sink.error('after restore')

	assert.equal(lines.length, 2)
	assert.ok(!lines[0].includes(SECRET))
	assert.match(lines[0], /bot<BOT_TOKEN>\/getUpdates/)
	assert.equal(lines[1], 'after restore')
})
