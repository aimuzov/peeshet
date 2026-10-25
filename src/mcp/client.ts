// HTTP-клиент API peeshet для локального MCP. Ошибки сервера уже по-русски,
// их текст доходит до сессии без переделки.

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

	request(method: string, path: string, body?: unknown): Promise<unknown> {
		return this.#send(
			method,
			path,
			body === undefined ? undefined : JSON.stringify(body),
			'application/json',
		)
	}

	upload(
		postId: number,
		bytes: Uint8Array<ArrayBuffer>,
		type: string,
	): Promise<unknown> {
		return this.#send('POST', `/api/posts/${postId}/media`, bytes, type)
	}

	async #send(
		method: string,
		path: string,
		body: BodyInit | undefined,
		type: string,
	): Promise<unknown> {
		let res: Response

		try {
			res = await fetch(this.#base + path, {
				method,
				headers: {
					authorization: `Bearer ${this.#token}`,
					...(body === undefined ? {} : { 'content-type': type }),
				},
				body,
			})
		} catch (e) {
			throw new ApiError(
				0,
				`peeshet недоступен (${this.#base}): ${e instanceof Error ? e.message : String(e)}`,
			)
		}

		const json = (await res.json().catch(() => ({}))) as { error?: string }

		if (!res.ok)
			throw new ApiError(res.status, json.error ?? `HTTP ${res.status}`)

		return json
	}
}
