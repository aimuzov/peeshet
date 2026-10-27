import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

import { createServer, loadConfig } from '#src/mcp/server.ts'
import { initSentry } from '#src/sentry.ts'

const cfg = loadConfig()

initSentry({ component: 'mcp', secrets: [cfg.token] })
await createServer(cfg).connect(new StdioServerTransport())
