import assert from 'node:assert/strict'
import { test } from 'node:test'

import { initSentry, scrub } from '#src/sentry.ts'

const SECRET = '123456:AAEsecret_token'

test('secrets are scrubbed at any depth', () => {
	const event = {
		message: `request to https://api.telegram.org/bot${SECRET}/getUpdates failed`,
		exception: {
			values: [{ value: `bot${SECRET}`, frames: [{ vars: { url: SECRET } }] }],
		},
		breadcrumbs: [
			{ data: { url: `https://api.telegram.org/bot${SECRET}/sendMessage` } },
		],
	}
	const clean = scrub(event, [SECRET, ''])

	assert.ok(!JSON.stringify(clean).includes(SECRET))
	assert.match(clean.message, /bot<redacted>\/getUpdates/)
	assert.ok(!JSON.stringify(event).includes('<redacted>'))
})

test('a secret with JSON-escaped characters is scrubbed too', () => {
	const secret = 'a"b\\c'
	const clean = scrub({ message: `token ${secret} leaked` }, [secret])

	assert.equal(clean.message, 'token <redacted> leaked')
})

test('without secrets the event is left as is', () => {
	const event = { message: 'boom' }

	assert.equal(scrub(event, ['']), event)
})

test('no DSN, no SDK', () => {
	assert.equal(initSentry({ component: 'bot', env: {} }), false)

	assert.equal(
		initSentry({ component: 'bot', env: { SENTRY_DSN: ' ' } }),
		false,
	)
})
