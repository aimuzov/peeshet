// grammY печатает в ошибках сети полный URL запроса, а в нём токен бота.
// Поэтому всё, что уходит в консоль, проходит через замену токена.

import { inspect } from 'node:util'

type Method = 'log' | 'info' | 'warn' | 'error'

/** Подменяет методы консоли так, чтобы `secret` не попадал в вывод. Возвращает откат. */
export function redactConsole(
	secret: string,
	target: Partial<Pick<Console, Method>> = console,
	methods: Method[] = ['log', 'info', 'warn', 'error'],
): () => void {
	const scrub = (arg: unknown) =>
		(typeof arg === 'string' ? arg : inspect(arg, { depth: 6 })).replaceAll(
			secret,
			'<BOT_TOKEN>',
		)
	const originals = methods.map((m) => [m, target[m]] as const)

	for (const [m, original] of originals) {
		if (original)
			target[m] = (...args: unknown[]) =>
				original.apply(target, args.map(scrub))
	}

	return () => {
		for (const [m, original] of originals) target[m] = original
	}
}
