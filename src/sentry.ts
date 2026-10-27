// Ошибки в Sentry, только они: без трейсов и профилей. Без SENTRY_DSN SDK не включается,
// поэтому локальный запуск ничего не шлёт, а остальные функции здесь становятся пустыми.

import { createRequire } from 'node:module'
import * as Sentry from '@sentry/node'

const { version } = createRequire(import.meta.url)('../package.json') as {
	version: string
}

export type SentryOpts = {
	/** Что запущено: бот с API или локальный MCP. Уходит тегом `component`. */
	component: 'bot' | 'mcp'
	/** Вычищаются из всех событий: grammY пишет токен бота в URL сетевых ошибок. */
	secrets?: string[]
	env?: NodeJS.ProcessEnv
}

/** Заменяет секреты во всём объекте, как бы глубоко они ни лежали. */
export function scrub<T>(value: T, secrets: string[]): T {
	const live = secrets.filter(Boolean)

	if (!live.length) return value

	let json = JSON.stringify(value)

	// Внутри JSON `"` и `\` экранированы, так что и секрет ищем экранированным.
	for (const secret of live)
		json = json.replaceAll(JSON.stringify(secret).slice(1, -1), '<redacted>')

	return JSON.parse(json) as T
}

/** Включает SDK, если задан SENTRY_DSN. Возвращает, включился ли. */
export function initSentry({
	component,
	secrets = [],
	env = process.env,
}: SentryOpts): boolean {
	const dsn = env.SENTRY_DSN?.trim()

	if (!dsn) return false

	Sentry.init({
		dsn,
		release: `peeshet@${version}`,
		environment: env.SENTRY_ENVIRONMENT?.trim() || 'production',
		initialScope: { tags: { component } },
		// Дефолты v11 собирают всё: пользователя, заголовки, тела, query. Нам нужны только ошибки.
		dataCollection: {
			userInfo: false,
			cookies: false,
			httpHeaders: false,
			httpBodies: [],
			urlQueryParams: false,
			genAI: { inputs: false, outputs: false },
			stackFrameVariables: false,
		},
		// Сессии не нужны: ProcessSession иначе стучится в Sentry на каждом старте.
		integrations: (defaults) => [
			...defaults.filter((i) => i.name !== 'ProcessSession'),
			Sentry.httpIntegration({ sessions: false }),
		],
		beforeSend: (event) => scrub(event, secrets),
		beforeBreadcrumb: (crumb) => scrub(crumb, secrets),
	})

	return true
}

/** Пишет в консоль и отправляет в Sentry. */
export function report(what: string, error: unknown): void {
	console.error(what, error)
	Sentry.captureException(error, { extra: { what } })
}

/** То же, но дожидается отправки и роняет процесс. */
export async function fatal(what: string, error: unknown): Promise<never> {
	report(what, error)
	await Sentry.flush(2000)
	process.exit(1)
}

/**
 * Cron-монитор цикла публикации. Тик идёт раз в 30 с, монитор ждёт его раз в минуту
 * с запасом на рестарт при деплое: пропуск значит, что планировщик встал.
 */
export const monitorTick = (tick: () => Promise<void>): Promise<void> =>
	Sentry.withMonitor('peeshet-scheduler', tick, {
		schedule: { type: 'interval', value: 1, unit: 'minute' },
		checkinMargin: 5,
		maxRuntime: 10,
		failureIssueThreshold: 2,
		recoveryThreshold: 1,
	})
