import { execFileSync } from 'node:child_process'
import { postgresRuntimeFixture } from '../../support/postgres-fixture.mjs'
import { closePostgresDirectoryDb, usePostgresDirectoryDb } from '../../../db/postgresql/client'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createApp, createRouter, toNodeListener, defineEventHandler, readBody, setHeader, setResponseStatus, getQuery, getHeader, getRouterParam, createError } from 'h3'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { updatePostgresCredentialState } from '../../../layers/core/server/utils/credential-state-postgres'
import { stopPostgresJobs } from '../../../layers/core/server/utils/postgres-jobs'
import { recognizedResultToImport } from '../../../layers/sme-roster/lib/platform/recognized-evidence'
import { readMcpToken, resolveMcpAuth } from '../../../layers/core/server/utils/mcp-auth'

const dir = mkdtempSync(join(tmpdir(), 'issue298-raw-json-http-'))
let postgres: Awaited<ReturnType<typeof postgresRuntimeFixture>> | undefined
const nativeFetch = globalThis.fetch
const token = 'synthetic-raw-archive-token'
const batchInput = { source: 'queryBusList', name: '合成', rdjb: ['2'], pageSize: 1 }
const input = { ...batchInput, rawDataVersion: 1 }
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
  if (result.structuredContent) expect(result.content).toContainEqual({ type: 'text', text: JSON.stringify(result.structuredContent) })
  return result.structuredContent ?? JSON.parse((result.content as any)[0].text)
}
async function waitForBatch(batchId: string) {
  await expect.poll(async () => (await call('get_platform_batch', { batchId })).state).toMatch(/^(done|failed)$/)
}

function snapshotBusinessData() {
  return execFileSync(join(postgres!.env.NUXT_POSTGRES_BIN, 'pg_dump'), [
    '--dbname', postgres!.url, '--data-only', '--schema', 'business',
    '--restrict-key', 'RawArchiveTestFixture',
  ], { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024 })
}

