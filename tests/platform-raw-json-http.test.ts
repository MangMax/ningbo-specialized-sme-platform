import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createApp, createRouter, toNodeListener, defineEventHandler, readBody, setHeader, setResponseStatus, getQuery, createError } from 'h3'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { useDb } from '../db'
import { updateCredential } from '../server/utils/credential-state'
import { handlePlatformBatchRequest } from '../server/utils/platform-batch-http'
import { recognizedResultToImport } from '../lib/platform/recognized-evidence'
import { whenIdle } from '../server/utils/job-runner'
import { platformSummaryCache } from '../server/utils/platform-summary-cache'
import { importExecutor } from '../server/utils/import-execution'
import { readMcpToken, resolveMcpAuth } from '../server/utils/mcp-auth'

const dir = mkdtempSync(join(tmpdir(), 'issue298-raw-json-http-'))
const db = useDb({ dbPath: join(dir, 'test.sqlite') })
const nativeFetch = globalThis.fetch
const token = 'synthetic-raw-archive-token'
const input = { source: 'queryBusList', name: '合成', rdjb: ['2'], pageSize: 1, rawDataVersion: 1 }
const typed = JSON.parse('{"id":"same","qymc":"合成","x":null,"n":1,"b":true,"o":{"a":1},"arr":[null,false,2,{"unknown":true}],"__proto__":{"own":true},"constructor":"own"}')
let raw: string
let pageBodies: Map<number, string> | undefined
function source(row: unknown, page = 1, total = 1) { return ` \n${JSON.stringify({ zrarData: { grid: { businessGrid: { pageSet: [row], page, pageSize: 1, maxCount: total, maxPage: total } } } })}\n` }
let server: ReturnType<typeof createServer>, base: string, client: Client
const transports = new Set<StreamableHTTPServerTransport>()
const tools: any[] = []
async function post(path: string, body: unknown) {
  return nativeFetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) })
}
async function call(name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args })
  expect(result.isError).not.toBe(true)
  return result.structuredContent ?? JSON.parse((result.content as any)[0].text)
}
beforeAll(async () => {
  vi.stubEnv('NUXT_DB_PATH', join(dir, 'test.sqlite'))
  vi.stubEnv('MIIT_COOKIE', ''); vi.stubEnv('MIIT_COOKIE_FILE', '')
  updateCredential('miitCookie', 'sid=synthetic-raw-wire-secret', { db })
  for (const [key, value] of Object.entries({ defineEventHandler, readBody, setHeader, setResponseStatus, getQuery, createError, useRuntimeConfig: () => ({ filesDir: dir, apiToken: token }) })) vi.stubGlobal(key, value)
  vi.doMock('@nuxtjs/mcp-toolkit/server', () => ({ defineMcpTool: (value: unknown) => value }))
  for (const path of ['query_platform', 'preflight_roster_batch', 'save_roster_batch', 'list_platform_queries', 'get_platform_batch_item', 'submit_platform_batch', 'retry_platform_batch']) tools.push((await import(`../server/mcp/tools/${path}.ts`)).default)
  const queryRoute = (await import('../server/api/platform/query.post')).default
  const readRoute = (await import('../server/api/platform/queries.get')).default
  const evidenceRoute = (await import('../server/api/platform/queries/[queryId]/evidence.get')).default
  const router = createRouter().post('/api/platform/query', queryRoute).get('/api/platform/queries', readRoute).get('/api/platform/queries/:queryId/evidence', evidenceRoute)
  const { createRosterImportHandler } = await import('../server/utils/roster-import-route')
  for (const action of ['preflight', 'commit'] as const) router.post(`/api/roster/import/${action}`, createRosterImportHandler(action))
  router.post('/api/platform/batches', defineEventHandler(async event => {
    const out = await handlePlatformBatchRequest('submit', { body: await readBody(event), headers: { authorization: event.node.req.headers.authorization } }, { db, apiToken: token, filesDir: dir })
    setResponseStatus(event, out.status); return out.body
  }))
  const listener = toNodeListener(createApp().use(router))
  server = createServer((req, res) => {
    if (req.url !== '/mcp') { listener(req, res); return }
    const mcp = new McpServer({ name: 'issue298-public-tool-fixture', version: '1' })
    const mcpAuth = resolveMcpAuth({ given: readMcpToken({ authorization: req.headers.authorization }), configured: token })
    for (const tool of tools.filter(tool => !tool.enabled || tool.enabled({ context: { mcpAuth } }))) mcp.registerTool(tool.name, { inputSchema: tool.inputSchema, ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}) }, async args => {
      const value = await tool.handler(args)
      return value.content ? value : { content: [{ type: 'text', text: JSON.stringify(value) }] }
    })
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    transports.add(transport)
    res.on('close', () => { transports.delete(transport); void mcp.close() })
    void mcp.connect(transport).then(() => transport.handleRequest(req, res)).catch(() => { res.statusCode = 500; res.end() })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  vi.stubGlobal('fetch', async (url: any, init: any) => {
    if (String(url).startsWith('https://zjtx.miit.gov.cn/')) return { ok: true, status: 200, text: async () => pageBodies?.get(Number(new URLSearchParams(init.body).get('pageNum'))) ?? raw }
    return nativeFetch(url, init)
  })
  client = new Client({ name: 'issue298-wire-client', version: '1' })
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }))
})
afterAll(async () => {
  await whenIdle(); await client?.close()
  for (const transport of transports) await transport.close()
  if (server) await new Promise<void>(resolve => server.close(() => resolve()))
  await importExecutor.close()
  platformSummaryCache.close(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); db.$client.close(); rmSync(dir, { recursive: true, force: true })
})
const plain = Object.fromEntries(Object.entries(typed).filter(([key]) => !['__proto__', 'constructor'].includes(key)))
const cases = [plain, { id: 'same', qymc: '合成', x: '', n: '1', b: 'true', o: '{"a":1}', arr: '[null,false,2,{"unknown":true}]' }, typed]
it.each([0, 1, 2])('real HTTP or MCP archive roundtrip preserves versioned raw envelope case %i with stable IDs and immutable replay', async index => {
  const row = cases[index]
  const discovered = await client.listTools()
  expect(discovered.tools.find(t => t.name === 'query_platform')!.inputSchema.properties).toHaveProperty('rawDataVersion')
  raw = source(row)
  const response = index === 0 ? await post('/api/platform/query', input) : null
  if (response) expect(response.headers.get('cache-control')).toBe('no-store')
  const result: any = response ? await response.json() : await call('query_platform', input)
  expect(result).toMatchObject({ status: 'success', rawData: { version: 1, rows: [row], pages: [{ body: raw }] } })
  if (index === 2) expect(Object.hasOwn(result.rawData.rows[0], '__proto__')).toBe(true)
  const request = { idempotencyKey: `wire-raw-${index}`, sourceKind: 'alias_evidence', sourceIdentity: 'issue298-synthetic', payload: { platformQueries: [recognizedResultToImport(result)] } }
  const preview: any = index === 0 ? await (await post('/api/roster/import/preflight', request)).json() : await call('preflight_roster_batch', request)
  expect(preview, JSON.stringify(preview)).toHaveProperty('preflight')
  expect(preview.preflight.conflicts).toEqual([])
  const saved: any = index === 0 ? await (await post('/api/roster/import/commit', request)).json() : await call('save_roster_batch', request)
  expect(saved.status).toBe('committed')
  const beforeReplay = db.$client.serialize()
  const replay: any = index === 0 ? await (await post('/api/roster/import/commit', request)).json() : await call('save_roster_batch', request)
  expect(replay).toEqual(saved)
  expect(db.$client.serialize()).toEqual(beforeReplay)
  const queryId = Number(saved.items.find((item: any) => item.kind === 'platform_query').ref.replace('query:', ''))
  const history: any = index === 0 ? await (await nativeFetch(`${base}/api/platform/queries?queryId=${queryId}`)).json() : await call('list_platform_queries', { queryId })
  expect(history.rows).toHaveLength(1)
  const archived = history.rows[0]
  expect(archived.query.collectionEvidence).toEqual(result)
  expect(archived.relations.map((relation: any) => relation.rawFields)).toEqual(result.rows)
  expect(archived.relations.map((relation: any) => relation.id)).toEqual(saved.items.find((item: any) => item.kind === 'platform_query').detail.relations)
  const reused = { ...request, idempotencyKey: `${request.idempotencyKey}-reuse` }
  const reuse: any = index === 0 ? await (await post('/api/roster/import/commit', reused)).json() : await call('save_roster_batch', reused)
  expect(reuse.status).toBe('committed')
  expect(reuse.items.find((item: any) => item.kind === 'platform_query').ref).toBe(`query:${queryId}`)
  const changed = structuredClone(request)
  changed.idempotencyKey += '-conflict'
  changed.payload.platformQueries[0].collectionEvidence.rawData.rows[0].n = 999
  const conflict: any = index === 0 ? await (await post('/api/roster/import/commit', changed)).json() : await call('save_roster_batch', changed)
  expect(conflict.status).toBe('failed')
  const after: any = await call('list_platform_queries', { queryId })
  expect(after.rows).toEqual(history.rows)
})
it('real batch HTTP submit and MCP item preserve typed source in persisted segments and respect the complete byte budget', async () => {
  raw = source(typed)
  const submitted: any = await (await post('/api/platform/batches', { items: [{ query: input }], limits: { maxResultBytes: 65536 } })).json()
  await whenIdle()
  const item: any = await call('get_platform_batch_item', { batchId: submitted.batchId, itemId: submitted.itemIds[0] })
  expect(item).toMatchObject({ status: 'success', segments: [{ rawData: { version: 1, rows: [typed], pages: [{ body: raw }] } }] })
  expect(Object.hasOwn(item.segments[0].rawData.rows[0], '__proto__')).toBe(true)
  raw = source({ id: 'large', n: 1 }) + ' '.repeat(70000)
  const limited: any = await (await post('/api/platform/batches', { items: [{ query: input }], limits: { maxResultBytes: 65536 } })).json()
  await whenIdle()
  const rejected: any = await call('get_platform_batch_item', { batchId: limited.batchId, itemId: limited.itemIds[0] })
  expect(rejected).toMatchObject({ status: 'partial', segments: [{ error: { code: 'safety_limit' }, rawData: { rows: [], pages: [] } }], unfinished: [{ page: 1 }] })
  expect(Buffer.byteLength(JSON.stringify(rejected))).toBeLessThan(65536)
})

