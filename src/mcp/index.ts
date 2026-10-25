import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

import { createServer, loadConfig } from '#src/mcp/server.ts'

await createServer(loadConfig()).connect(new StdioServerTransport())