beforeAll(async () => {
  postgres = await postgresRuntimeFixture({ dir })
  vi.stubEnv('NUXT_POSTGRES_DIRECTORY_URL', postgres.url)
  vi.stubEnv('NUXT_DB_READONLY', '0')
  vi.stubEnv('MIIT_COOKIE', ''); vi.stubEnv('MIIT_COOKIE_FILE', '')
  await updatePostgresCredentialState(usePostgresDirectoryDb(), { 'sme-roster.miitCookie': 'sid=synthetic-raw-wire-secret' })
  for (const [key, value] of Object.entries({ defineEventHandler, readBody, setHeader, setResponseStatus, getQuery, getHeader, getRouterParam, createError, useRuntimeConfig: () => ({ filesDir: dir, apiToken: token }) })) vi.stubGlobal(key, value)
  vi.doMock('@nuxtjs/mcp-toolkit/server', () => ({ defineMcpTool: (value: unknown) => value }))
  for (const path of ['query_platform', 'preflight_roster_batch', 'save_roster_batch', 'list_platform_queries', 'get_platform_batch', 'get_platform_batch_item', 'submit_platform_batch', 'retry_platform_batch']) tools.push((await import(`../../../layers/sme-roster/server/mcp/tools/${path}.ts`)).default)
  const queryRoute = (await import('../../../layers/sme-roster/server/api/platform/query.post')).default
  const readRoute = (await import('../../../layers/sme-roster/server/api/platform/queries.get')).default
  const router = createRouter().post('/api/platform/query', queryRoute).get('/api/platform/queries', readRoute)
  const { createRosterImportHandler } = await import('../../../layers/sme-roster/server/utils/roster-import-route')
  for (const action of ['preflight', 'commit'] as const) router.post(`/api/roster/import/${action}`, createRosterImportHandler(action))
  const { createPlatformBatchRoute } = await import('../../../layers/sme-roster/server/utils/platform-batch-route')
  router.post('/api/platform/batches', createPlatformBatchRoute('submit'))
  const listener = toNodeListener(createApp().use(router))
  server = createServer((req, res) => {
    if (req.url !== '/mcp') { listener(req, res); return }
    const mcp = new McpServer({ name: 'issue298-public-tool-fixture', version: '1' })
    const mcpAuth = resolveMcpAuth({ given: readMcpToken({ authorization: req.headers.authorization }), configured: token })
    for (const tool of tools.filter(tool => !tool.enabled || tool.enabled({ context: { mcpAuth } }))) mcp.registerTool(tool.name, { inputSchema: tool.inputSchema, ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}) }, async (args: Record<string, unknown>) => {
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
}, 60_000)
afterAll(async () => {
  await stopPostgresJobs(); await client?.close()
  for (const transport of transports) await transport.close()
  if (server) await new Promise<void>(resolve => server.close(() => resolve()))
  await closePostgresDirectoryDb()
  postgres?.close()
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true })
})
const plain = Object.fromEntries(Object.entries(typed).filter(([key]) => !['__proto__', 'constructor'].includes(key)))
const cases = [plain, { id: 'same', qymc: '合成', x: '', n: '1', b: 'true', o: '{"a":1}', arr: '[null,false,2,{"unknown":true}]' }, typed]
it.each([0, 1, 2])('real HTTP or MCP exposes raw envelope case %i live and reads extracted history with stable IDs', async index => {
  const row = cases[index]
  const discovered = await client.listTools()
  expect(discovered.tools.find(t => t.name === 'query_platform')!.inputSchema.properties).toHaveProperty('rawDataVersion')
  expect(discovered.tools.find(t => t.name === 'list_platform_queries')!.inputSchema.properties).not.toHaveProperty('includeRawResponse')
  expect(discovered.tools.map(t => t.name)).not.toContain('get_platform_query_evidence')
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
  const beforeReplay = snapshotBusinessData()
  const replay: any = index === 0 ? await (await post('/api/roster/import/commit', request)).json() : await call('save_roster_batch', request)
  expect(replay).toEqual(saved)
  expect(snapshotBusinessData().equals(beforeReplay), 'durable business data remains unchanged').toBe(true)
  const queryId = Number(saved.items.find((item: any) => item.kind === 'platform_query').ref.replace('query:', ''))
  const history: any = index === 0 ? await (await nativeFetch(`${base}/api/platform/queries?queryId=${queryId}`)).json() : await call('list_platform_queries', { queryId })
  expect(history.rows).toHaveLength(1)
  const archived = history.rows[0]
  expect(archived.query).toMatchObject({ id: queryId, relationCount: 1 })
  expect(archived.relations[0]).toMatchObject({ relationKey: row.id, sourceRdjb: '2', sourcePage: 1 })
  expect(archived.query).not.toHaveProperty('rawResponse')
  expect(archived.query.collectionEvidence).not.toHaveProperty('rawData')
  expect(archived.query.collectionEvidence).not.toHaveProperty('rows')
  expect(archived.relations[0].rawFields?.arr).not.toBeInstanceOf(Array)
  expect(archived.relations.map((relation: any) => relation.id)).toEqual(saved.items.find((item: any) => item.kind === 'platform_query').detail.relations)
  const originalQuery = request.payload.platformQueries[0]!
  const { rawResponse: _rawResponse, collectionEvidence: _collectionEvidence, relations, ...coordinates } = originalQuery
  const reused = { ...request, idempotencyKey: `${request.idempotencyKey}-reuse`, payload: { platformQueries: [{
    ...coordinates, reuseExisting: true, relations: relations?.map(({ sequenceNo, relationKey }) => ({ sequenceNo, relationKey })),
  }] } }
  const reuse: any = index === 0 ? await (await post('/api/roster/import/commit', reused)).json() : await call('save_roster_batch', reused)
  expect(reuse.status).toBe('committed')
  expect(reuse.items.find((item: any) => item.kind === 'platform_query').ref).toBe(`query:${queryId}`)
  const exactReplay = { ...request, idempotencyKey: `${request.idempotencyKey}-offline` }
  const conflict: any = index === 0 ? await (await post('/api/roster/import/commit', exactReplay)).json() : await call('save_roster_batch', exactReplay)
  expect(conflict).toMatchObject({ status: 'failed', items: [expect.objectContaining({ error: expect.objectContaining({ code: 'query_replay_offline' }) })] })
  const after: any = await call('list_platform_queries', { queryId })
  expect(after.rows).toEqual(history.rows)
})
it('real HTTP submission and MCP item retain typed batch business rows within the structured-result budget', async () => {
  const businessRow = { id: 'batch-one', qymc: '合成', rdjb: 2, rddqrq: '2027', cszt: '已认定', sqsj: '2026-07-03', n: 0, flag: false, nested: { blank: '', absent: null }, whitespace: ' ' }
  raw = source({ ...businessRow, blank: '', nil: null, rawFields: { rawTransportOnly: 'remove-row-copy' }, rawResponse: 'remove-response-copy' }) + ' '.repeat(70000)
  const invalid = await post('/api/platform/batches', { items: [{ query: input }] })
  expect(invalid.status).toBe(400)
  const response = await post('/api/platform/batches', { items: [{ query: batchInput }], limits: { maxResultBytes: 65536 } })
  expect(response.status).toBe(202)
  const submitted: any = await response.json()
  await waitForBatch(submitted.batchId)
  const item: any = await call('get_platform_batch_item', { batchId: submitted.batchId, itemId: submitted.itemIds[0] })
  expect(item).toMatchObject({ status: 'success', segments: [{
    rows: [{ id: 'batch-one', rdjb: '2', rddqrq: '2027', cszt: '已认定', sqsj: '2026-07-03', n: '0', flag: 'false', nested: '{"blank":"","absent":null}', whitespace: ' ' }],
    dataRows: [businessRow], pages: [{ source: 'queryBusList', rdjb: '2', page: 1, status: 'success', fetchedCount: 1 }],
  }] })
  expect(item.segments[0]).not.toHaveProperty('rawData')
  expect(item.segments[0].rows[0]).not.toHaveProperty('blank')
  expect(item.segments[0].rows[0]).not.toHaveProperty('nil')
  const persisted = await usePostgresDirectoryDb().$client.query('SELECT payload FROM business.platform_batch_segment WHERE job_id = $1', [submitted.batchId])
  const stored = JSON.parse(persisted.rows[0].payload)
  expect(stored).not.toHaveProperty('rows')
  expect(stored.dataRows).toEqual([businessRow])
  expect(JSON.stringify(item)).not.toMatch(/remove-row-copy|remove-response-copy/)
  const savedBatch = snapshotBusinessData()
  expect(savedBatch.includes(Buffer.from('remove-row-copy'))).toBe(false)
  expect(savedBatch.includes(Buffer.from('remove-response-copy'))).toBe(false)

  raw = source({ id: 'large', qymc: '宽'.repeat(70000) })
  const limited: any = await (await post('/api/platform/batches', { items: [{ query: batchInput }], limits: { maxResultBytes: 65536 } })).json()
  await waitForBatch(limited.batchId)
  const rejected: any = await call('get_platform_batch_item', { batchId: limited.batchId, itemId: limited.itemIds[0] })
  expect(rejected).toMatchObject({ status: 'partial', segments: [{ error: { code: 'safety_limit' }, rows: [], dataRows: [] }], unfinished: [{ page: 1 }] })
  expect(Buffer.byteLength(JSON.stringify(rejected))).toBeLessThan(65536)
})