it('existing strict HTTP archive body rejects prototype-named keys atomically while MCP retains them', async () => {
  raw = source(typed)
  const result: any = await call('query_platform', input)
  const before = db.$client.serialize()
  const rejected = await post('/api/roster/import/commit', { idempotencyKey: 'http-prototype-boundary', sourceKind: 'alias_evidence', sourceIdentity: 'issue298-synthetic', payload: { platformQueries: [recognizedResultToImport(result)] } })
  expect(rejected.status).toBe(400)
  expect(db.$client.serialize()).toEqual(before)
})

it.each(['HTTP', 'MCP'])('real %s query rejects a sensitive source without leaking raw data or writing business state', async transport => {
  raw = source({ id: 'secret', unknown: { accessToken: 'never-return-this-value' } })
  const before = db.$client.serialize()
  const result: any = transport === 'HTTP' ? await (await post('/api/platform/query', input)).json() : await call('query_platform', input)
  expect(result).toMatchObject({ status: 'failed', error: { code: 'sensitive_response' }, rawData: { rows: [], pages: [] } })
  expect(JSON.stringify(result)).not.toContain('never-return-this-value')
  expect(db.$client.serialize()).toEqual(before)
})

it('real MCP batch retry appends typed source segments and retains the accepted checkpoint and original times', async () => {
  pageBodies = new Map([[1, source({ id: 'first', n: 1 }, 1, 2)], [2, source({ id: 'second', n: '1' }, 2, 2)]])
  try {
    const receipt: any = await call('submit_platform_batch', { items: [{ query: { ...input, maxRequests: 1 } }] })
    await whenIdle()
    const prior: any = await call('get_platform_batch_item', { batchId: receipt.batchId, itemId: receipt.itemIds[0] })
    expect(prior).toMatchObject({ status: 'partial', segments: [{ rawData: { rows: [{ id: 'first', n: 1 }], pages: [{ page: 1 }] } }], unfinished: [{ page: 2 }] })
    const retried: any = await call('retry_platform_batch', { batchId: receipt.batchId, itemIds: receipt.itemIds })
    expect(retried).toMatchObject({ batchId: receipt.batchId, itemIds: receipt.itemIds })
    await whenIdle()
    const after: any = await call('get_platform_batch_item', { batchId: receipt.batchId, itemId: receipt.itemIds[0] })
    expect(after.status).toBe('success')
    expect(after.segments[0]).toEqual(prior.segments[0])
    expect(after.segments[1].rawData).toMatchObject({ version: 1, rows: [{ id: 'second', n: '1' }], pages: [{ page: 2, body: pageBodies.get(2) }] })
  } finally { pageBodies = undefined }
})

