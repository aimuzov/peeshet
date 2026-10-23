import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { run } from '@grammyjs/runner'
import { Bot } from 'grammy'

import { serve } from '#src/api.ts'
import { handlers } from '#src/bot.ts'
import { Cards } from '#src/cards.ts'
import { fromEnv } from '#src/config.ts'
import { Db } from '#src/db.ts'
import { Scheduler } from '#src/scheduler.ts'

process.on('unhandledRejection', (e) => console.error('unhandled rejection', e))

const settings = fromEnv()
const bot = new Bot(settings.botToken)
const db = new Db(join(settings.dataDir, 'peeshet.db'))
const cfg = { ownerId: settings.ownerId, channelId: settings.channelId }
const cards = new Cards(bot.api, db, cfg)
const scheduler = new Scheduler(bot.api, db, cards, cfg)
const kick = () =>
	void scheduler.tick().catch((e) => console.error('tick failed', e))

bot.use(handlers({ db, cards, ownerId: settings.ownerId, kick }))

bot.catch(({ error, ctx }) =>
	console.error(`update ${ctx.update.update_id} failed`, error),
)

await bot.api.setMyCommands([
	{ command: 'queue', description: 'Очередь постов' },
])

await scheduler.recover()
const http = serve({
	api: bot.api,
	db,
	cards,
	ownerId: settings.ownerId,
	token: settings.apiToken,
	port: settings.port,
})
const stop = new AbortController()
const runner = run(bot)

runner.task()?.catch((e) => {
	console.error('runner died', e)
	process.exit(1)
})

const loop = scheduler.run(stop.signal).catch((e) => {
	console.error('scheduler died', e)
	process.exit(1)
})

const shutdown = async () => {
	stop.abort()
	http.close()
	await runner.stop()
	// Дожидаемся текущей публикации, чтобы пост не остался в publishing, но не дольше 10 с.
	await Promise.race([loop, delay(10_000)])
	process.exit(0)
}

process.once('SIGTERM', shutdown)
process.once('SIGINT', shutdown)
console.log(`peeshet: api on :${settings.port}, channel ${settings.channelId}`)
