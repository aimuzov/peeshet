import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

type Seen = {
	method: string
	url: string
	headers: Record<string, unknown>
	body: Buffer
}

export async function stub(handler: (req: Seen) => [number, unknown]) {
	const server = createServer(async (req, res) => {
		const chunks: Buffer[] = []

		for await (const c of req) chunks.push(c)

		const [status, body] = handler({
			method: req.method ?? '',
			url: req.url ?? '',
			headers: req.headers,
			body: Buffer.concat(chunks),
		})

		res.writeHead(status, { 'content-type': 'application/json' })
		res.end(JSON.stringify(body))
	})

	await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))

	return {
		server,
		url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
	}
}