it('existing strict HTTP archive body rejects prototype-named keys atomically while MCP retains them', async () => {
  raw = source(typed)
  const result: any = await call('query_platform', input)
  const before = snapshotBusinessData()
  const rejected = await post('/api/roster/import/commit', { idempotencyKey: 'http-prototype-boundary', sourceKind: 'alias_evidence', sourceIdentity: 'issue298-synthetic', payload: { platformQueries: [recognizedResultToImport(result)] } })
  expect(rejected.status).toBe(400)
  expect(snapshotBusinessData().equals(before), 'durable business data remains unchanged').toBe(true)
})

it.each(['HTTP', 'MCP'])('real %s query rejects a sensitive source without leaking raw data or writing business state', async transport => {
  raw = source({ id: 'secret', unknown: { accessToken: 'never-return-this-value' } })
  const before = snapshotBusinessData()
  const result: any = transport === 'HTTP' ? await (await post('/api/platform/query', input)).json() : await call('query_platform', input)
  expect(result).toMatchObject({ status: 'failed', error: { code: 'sensitive_response' }, rawData: { rows: [], pages: [] } })
  expect(JSON.stringify(result)).not.toContain('never-return-this-value')
  expect(snapshotBusinessData().equals(before), 'durable business data remains unchanged').toBe(true)
})

