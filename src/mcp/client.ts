// HTTP-клиент API peeshet для локального MCP. Ошибки сервера уже по-русски,
// их текст доходит до сессии без переделки.

export type Opts = { signal?: AbortSignal; timeoutMs?: number }

const DEFAULT_TIMEOUT = 15_000

export class ApiError extends Error {
	readonly status: number

	constructor(status: number, message: string) {
		super(message)
		this.status = status
	}
}

export class PeeshetClient {
	readonly #base: string
	readonly #token: string

	constructor(base: string, token: string) {
		this.#base = base.replace(/\/+$/, '')
		this.#token = token
	}

	request(
		method: string,
		path: string,
		body?: unknown,
		opts: Opts = {},
	): Promise<unknown> {
		return this.#send(
			method,
			path,
			body === undefined ? undefined : JSON.stringify(body),
			'application/json',
			opts,
		)
	}

	upload(
		postId: number,
		bytes: Uint8Array<ArrayBuffer>,
		type: string,
		opts: Opts = {},
	): Promise<unknown> {
		return this.#send('POST', `/api/posts/${postId}/media`, bytes, type, opts)
	}

	async #send(
		method: string,
		path: string,
		body: BodyInit | undefined,
		type: string,
		{ signal, timeoutMs = DEFAULT_TIMEOUT }: Opts,
	): Promise<unknown> {
		const timeout = AbortSignal.timeout(timeoutMs)
		let res: Response

		try {
			res = await fetch(this.#base + path, {
				method,
				headers: {
					authorization: `Bearer ${this.#token}`,
					...(body === undefined ? {} : { 'content-type': type }),
				},
				body,
				signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
			})
		} catch (e) {
			if (signal?.aborted) throw new ApiError(0, 'Запрос отменён')

			if (timeout.aborted)
				throw new ApiError(
					0,
					`peeshet не ответил за ${Math.round(timeoutMs / 1000)} с`,
				)

			const cause = (e as { cause?: { code?: string; message?: string } }).cause
			const reason = cause?.code ?? cause?.message
			const message = e instanceof Error ? e.message : String(e)

			throw new ApiError(
				0,
				`peeshet недоступен (${this.#base}): ${reason ? `${message}, ${reason}` : message}`,
			)
		}

		const raw = await res.text().catch(() => '')
		let json: { error?: string } = {}

		try {
			json = JSON.parse(raw) as { error?: string }
		} catch {
			if (res.ok)
				throw new ApiError(
					res.status,
					'Ответ peeshet не JSON (проверь PEESHET_API_URL)',
				)
		}

		if (!res.ok)
			throw new ApiError(res.status, json.error ?? `HTTP ${res.status}`)

		return json
	}
}