it('new raw envelope counts against the public archive read budget and remains byte exact through bounded evidence chunks', async () => {
  raw = source({ id: 'large-read', x: null, n: 1, unknown: '🙂' }) + ' '.repeat(4194304)
  const result: any = await (await post('/api/platform/query', input)).json()
  expect(result.status).toBe('success')
  const saved: any = await (await post('/api/roster/import/commit', { idempotencyKey: 'large-read-envelope', sourceKind: 'alias_evidence', sourceIdentity: 'issue298-synthetic', payload: { platformQueries: [recognizedResultToImport(result)] } })).json()
  expect(saved.status).toBe('committed')
  const queryId = Number(saved.items.find((item: any) => item.kind === 'platform_query').ref.replace('query:', ''))
  expect((await nativeFetch(`${base}/api/platform/queries?queryId=${queryId}`)).status).toBe(413)
  const chunks: Buffer[] = []
  let offset = 0
  while (true) {
    const response = await nativeFetch(`${base}/api/platform/queries/${queryId}/evidence?field=collectionEvidence&offset=${offset}&length=65536`)
    expect(response.status).toBe(200)
    const chunk: any = await response.json()
    expect(chunk.byteLength).toBeLessThanOrEqual(65536)
    const bytes = Buffer.from(chunk.data, 'base64')
    expect(bytes.length).toBe(chunk.byteLength)
    chunks.push(bytes); offset += bytes.length
    if (!chunk.hasMore) { expect(offset).toBe(chunk.totalBytes); break }
    expect(bytes.length).toBeGreaterThan(0)
  }
  const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
  expect(hash(Buffer.concat(chunks))).toBe(hash(JSON.stringify(result)))
})
