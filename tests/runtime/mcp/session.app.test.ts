import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { nativeAppAdapter } from '../../support/native-app'

let directory: string
let app: ReturnType<typeof nativeAppAdapter>
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'session-compiled-'))
  app = nativeAppAdapter({ dir: directory, token: 'session-test-token', launch: ({ cwd, port }) => ({ args: [join(cwd, '.output/server/index.mjs')], env: { HOST: '127.0.0.1', PORT: String(port), NUXT_MCP_TOKEN: 'session-test-token' } }) })
  await app.start()
}, 60000)
afterAll(async () => { try { await app?.close() } finally { if (directory) await rm(directory, { recursive: true, force: true }) } })
it('initializes a real SDK session, lists tools and refuses invalid credentials', async () => {
  const client = new Client({ name: 'daily-session-consumer', version: '1' })
  const transport = new StreamableHTTPClientTransport(new URL(app.url('/mcp-session')), { requestInit: { headers: { authorization: 'Bearer session-test-token' } } })
  try {
    await client.connect(transport)
    expect(transport.sessionId).toBeTruthy()
    expect((await client.listTools()).tools.map(tool => tool.name)).toContain('list_enterprises')
    const denied = await fetch(app.url('/mcp-session'), { method: 'POST', headers: { authorization: 'Bearer invalid', 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) })
    expect(denied.status).toBe(401)
  } finally { await client.close() }
})
