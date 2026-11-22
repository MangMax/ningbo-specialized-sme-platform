import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createApp, createRouter, toNodeListener, defineEventHandler, readBody, setHeader, setResponseStatus, createError, getQuery } from 'h3'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { readMcpToken, resolveMcpAuth } from '../../../layers/core/server/utils/mcp-auth'
import { asc, eq, sql } from 'drizzle-orm'
import { closePostgresDirectoryDb, usePostgresDirectoryDb } from '../../../db/postgresql/client'
import { platformCollection, platformExportBatch } from '../../../db/postgresql/platform-tables'
import { importBatch, importReceipt } from '../../../db/postgresql/import-tables'
import { stopPostgresJobs } from '../../../layers/core/server/utils/postgres-jobs'
import { postgresRuntimeFixture } from '../../support/postgres-fixture.mjs'
import { runPlatformLiveQuery } from '../../../layers/sme-roster/server/utils/platform-live-query'
import { recognizedResultToImport } from '../../../layers/sme-roster/lib/platform/recognized-evidence'
import type { RosterImportRequest, RosterImportPlatformQuery, RosterImportExportSnapshot } from '../../../layers/sme-roster/lib/roster-import-client'

const realTransport = process.env.ISSUE300_REAL_TRANSPORT === '1'
const protocol = realTransport ? 'MCP' : 'HTTP'
const dir = mkdtempSync(join(tmpdir(), 'source-replay-'))
const transports = new Set<StreamableHTTPServerTransport>()
let mcpClient: Client
let postgres: Awaited<ReturnType<typeof postgresRuntimeFixture>> | undefined
let db: ReturnType<typeof usePostgresDirectoryDb>
const token = 'synthetic-issue300'
let server: ReturnType<typeof createServer>, base: string, serial = 0
const metadata: Record<string, any> = {}
beforeAll(async () => {
  postgres = await postgresRuntimeFixture({ dir })
  vi.stubEnv('NUXT_POSTGRES_DIRECTORY_URL', postgres.url)
  vi.stubEnv('NUXT_DB_READONLY', '0')
  db = usePostgresDirectoryDb()
  for (const [key, value] of Object.entries({ defineEventHandler, readBody, setHeader, setResponseStatus, createError, getQuery, useRuntimeConfig: () => ({ filesDir: dir, apiToken: token }) })) vi.stubGlobal(key, value)
  const router = createRouter()
  for (const action of ['preflight', 'commit'] as const) {
    vi.stubGlobal('defineRouteMeta', (value: any) => { metadata[action] = value.openAPI })
    router.post(`/api/roster/import/${action}`, (await import(`../../../layers/sme-roster/server/api/roster/import/${action}.post.ts`)).default)
  }
  vi.stubGlobal('defineRouteMeta', () => {})
  router.get('/api/platform/queries', (await import('../../../layers/sme-roster/server/api/platform/queries.get')).default)
  const listener = toNodeListener(createApp().use(router))
  const tools: any[] = []
  if (realTransport) {
    vi.doMock('@nuxtjs/mcp-toolkit/server', () => ({ defineMcpTool: (value: unknown) => value }))
    for (const name of ['preflight_roster_batch', 'save_roster_batch', 'list_platform_queries']) tools.push((await import(`../../../layers/sme-roster/server/mcp/tools/${name}.ts`)).default)
  }
  server = createServer((req, res) => {
    if (req.url !== '/mcp') { listener(req, res); return }
    const mcp = new McpServer({ name: 'issue300-isolated', version: '1' })
    const mcpAuth = resolveMcpAuth({ given: readMcpToken({ authorization: req.headers.authorization }), configured: token })
    for (const tool of tools.filter(tool => !tool.enabled || tool.enabled({ context: { mcpAuth } }))) mcp.registerTool(tool.name, { description: tool.description, inputSchema: tool.inputSchema }, async (args: Record<string, unknown>) => {
      const value = await tool.handler(args)
      return value.content ? value : { ...value, content: [{ type: 'text', text: JSON.stringify(value.structuredContent ?? value) }] }
    })
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    transports.add(transport)
    res.on('close', () => { transports.delete(transport); void mcp.close() })
    void mcp.connect(transport).then(() => transport.handleRequest(req, res)).catch(() => { res.statusCode = 500; res.end() })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  if (realTransport) {
    mcpClient = new Client({ name: 'issue300', version: '1' })
    await mcpClient.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }))
  }
}, 60_000)
afterAll(async () => {
  await stopPostgresJobs()
  await mcpClient?.close()
  for (const transport of transports) await transport.close()
  if (server) await new Promise<void>(resolve => server.close(() => resolve()))
  await closePostgresDirectoryDb()
  postgres?.close()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  rmSync(dir, { recursive: true, force: true })
})
function query(): RosterImportPlatformQuery {
  return { interface: 'business_list', queryKey: `name:synthetic-${serial++}`, rdjb: '2', titleCode: 'specialized_sme', queriedAt: '2026-10-01T00:00:00Z', status: 'success', rawResponse: '{"original":true}', relations: [{ sequenceNo: 1, relationKey: `row-${serial}`, nameRaw: '合成', rawFields: { id: `row-${serial}`, qymc: '合成', n: 1 } }] }
}
function snapshot(): RosterImportExportSnapshot {
  return { titleCode: 'specialized_sme', year: 2025, sha256: `synthetic-${serial++}`, originalFilename: '合成.xlsx', collectedOn: '2026-10-01', rows: [{ sourceRowNo: 2, nameRaw: '合成', rawFields: { name: '合成', unknown: null, n: 1 } }] }
}
function request(payload: RosterImportRequest['payload']): RosterImportRequest {
  return { idempotencyKey: `issue300-${serial++}`, sourceKind: payload.platformQueries ? 'platform_archive' : 'platform_export', sourceIdentity: 'synthetic-issue300', payload }
}
async function submit(action: 'preflight' | 'commit', body: RosterImportRequest) {
  if (realTransport) {
    const result = await mcpClient.callTool({ name: action === 'commit' ? 'save_roster_batch' : 'preflight_roster_batch', arguments: body as any })
    expect(result.isError).not.toBe(true)
    return result.structuredContent ?? JSON.parse((result.content as any)[0].text)
  }
  const response = await fetch(`${base}/api/roster/import/${action}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) })
  expect(response.status).toBe(200)
  return response.json()
}
async function readQuery(queryId: number) {
  if (realTransport) {
    const result = await mcpClient.callTool({ name: 'list_platform_queries', arguments: { queryId } })
    expect(result.isError).not.toBe(true)
    return result.structuredContent ?? JSON.parse((result.content as any)[0].text)
  }
  const response = await fetch(`${base}/api/platform/queries?queryId=${queryId}`)
  expect(response.status).toBe(200)
  return response.json()
}
const replayTables = [
  'platform_collection',
  'platform_collection_page',
  'platform_observation_assignment',
  'platform_business_record',
  'platform_business_record_version',
  'platform_business_observation',
  'platform_export_batch',
  'platform_export_row',
  'record_correspondence',
  'record_correspondence_audit',
]

async function state() {
  return db.transaction(async tx => {
    const entries = []
    for (const table of replayTables) {
      const result = await tx.execute(sql`SELECT * FROM business.${sql.identifier(table)} AS evidence ORDER BY to_jsonb(evidence)::text`)
      entries.push([table, result.rows] as const)
    }
    return Object.fromEntries(entries)
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' })
}

function knownQueries(queryKey: string) {
  return db.select({ id: platformCollection.publicId })
    .from(platformCollection)
    .where(eq(platformCollection.queryKey, queryKey))
}

async function rejectAtomically(body: RosterImportRequest, code: string) {
  const before = await state()
  const plan = await submit('preflight', body)
  expect(plan.preflight.conflicts).toEqual(expect.arrayContaining([expect.objectContaining({ error: expect.objectContaining({ code }) })]))
  expect(await state()).toEqual(before)
  const result = await submit('commit', body)
  expect(result.status).toBe('failed')
  expect(result.summary).toMatchObject({ written: 0, skipped: 0 })
  expect(result.items).toEqual(expect.arrayContaining([expect.objectContaining({ ok: false, error: expect.objectContaining({ code }) })]))
  expect(await state()).toEqual(before)
}

function reference(q: RosterImportPlatformQuery): RosterImportPlatformQuery {
  return { interface: q.interface, queryKey: q.queryKey, rdjb: q.rdjb, queriedAt: q.queriedAt, reuseExisting: true }
}

const changes: [string, (q: RosterImportPlatformQuery) => void][] = [
  ['response', q => { q.rawResponse = '{"changed":true}' }],
  ['collection', q => { q.collectionEvidence = { source: 'businessList' } as any }],
]
it.each(changes)(`${protocol} rejects query %s changes across keys and preserves sibling atomicity`, async (_name, mutate) => {
  const original = query()
  expect((await submit('commit', request({ platformQueries: [original] }))).status).toBe('committed')
  const changed = structuredClone(original); mutate(changed)
  await rejectAtomically(request({ platformQueries: [query(), changed] }), 'query_replay_offline')
})
it.each([
  ['name', (s: RosterImportExportSnapshot) => { s.rows[0]!.nameRaw = '异名' }],
  ['raw', (s: RosterImportExportSnapshot) => { s.rows[0]!.rawFields!.n = '1' }],
  ['location', (s: RosterImportExportSnapshot) => { s.rows[0]!.district = '鄞州区' }],
] as const)(`${protocol} rejects export row %s changes with a valid query sibling`, async (_name, mutate) => {
  const original = snapshot()
  expect((await submit('commit', request({ exportSnapshot: original }))).status).toBe('committed')
  const changed = structuredClone(original); mutate(changed)
  await rejectAtomically(request({ platformQueries: [query()], exportSnapshot: changed }), 'export_row_payload_conflict')
})
it(`${protocol} reuses stable collection references across keys, returns the original same-key receipt, and permits distinct observation times and new snapshot bytes`, async () => {
  const q = query(), s = snapshot(), body = request({ platformQueries: [q], exportSnapshot: s })
  const saved = await submit('commit', body); expect(saved.status).toBe('committed')
  const before = await state()
  const queryId = Number(saved.items.find((item: any) => item.kind === 'platform_query').ref.slice(6))
  const read = await readQuery(queryId)
  expect(read.rows[0].query).toMatchObject({ id: queryId, queryKey: q.queryKey, status: q.status, titleCode: q.titleCode })
  expect(read.rows[0].query).not.toHaveProperty('rawResponse')
  const history = JSON.stringify(read.rows[0])
  expect(history).not.toMatch(/"conditionFacts"|"unfinishedPositions"|"witnesses"/)
  expect(read.rows[0].relations[0]).toMatchObject({ sequenceNo: 1 })
  expect(read.rows[0].relations[0].rawFields).toMatchObject({ qymc: '合成' })
  expect(await submit('commit', body)).toEqual(saved)
  const copy = request(structuredClone(body.payload)); copy.payload.platformQueries = [{ ...reference(q), relations: [{ sequenceNo: 1 }] }]; copy.payload.exportSnapshot!.collectedOn = '2026-10-02'; copy.payload.exportSnapshot!.originalFilename = '重命名.xlsx'
  const plan = await submit('preflight', copy); expect(plan.preflight).toMatchObject({ add: 0, update: 0, conflicts: [] })
  const reused = await submit('commit', copy)
  expect(reused.status).toBe('committed'); expect(reused.summary).toMatchObject({ written: 0, skipped: 2 })
  expect(await state()).toEqual(before)
  q.queriedAt = '2026-10-02T00:00:00Z'; s.sha256 += '-new'
  expect((await submit('commit', request({ platformQueries: [q], exportSnapshot: s }))).status).toBe('committed')
  const batches = await db.select().from(platformExportBatch).orderBy(asc(platformExportBatch.id))
  expect(batches.at(-1)!.replacedBatchId).toBe(batches.at(-2)!.id)
})
it(`${protocol} new native collections require original evidence and explicit reuse cannot create missing sources`, async () => {
  const q = query(); delete q.rawResponse
  await rejectAtomically(request({ platformQueries: [reference(q)] }), 'query_reuse_missing')
  await rejectAtomically(request({ platformQueries: [q] }), 'query_source_required')
})
it(`${protocol} ordinary query and snapshot replays cannot add new sequence numbers or silently omit rows`, async () => {
  const q = query(), s = snapshot()
  expect((await submit('commit', request({ platformQueries: [q], exportSnapshot: s }))).status).toBe('committed')
  const appended = { ...reference(q), relations: [{ sequenceNo: 2, relationKey: 'extra' }] }
  await rejectAtomically(request({ platformQueries: [appended] }), 'query_relation_set_conflict')
  await rejectAtomically(request({ platformQueries: [{ ...q, relations: [] }] }), 'query_replay_offline')
  const extra = structuredClone(s); extra.rows.push({ sourceRowNo: 3, nameRaw: 'extra' })
  await rejectAtomically(request({ exportSnapshot: extra }), 'export_row_set_conflict')
  await rejectAtomically(request({ exportSnapshot: { ...s, rows: [] } }), 'export_row_set_conflict')
})
it(`${protocol} preflight rejects different metadata for one query identity inside a single payload`, async () => {
  const q = query(), changed = { ...q, rawResponse: 'different' }
  await rejectAtomically(request({ platformQueries: [q, changed] }), 'query_payload_conflict')
})
it(`${protocol} concurrent different-key submissions keep one immutable source and reject its conflicting contender`, async () => {
  const q = query()
  const responses = await Promise.all([submit('commit', request({ platformQueries: [q] })), submit('commit', request({ platformQueries: [{ ...q, rawResponse: 'competing' }] }))])
  expect(responses.map(r => r.status).sort()).toEqual(['committed', 'failed'])
  expect(responses.find(r => r.status === 'failed').items).toEqual(expect.arrayContaining([expect.objectContaining({ error: expect.objectContaining({ code: 'query_replay_offline' }) })]))
  expect(await knownQueries(q.queryKey)).toHaveLength(1)
})
it(`${protocol} transaction failure rolls back a preceding query and preserves old references, then the same key can retry`, async () => {
  const q = query(), s = snapshot(), body = request({ platformQueries: [q], exportSnapshot: s })
  const before = await state()
  await db.execute(sql`
    CREATE FUNCTION business.synthetic_replay_fault() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'synthetic issue300 fault';
    END;
    $$
  `)
  await db.execute(sql`
    CREATE TRIGGER synthetic_replay_fault BEFORE INSERT ON business.platform_export_row
    FOR EACH ROW EXECUTE FUNCTION business.synthetic_replay_fault()
  `)
  try {
    const result = await submit('commit', body)
    expect(result.status).toBe('failed')
    expect(result.summary).toMatchObject({ written: 0, skipped: 0, failed: 2 })
    expect(result.error).toContain('已整批回滚')
    expect(result.items).toEqual([
      expect.objectContaining({ kind: 'platform_query', ok: false, error: expect.objectContaining({ code: 'commit_rolled_back' }) }),
      expect.objectContaining({ kind: 'export_batch', ok: false, error: expect.objectContaining({ code: 'export_write_failed' }) }),
    ])
    expect(JSON.stringify(result)).not.toContain('synthetic issue300 fault')
    expect(await state()).toEqual(before)
    const [receipt] = await db.select({ batchStatus: importBatch.status, status: importReceipt.status })
      .from(importReceipt).innerJoin(importBatch, eq(importBatch.id, importReceipt.batchId))
      .where(eq(importBatch.idempotencyKey, body.idempotencyKey))
    expect(receipt).toEqual({ batchStatus: 'failed', status: 'failed' })
  } finally {
    await db.execute(sql`DROP TRIGGER synthetic_replay_fault ON business.platform_export_row`)
    await db.execute(sql`DROP FUNCTION business.synthetic_replay_fault()`)
  }
  expect((await submit('commit', body)).status).toBe('committed')
})

it.each(['failed', 'partial'] as const)(`${protocol} preserves existing %s collection status when omitted and rejects explicit replacement through stable references`, async status => {
  const q = { ...query(), status, failureReason: 'original collection incomplete' }
  expect((await submit('commit', request({ platformQueries: [q] }))).status).toBe('committed')
  const before = await state()
  const existing = reference(q)
  expect((await submit('preflight', request({ platformQueries: [existing] }))).preflight.conflicts).toEqual([])
  expect((await submit('commit', request({ platformQueries: [existing] }))).status).toBe('committed')
  await rejectAtomically(request({ platformQueries: [{ ...existing, status: 'success' }] }), 'query_payload_conflict')
  await rejectAtomically(request({ platformQueries: [{ ...existing, titleCode: null }] }), 'query_payload_conflict')
  await rejectAtomically(request({ platformQueries: [{ ...existing, rawResponse: 'null' }] }), 'query_replay_offline')
  await rejectAtomically(request({ platformQueries: [{ ...existing, relations: [{ sequenceNo: 2 }] }] }), 'query_relation_set_conflict')
  await rejectAtomically(request({ platformQueries: [{ ...existing, relations: [{ sequenceNo: 1, relationKey: 'different' }] }] }), 'observation_payload_conflict')
  expect(await state()).toEqual(before)
})

it(`${protocol} discovery explains the existing reuseExisting field and immutable replay boundary`, async () => {
  for (const action of ['preflight', 'commit']) expect(metadata[action].requestBody.content['application/json'].schema.properties.payload.properties.platformQueries.items.properties.reuseExisting).toMatchObject({ type: 'boolean', const: true })
  if (realTransport) for (const tool of (await mcpClient.listTools()).tools.filter(tool => ['preflight_roster_batch', 'save_roster_batch'].includes(tool.name))) expect(tool.description).toContain('reuseExisting:true')
})
it(`${protocol} preflight and commit reject adding a sequence through another same-payload query`, async () => {
  const q = query(), appended = { ...q, relations: [{ sequenceNo: 2, rawFields: { id: 'extra' } }] }
  await rejectAtomically(request({ platformQueries: [q, appended] }), 'query_relation_set_conflict')
})

it(`${protocol} recognized typed envelope remains immutable while omitted status and title are references to the original collection`, async () => {
  const row = { id: `recognized-${serial++}`, qymc: '合成', number: 1, typedNull: null }
  const evidence = await runPlatformLiveQuery({ source: 'queryBusList', name: '合成', rdjb: ['2'], rawDataVersion: 1, pageSize: 1 }, {
    cookie: 'sid=synthetic', transport: { fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ zrarData: { grid: { businessGrid: { pageSet: [row], page: 1, pageSize: 1, maxCount: 1, maxPage: 1 } } } }) }) },
  })
  expect(evidence.status).toBe('success')
  const q = recognizedResultToImport(evidence)
  const saved = await submit('commit', request({ platformQueries: [q] })); expect(saved.status).toBe('committed')
  const before = await state()
  const minimal = { interface: q.interface, queryKey: q.queryKey, rdjb: q.rdjb, queriedAt: q.queriedAt, reuseExisting: true as const }
  expect((await submit('commit', request({ platformQueries: [minimal] }))).status).toBe('committed')
  await rejectAtomically(request({ platformQueries: [{ ...minimal, status: 'failed' }] }), 'query_payload_conflict')
  const changed = structuredClone(q); changed.collectionEvidence!.completedAt = '2099-01-01T00:00:00Z'
  await rejectAtomically(request({ platformQueries: [changed] }), 'query_replay_offline')
  await rejectAtomically(request({ platformQueries: [{ ...minimal, relations: [{ sequenceNo: 1, rawFields: { ...row, typedNull: 'null' } }] }] }), 'query_replay_offline')
  expect(await state()).toEqual(before)
  const read = await readQuery(Number(saved.items[0].ref.slice(6)))
  const metadata = read.rows[0].query.collectionEvidence
  expect(metadata).toMatchObject({ source: 'queryBusList', completeness: 'complete', fetchedCount: 1 })
  expect(metadata).not.toHaveProperty('rawData')
  expect(metadata).not.toHaveProperty('rows')
  expect(read.rows[0].relations[0]).toMatchObject({ sequenceNo: 1, relationKey: row.id })
})
it(protocol + ' accepts stable row references within one payload and from committed collections', async () => {
  for (const stored of [false, true]) for (const subset of [[], [2]]) {
    const original = query()
    original.relations = [1, 2].map(sequenceNo => ({ sequenceNo, relationKey: original.queryKey + '-r' + sequenceNo,
      rawFields: { id: original.queryKey + '-r' + sequenceNo, value: sequenceNo } }))
    if (stored) expect((await submit('commit', request({ platformQueries: [original] }))).status).toBe('committed')
    const existing = { ...reference(original), relations: subset.map(sequenceNo => ({ sequenceNo })) }
    const body = request({ platformQueries: stored ? [existing] : [original, existing] })
    const before = await state()
    expect((await submit('preflight', body)).preflight.conflicts).toEqual([])
    expect(await state()).toEqual(before)
    const result = await submit('commit', body)
    expect(result.status).toBe('committed')
    expect(result.summary.written).toBe(stored ? 0 : 3)
    expect(result.items.at(-1).detail).toMatchObject({ rowsWritten: 0, skipped: subset.length, reuseExisting: true })
    if (stored) expect(await state()).toEqual(before)
    const saved = await knownQueries(original.queryKey)
    expect(saved).toHaveLength(1)
    const read = await readQuery(saved[0]!.id)
    expect(read.rows[0].relations.map((row: { sequenceNo: number }) => row.sequenceNo)).toEqual([1, 2])
  }
})
