import assert from 'node:assert/strict'
import { test } from 'node:test'

import { fromEnv } from '#src/config.ts'

const ENV = {
	BOT_TOKEN: '1:x',
	OWNER_ID: '77',
	CHANNEL_ID: '@aimuzov_peeshet',
	API_TOKEN: 't'.repeat(32),
}

test('reads env with defaults', () => {
	assert.deepEqual(fromEnv(ENV), {
		botToken: '1:x',
		ownerId: 77,
		channelId: '@aimuzov_peeshet',
		apiToken: 't'.repeat(32),
		dataDir: 'data',
		port: 8080,
	})
})

test('missing or broken values stop the start', () => {
	assert.throws(() => fromEnv({ ...ENV, BOT_TOKEN: '' }), /BOT_TOKEN/)
	assert.throws(() => fromEnv({ ...ENV, OWNER_ID: '7a' }), /OWNER_ID/)
	assert.throws(() => fromEnv({ ...ENV, API_TOKEN: 'short' }), /API_TOKEN/)
	assert.throws(() => fromEnv({ ...ENV, CHANNEL_ID: 'peeshet' }), /CHANNEL_ID/)
})