it('real MCP batch retry appends typed source segments and retains the accepted checkpoint and original times', async () => {
  pageBodies = new Map([[1, source({ id: 'first', n: 1 }, 1, 2)], [2, source({ id: 'second', n: '1' }, 2, 2)]])
  try {
    const receipt: any = await call('submit_platform_batch', { items: [{ query: { ...batchInput, maxRequests: 1 } }] })
    await waitForBatch(receipt.batchId)
    const prior: any = await call('get_platform_batch_item', { batchId: receipt.batchId, itemId: receipt.itemIds[0] })
    expect(prior).toMatchObject({ status: 'partial', segments: [{ dataRows: [{ id: 'first', n: 1 }], pages: [{ page: 1 }] }], unfinished: [{ page: 2 }] })
    const retried: any = await call('retry_platform_batch', { batchId: receipt.batchId, itemIds: receipt.itemIds })
    expect(retried).toMatchObject({ batchId: receipt.batchId, itemIds: receipt.itemIds })
    await waitForBatch(receipt.batchId)
    const after: any = await call('get_platform_batch_item', { batchId: receipt.batchId, itemId: receipt.itemIds[0] })
    expect(after.status).toBe('success')
    expect(after.segments[0]).toEqual(prior.segments[0])
    expect(after.segments[1]).toMatchObject({ dataRows: [{ id: 'second', n: '1' }], pages: [{ page: 2, status: 'success' }] })
    expect(after.segments[1]).not.toHaveProperty('rawData')
  } finally { pageBodies = undefined }
})

it('returns extracted history for a live result with a large original page', async () => {
  raw = source({ id: 'large-read', x: null, n: 1, unknown: { archiveOnly: 'large-offline-marker' } }) + ' '.repeat(4194304)
  const result: any = await (await post('/api/platform/query', input)).json()
  expect(result.status).toBe('success')
  expect(result.rawData.pages[0].body).toBe(raw)
  const saved: any = await (await post('/api/roster/import/commit', { idempotencyKey: 'large-read-envelope', sourceKind: 'alias_evidence', sourceIdentity: 'issue298-synthetic', payload: { platformQueries: [recognizedResultToImport(result)] } })).json()
  expect(saved.status).toBe('committed')
  const queryId = Number(saved.items.find((item: any) => item.kind === 'platform_query').ref.replace('query:', ''))
  const response = await nativeFetch(`${base}/api/platform/queries?queryId=${queryId}`)
  expect(response.status).toBe(200)
  const stored = await response.json()
  expect(stored).toMatchObject({ total: 1, rows: [{ query: { id: queryId }, relations: [{ relationKey: 'large-read', sourcePage: 1 }] }] })
  expect(JSON.stringify(stored)).not.toContain('large-offline-marker')
})

const htmlReviewCases = [
  ['spec_unicode_script', '<script>window.config={"other":"synthetic-raw-wire-\\u0073ecret"}</script>'],
  ['hex_script', '<script>window.config={"other":"synthetic-raw-wire-\\x73ecret"}</script>'],
  ['standards_csrf', '<input type="hidden" name="csrfToken" value="synthetic-review-other-token">'],
  ['standards_username', '<INPUT NAME=username VALUE=synthetic-review-user>'],
  ['entity_form', '<input name="csrf&#84;oken" value="synthetic-review-other-token">'],
  ['single_quote_form', "<textarea name='username'>synthetic-review-user</textarea>"],
  ['encoded_text', '<p>%73ynthetic-raw-wire-secret</p>'],
]
for (const transport of ['HTTP', 'MCP']) it.each(htmlReviewCases)(`real ${transport} refuses the entire sensitive HTML source case %s`, async (_label, prefix) => {
  raw = `${prefix}<script>(function(data){})(${source({ id: 'safe' }).trim()});</script>`
  const result = transport === 'HTTP' ? await (await post('/api/platform/query', input)).json() : await call('query_platform', input)
  expect(result).toMatchObject({ status: 'failed', completeness: 'partial', fetchedCount: 0, error: { code: 'sensitive_response' }, rawData: { version: 1, rows: [], pages: [] }, pages: [{ status: 'failed', fetchedCount: 0 }], unfinished: [{ source: 'queryBusList', rdjb: '2', page: 1 }] })
  expect(JSON.stringify(result)).not.toMatch(/synthetic-review-other-token|synthetic-review-user|synthetic-raw-wire-secret|window.config/)
})

