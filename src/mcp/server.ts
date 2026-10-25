import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { extname } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'

import { PeeshetClient } from '#src/mcp/client.ts'
import { RUBRICS } from '#src/post.ts'

// Версию читаем в рантайме, чтобы рукопожатие MCP не отставало от package.json.
const { version } = createRequire(import.meta.url)('../../package.json') as {
	version: string
}

export type Config = { url: string; token: string }

export function loadConfig(env = process.env): Config {
	return {
		url: env.PEESHET_API_URL || 'https://peeshet.aimuzov.online',
		token: env.PEESHET_API_TOKEN ?? '',
	}
}

const NO_TOKEN = 'PEESHET_API_TOKEN не задан'

const IMAGE_TYPES: Record<string, string> = {
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.webp': 'image/webp',
}

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] })
const json = (v: unknown) => text(JSON.stringify(v, null, 2))
const failure = (e: unknown) => ({
	...text(e instanceof Error ? e.message : String(e)),
	isError: true,
})

/**
 * Без токена сервер всё равно стартует: он живёт в глобальном конфиге MCP,
 * и машине без токена лучше увидеть понятную ошибку в ответе инструмента, чем упавший сервер.
 */
export function createServer(
	cfg: Config,
	client = new PeeshetClient(cfg.url, cfg.token),
): McpServer {
	const server = new McpServer({ name: 'peeshet', version })

	/** Регистрирует инструмент: проверка токена и превращение сбоев в isError общие. */
	function tool<S extends z.ZodRawShape>(
		name: string,
		description: string,
		inputSchema: S,
		run: (args: z.infer<z.ZodObject<S>>) => Promise<unknown>,
	) {
		// Типы SDK не умеют выводить аргументы из обобщённой формы, поэтому приведение одно, здесь.
		const handler = async (
			args: z.infer<z.ZodObject<S>>,
		): Promise<CallToolResult> => {
			if (!cfg.token) return failure(NO_TOKEN)

			try {
				return await run(args).then((v) =>
					typeof v === 'string' ? text(v) : json(v),
				)
			} catch (e) {
				return failure(e)
			}
		}

		server.registerTool(
			name,
			{ title: name, description, inputSchema },
			handler as never,
		)
	}

	const id = z.number().int().describe('Post id')

	tool(
		'list_posts',
		'List posts in the queue. Optional status filter, comma-separated.',
		{ status: z.string().optional().describe('e.g. draft,scheduled') },
		({ status }) =>
			client.request(
				'GET',
				`/api/posts${status ? `?status=${encodeURIComponent(status)}` : ''}`,
			),
	)

	tool('get_post', 'Get a post with its media and revisions.', { id }, (a) =>
		client.request('GET', `/api/posts/${a.id}`),
	)

	tool(
		'create_post',
		'Create a draft post and show its card to the owner in the bot. ' +
			'The text is rich Telegram Markdown. Put a photo in its own paragraph: ' +
			'`![](tg://photo?id=<key> "caption")`, where the key comes from attach_image.',
		{
			rubric: z.enum(RUBRICS),
			text: z.string().min(1).describe('Post text, rich Markdown'),
			voice: z.number().optional().describe('Voice score from check_as_me'),
			projects: z.array(z.string()).optional(),
			sources: z.array(z.string()).optional(),
			imagePrompt: z.string().optional().describe('Prompt for a cover image'),
		},
		(body) => client.request('POST', '/api/posts', body),
	)

	tool(
		'update_post',
		'Edit a post: text and/or metadata. The text is rich Telegram Markdown; ' +
			'photos go in their own paragraph as `![](tg://photo?id=<key> "caption")`.',
		{
			id,
			text: z
				.string()
				.min(1)
				.optional()
				.describe('New full text, rich Markdown'),
			rubric: z.enum(RUBRICS).optional(),
			voice: z.number().optional(),
			imagePrompt: z.string().optional(),
		},
		({ id: postId, ...body }) =>
			client.request('PATCH', `/api/posts/${postId}`, body),
	)

	tool('revert_post', 'Restore the previous revision of a post.', { id }, (a) =>
		client.request('POST', `/api/posts/${a.id}/revert`),
	)

	tool(
		'schedule_post',
		'Schedule a post. Give either `at` (ISO time with offset) or slot "next" for the next free slot.',
		{
			id,
			at: z
				.string()
				.optional()
				.describe('ISO time with offset, 2026-10-24T12:00:00+03:00'),
			slot: z.literal('next').optional(),
		},
		({ id: postId, ...body }) =>
			client.request('POST', `/api/posts/${postId}/schedule`, body),
	)

	tool('unschedule_post', 'Take a post off the schedule.', { id }, (a) =>
		client.request('POST', `/api/posts/${a.id}/unschedule`),
	)

	tool(
		'attach_image',
		'Upload a local png/jpg/webp to a post. Returns `key`; reference it in the text as `![](tg://photo?id=<key>)`.',
		{ id, path: z.string().describe('Local path to the image') },
		async ({ id: postId, path }) => {
			const type = IMAGE_TYPES[extname(path).toLowerCase()]

			if (!type) throw new Error('Нужен файл png, jpg или webp.')

			return client.upload(postId, await readFile(path), type)
		},
	)

	tool(
		'preview_post',
		'Redraw the post card in the bot so the owner sees the current state.',
		{ id },
		(a) => client.request('POST', `/api/posts/${a.id}/preview`),
	)

	tool(
		'next_inbox',
		'Take the next inbox item or wait for one. `kind` is message (a new idea), ' +
			'reply (an edit for post `postId`, or "Время публикации: …" for scheduling) ' +
			'or cover (an image for the post). After handling an item you must call ack_inbox, ' +
			'otherwise it comes back after a while.',
		{
			wait: z
				.number()
				.int()
				.min(0)
				.max(25)
				.optional()
				.describe('Seconds to wait for an item, default 25'),
		},
		async ({ wait = 25 }) => {
			const res = (await client.request(
				'GET',
				`/api/inbox/next?wait=${wait}`,
			)) as {
				item: unknown
			}

			return res.item ? res : 'Входящих нет.'
		},
	)

	tool(
		'ack_inbox',
		'Mark an inbox item as handled.',
		{ id: z.number().int().describe('Inbox item id') },
		(a) => client.request('POST', `/api/inbox/${a.id}/ack`),
	)

	return server
}
