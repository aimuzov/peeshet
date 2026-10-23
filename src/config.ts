export type Settings = {
	botToken: string
	/** Единственный, кому бот отвечает. */
	ownerId: number
	/** `@username` канала или его числовой id `-100…`. */
	channelId: string
	apiToken: string
	dataDir: string
	port: number
}

function required(env: NodeJS.ProcessEnv, name: string): string {
	const value = env[name]?.trim()

	if (!value) throw new Error(`${name} is not set`)

	return value
}

function int(name: string, value: string): number {
	if (!/^-?\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
		throw new Error(`${name} is not an integer: ${value}`)
	}

	return Number(value)
}

/** Бросает исключение, если чего-то не хватает: опечатка должна ронять старт. */
export function fromEnv(env: NodeJS.ProcessEnv = process.env): Settings {
	const apiToken = required(env, 'API_TOKEN')

	if (apiToken.length < 32)
		throw new Error('API_TOKEN must be at least 32 characters')

	const channelId = required(env, 'CHANNEL_ID')

	if (!/^@\w{5,}$/.test(channelId) && !/^-100\d+$/.test(channelId)) {
		throw new Error(`CHANNEL_ID is not a channel: ${channelId}`)
	}

	return {
		botToken: required(env, 'BOT_TOKEN'),
		ownerId: int('OWNER_ID', required(env, 'OWNER_ID')),
		channelId,
		apiToken,
		dataDir: env.DATA_DIR?.trim() || 'data',
		port: int('PORT', env.PORT?.trim() || '8080'),
	}
}