it.each(['HTTP', 'MCP'])('real %s accepts verifiable HTML and retains its exact original source', async transport => {
  raw = `<html><body><script type="application/json">${source({ id: 'safe-html', x: null, n: 1 }).trim()}</script></body></html>`
  const result = transport === 'HTTP' ? await (await post('/api/platform/query', input)).json() : await call('query_platform', input)
  expect(result).toMatchObject({ status: 'success', rawData: { version: 1, rows: [{ id: 'safe-html', x: null, n: 1 }], pages: [{ format: 'html-script', body: raw }] } })
})

it.each(['HTTP', 'MCP'])('real %s archives platform scripts and markup unchanged as non-executed data', async transport => {
  raw = `<script src="synthetic-unknown.js"></script><div data-platform="layout" style="display:block"></div><script>(function(data){throw new Error('must not execute')})(${source({ id: 'safe-dwz', n: 1 }).trim()});</script>`
  const result = transport === 'HTTP' ? await (await post('/api/platform/query', input)).json() : await call('query_platform', input)
  expect(result).toMatchObject({ status: 'success', rawData: { version: 1, rows: [{ id: 'safe-dwz', n: 1 }], pages: [{ format: 'html-script', body: raw }] } })
})

it.each(['HTTP', 'MCP'])('real %s table raw observation keeps own prototype keys while the old string rows stay compatible', async transport => {
  raw = '<table name="applyGrid"><th id="id">ID</th><th id="__proto__">raw</th><th id="constructor">ctor</th><tbody><tr><td>safe</td><td>original-cell</td><td>own</td></tr></tbody></table>'
  const q = { source: 'queryList', name: '合成', rawDataVersion: 1, maxRequests: 1 }
  const result = transport === 'HTTP' ? await (await post('/api/platform/query', q)).json() : await call('query_platform', q)
  const expected = JSON.parse('{"id":"safe","__proto__":"original-cell","constructor":"own"}')
  expect(result).toMatchObject({ status: 'partial', fetchedCount: 1, rows: [{ id: 'safe', constructor: 'own' }], rawData: { version: 1, rows: [expected], pages: [{ format: 'html-table', body: raw }] } })
  expect(Object.hasOwn(result.rawData.rows[0], '__proto__')).toBe(true)
})

it('real MCP batch retains the first safe page but never accepts the second sensitive original', async () => {
  const first = `<script>(function(data){})(${source({ id: 'safe-first', n: 1 }, 1, 2).trim()});</script>`
  const second = `<input name="csrfToken" value="synthetic-review-later-token"><script>(function(data){})(${source({ id: 'unsafe-second' }, 2, 2).trim()});</script>`
  pageBodies = new Map([[1, first], [2, second]])
  try {
    const receipt = await call('submit_platform_batch', { items: [{ query: batchInput }] })
    await waitForBatch(receipt.batchId)
    const item = await call('get_platform_batch_item', { batchId: receipt.batchId, itemId: receipt.itemIds[0] })
    expect(item).toMatchObject({ status: 'partial', segments: [{ fetchedCount: 1, error: { code: 'sensitive_response' }, dataRows: [{ id: 'safe-first', n: 1 }] }], unfinished: [{ page: 2 }] })
    expect(item.segments[0]).not.toHaveProperty('rawData')
    expect(item.segments[0].pages).toEqual([expect.objectContaining({ page: 1, status: 'success', fetchedCount: 1 }), expect.objectContaining({ page: 2, status: 'failed', fetchedCount: 0 })])
    expect(JSON.stringify(item)).not.toContain('synthetic-review-later-token')
  } finally { pageBodies = undefined }
})
