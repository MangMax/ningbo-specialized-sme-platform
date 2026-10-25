import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { createApp, createRouter, toNodeListener, defineEventHandler, readBody, setHeader, setResponseStatus, createError, getQuery } from 'h3'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { readMcpToken, resolveMcpAuth } from '../server/utils/mcp-auth'
import { importExecutor } from '../server/utils/import-execution'
import { platformSummaryCache } from '../server/utils/platform-summary-cache'
import { whenIdle } from '../server/utils/job-runner'
import { useDb, schema } from '../db'
import { runPlatformLiveQuery } from '../server/utils/platform-live-query'
import { recognizedResultToImport } from '../lib/platform/recognized-evidence'
import { commitRosterImport, preflightRosterImport } from '../server/utils/roster-import'
import type { RosterImportRequest, RosterImportPlatformQuery, RosterImportExportSnapshot } from '../lib/roster-import-client'

// Exercise the actual route and domain transaction in one process. Off-process
// admission is unchanged and belongs to the separately scheduled transport run.
vi.mock('../server/utils/import-execution', async importOriginal => process.env.ISSUE300_REAL_TRANSPORT === '1' ? await importOriginal() : ({ importExecutor: { execute: async (db: any, action: string, request: any, errors: any, context: any) => action === 'preflight' ? preflightRosterImport(db, request, errors, context) : commitRosterImport(db, request, errors, { ...context, deferCandidateTasks: true }) } }))
const realTransport = process.env.ISSUE300_REAL_TRANSPORT === '1'
const protocol = realTransport ? 'MCP' : 'HTTP'
const dir = mkdtempSync('/tmp/issue300-http-')
const transports = new Set<StreamableHTTPServerTransport>()
let mcpClient: Client
const db = useDb({ dbPath: join(dir, 'test.sqlite') })
const token = 'synthetic-issue300'
let server: ReturnType<typeof createServer>, base: string, serial = 0
const metadata: Record<string, any> = {}
beforeAll(async () => {
  vi.stubEnv('NUXT_DB_PATH', join(dir, 'test.sqlite'))
  for (const [key, value] of Object.entries({ defineEventHandler, readBody, setHeader, setResponseStatus, createError, getQuery, useRuntimeConfig: () => ({ filesDir: dir, apiToken: token }) })) vi.stubGlobal(key, value)
  const router = createRouter()
  for (const action of ['preflight', 'commit'] as const) {
    vi.stubGlobal('defineRouteMeta', (value: any) => { metadata[action] = value.openAPI })
    router.post(`/api/roster/import/${action}`, (await import(`../server/api/roster/import/${action}.post.ts`)).default)
  }
  vi.stubGlobal('defineRouteMeta', () => {})
  router.get('/api/platform/queries', (await import('../server/api/platform/queries.get')).default)
  const listener = toNodeListener(createApp().use(router))
  const tools: any[] = []
  if (realTransport) {
    vi.doMock('@nuxtjs/mcp-toolkit/server', () => ({ defineMcpTool: (value: unknown) => value }))
    for (const name of ['preflight_roster_batch', 'save_roster_batch', 'list_platform_queries']) tools.push((await import(`../server/mcp/tools/${name}.ts`)).default)
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
})
afterAll(async () => {
  if (realTransport) { await whenIdle(); await mcpClient?.close(); for (const transport of transports) await transport.close(); await importExecutor.close() }
  platformSummaryCache.close()
  if (server) await new Promise<void>(resolve => server.close(() => resolve()))
  vi.unstubAllGlobals(); vi.unstubAllEnvs(); db.$client.close(); rmSync(dir, { recursive: true, force: true })
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
    const result = await mcpClient.callTool({ name: 'list_platform_queries', arguments: { queryId, includeRawResponse: true } })
    expect(result.isError).not.toBe(true)
    return result.structuredContent ?? JSON.parse((result.content as any)[0].text)
  }
  const response = await fetch(`${base}/api/platform/queries?queryId=${queryId}&includeRawResponse=true`)
  expect(response.status).toBe(200)
  return response.json()
}
function state() {
  return Object.fromEntries(['platform_query', 'platform_relation', 'platform_business_record', 'platform_business_record_version', 'platform_business_observation', 'platform_export_batch', 'platform_export_row', 'record_correspondence', 'record_correspondence_audit', 'evidence_revision_113', 'evidence_semantic_head_113'].map(table => [table, db.$client.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]))
}
async function rejectAtomically(body: RosterImportRequest, code: string) {
  const before = state()
  const plan = await submit('preflight', body)
  expect(plan.preflight.conflicts).toEqual(expect.arrayContaining([expect.objectContaining({ error: expect.objectContaining({ code }) })]))
  expect(state()).toEqual(before)
  const result = await submit('commit', body)
  expect(result.status).toBe('failed')
  expect(result.summary).toMatchObject({ written: 0, skipped: 0 })
  expect(result.items).toEqual(expect.arrayContaining([expect.objectContaining({ ok: false, error: expect.objectContaining({ code }) })]))
  expect(state()).toEqual(before)
}

const changes: [string, (q: RosterImportPlatformQuery) => void][] = [
  ['response', q => { q.rawResponse = '{"changed":true}' }],
  ['status', q => { q.status = 'failed' }],
  ['title', q => { q.titleCode = 'little_giant' }],
  ['failure', q => { q.failureReason = 'changed' }],
  ['collection', q => { q.collectionEvidence = { source: 'businessList' } as any }],
]
it.each(changes)(`${protocol} rejects query %s changes across keys and preserves sibling atomicity`, async (_name, mutate) => {
  const original = query()
  expect((await submit('commit', request({ platformQueries: [original] }))).status).toBe('committed')
  const changed = structuredClone(original); mutate(changed)
  await rejectAtomically(request({ platformQueries: [query(), changed] }), _name === 'collection' ? 'collection_evidence_invalid' : 'query_payload_conflict')
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
it(`${protocol} reuses identical sources across keys, returns the original same-key receipt, and permits distinct observation times and new snapshot bytes`, async () => {
  const q = query(), s = snapshot(), body = request({ platformQueries: [q], exportSnapshot: s })
  const saved = await submit('commit', body); expect(saved.status).toBe('committed')
  const before = state()
  const queryId = Number(saved.items.find((item: any) => item.kind === 'platform_query').ref.slice(6))
  const read = await readQuery(queryId)
  expect(read.rows[0].query).toMatchObject({ id: queryId, queryKey: q.queryKey, rawResponse: q.rawResponse, status: q.status, titleCode: q.titleCode })
  expect(read.rows[0].relations[0]).toMatchObject({ sequenceNo: 1, rawFields: q.relations![0]!.rawFields })
  expect(await submit('commit', body)).toEqual(saved)
  const copy = request(structuredClone(body.payload)); copy.payload.exportSnapshot!.collectedOn = '2026-10-02'; copy.payload.exportSnapshot!.originalFilename = '重命名.xlsx'
  const plan = await submit('preflight', copy); expect(plan.preflight).toMatchObject({ add: 0, update: 0, conflicts: [] })
  const reused = await submit('commit', copy)
  expect(reused.status).toBe('committed'); expect(reused.summary).toMatchObject({ written: 0, skipped: 2 })
  expect(state()).toEqual(before)
  q.queriedAt = '2026-10-02T00:00:00Z'; s.sha256 += '-new'
  expect((await submit('commit', request({ platformQueries: [q], exportSnapshot: s }))).status).toBe('committed')
  const batches = db.select().from(schema.platformExportBatch).all()
  expect(batches.at(-1)!.replacedBatchId).toBe(batches.at(-2)!.id)
})
it(`${protocol} legacy omitted response and explicit reuse preserve archive bytes, fingerprints and audits`, async () => {
  const q = query()
  // Synthetic pre-projection history, including intentionally noncanonical JSON bytes.
  const old = db.insert(schema.platformQuery).values({ ...q, rawResponse: q.rawResponse! }).returning().get()
  const rel = db.insert(schema.platformRelation).values({ queryId: old.id, sequenceNo: 1, relationKey: 'old', nameRaw: '合成', rawFields: { id: 'old', n: '1' } }).returning().get()
  db.$client.prepare('UPDATE platform_relation SET raw_fields=? WHERE id=?').run('{ "n": "1", "id":"old" }', rel.id)
  const edge = db.insert(schema.recordCorrespondence).values({ edgeKey: `old-${serial++}`, type: 'event_process', role: 'context_only', relationId: rel.id, titleCode: 'specialized_sme', status: 'confirmed', revision: 1, targetIdentity: {}, provenance: {}, sourceFingerprint: 'old-fingerprint', ruleId: 'manual', ruleVersion: '1', createdAt: '2026-01-01' }).returning().get()
  const oldBatch = db.insert(schema.importBatch).values({ idempotencyKey: `old-batch-${serial++}`, sourceKind: 'platform_archive', sourceIdentity: 'synthetic-old', status: 'committed' }).returning().get()
  db.insert(schema.recordCorrespondenceAudit).values({ batchId: oldBatch.id, correspondenceId: edge.id, idempotencyKey: `old-audit-${serial++}`, toStatus: 'confirmed', expectedRevision: 0, resultingRevision: 1, actorType: 'agent', actorId: 'synthetic', basis: 'old', ruleId: 'manual', ruleVersion: '1', evidence: { relationId: rel.id }, decidedAt: '2026-01-01' }).run()
  const before = state(), hash = createHash('sha256').update(JSON.stringify(before)).digest('hex')
  for (const explicit of [false, true]) {
    const omitted = { ...q, rawResponse: null, relations: [{ sequenceNo: 1, relationKey: 'old', nameRaw: '合成', ...(explicit ? { rawFields: { id: 'old', n: '1' } } : {}) }], ...(explicit ? { reuseExisting: true as const } : {}) }
    const body = request({ platformQueries: [omitted] })
    expect((await submit('preflight', body)).preflight).toMatchObject({ add: 0, update: 0, conflicts: [] })
    const result = await submit('commit', body)
    expect(result.status).toBe('committed'); expect(result.summary).toMatchObject({ written: 0, skipped: 1 })
  }
  expect(state()).toEqual(before)
  expect(createHash('sha256').update(JSON.stringify(state())).digest('hex')).toBe(hash)
})
it(`${protocol} explicit reuse cannot create a missing source while ordinary raw omission can create a new legacy observation`, async () => {
  const q = query(); delete q.rawResponse
  await rejectAtomically(request({ platformQueries: [{ ...q, reuseExisting: true } as any] }), 'query_reuse_missing')
  expect((await submit('commit', request({ platformQueries: [q] }))).status).toBe('committed')
})
it(`${protocol} ordinary query and snapshot replays cannot add new sequence numbers or silently omit rows`, async () => {
  const q = query(), s = snapshot()
  expect((await submit('commit', request({ platformQueries: [q], exportSnapshot: s }))).status).toBe('committed')
  const appended = structuredClone(q); appended.relations!.push({ sequenceNo: 2, relationKey: 'extra', rawFields: { id: 'extra' } })
  await rejectAtomically(request({ platformQueries: [appended] }), 'query_relation_set_conflict')
  await rejectAtomically(request({ platformQueries: [{ ...q, relations: [] }] }), 'query_relation_set_conflict')
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
  expect(responses.find(r => r.status === 'failed').items).toEqual(expect.arrayContaining([expect.objectContaining({ error: expect.objectContaining({ code: 'query_payload_conflict' }) })]))
  expect(db.select().from(schema.platformQuery).all().filter(r => r.queryKey === q.queryKey)).toHaveLength(1)
})
it(`${protocol} transaction failure rolls back a preceding query and preserves old references, then the same key can retry`, async () => {
  const q = query(), s = snapshot(), body = request({ platformQueries: [q], exportSnapshot: s })
  const before = state()
  db.$client.exec("CREATE TRIGGER synthetic_issue300_fault BEFORE INSERT ON platform_export_row BEGIN SELECT RAISE(ABORT, 'synthetic issue300 fault'); END")
  try {
    const result = await submit('commit', body)
    expect(result.status).toBe('failed'); expect(result.summary).toMatchObject({ written: 0, skipped: 0 })
    expect(result.error).toContain('synthetic issue300 fault')
    expect(state()).toEqual(before)
  } finally { db.$client.exec('DROP TRIGGER synthetic_issue300_fault') }
  expect((await submit('commit', body)).status).toBe('committed')
})

it.each(['failed', 'partial'] as const)(`${protocol} preserves existing %s collection status when omitted and rejects explicit replacement under both reuse modes`, async status => {
  const q = { ...query(), status, failureReason: 'original collection incomplete' }
  expect((await submit('commit', request({ platformQueries: [q] }))).status).toBe('committed')
  const before = state()
  for (const explicit of [false, true]) {
    const reference = { interface: q.interface, queryKey: q.queryKey, rdjb: q.rdjb, queriedAt: q.queriedAt, ...(explicit ? { reuseExisting: true as const } : {}) }
    expect((await submit('preflight', request({ platformQueries: [reference] }))).preflight.conflicts).toEqual([])
    expect((await submit('commit', request({ platformQueries: [reference] }))).status).toBe('committed')
    await rejectAtomically(request({ platformQueries: [{ ...reference, status: 'success' }] }), 'query_payload_conflict')
    await rejectAtomically(request({ platformQueries: [{ ...reference, titleCode: null }] }), 'query_payload_conflict')
    await rejectAtomically(request({ platformQueries: [{ ...reference, rawResponse: 'null' }] }), 'query_payload_conflict')
    await rejectAtomically(request({ platformQueries: [{ ...reference, rawResponse: '{"explicit":true}' }] }), 'query_payload_conflict')
    await rejectAtomically(request({ platformQueries: [{ ...reference, relations: [{ ...q.relations![0]!, nameRaw: 'changed' }] }] }), 'relation_payload_conflict')
    await rejectAtomically(request({ platformQueries: [{ ...reference, relations: [{ ...q.relations![0]!, rawFields: null }] }] }), 'observation_payload_conflict')
    await rejectAtomically(request({ platformQueries: [{ ...reference, relations: [{ sequenceNo: 2 }] }] }), 'query_relation_set_conflict')
  }
  expect(state()).toEqual(before)
})

it(`${protocol} rechecks query and export source identity inside the write transaction and rolls back earlier siblings`, async () => {
  for (const kind of ['query', 'export']) {
    const sibling = query(), target = query(), file = snapshot()
    target.relations = []
    const body = request({ platformQueries: kind === 'query' ? [sibling, target] : [sibling], ...(kind === 'export' ? { exportSnapshot: file } : {}) })
    const before = state()
    expect((await submit('preflight', body)).preflight.conflicts).toEqual([])
    // A trigger creates the competing source after planning, within the current
    // transaction. The later item must compare it again, not trust the old plan.
    const quote = (value: string) => "'" + value.replaceAll("'", "''") + "'"
    const competing = kind === 'query'
      ? `INSERT INTO platform_query(interface,query_key,rdjb,queried_at,status,raw_response,created_at) VALUES('business_list',${quote(target.queryKey)},'2',${quote(target.queriedAt)},'success','competing','synthetic')`
      : `INSERT INTO platform_export_batch(title_code,year,sha256,collected_on,original_filename,row_count,created_at) VALUES('specialized_sme',2025,${quote(file.sha256)},'2026-10-01','synthetic.xlsx',1,'synthetic'); INSERT INTO platform_export_row(batch_id,source_row_no,name_raw,created_at) VALUES(last_insert_rowid(),2,'competing','synthetic')`
    db.$client.exec(`CREATE TRIGGER synthetic_issue300_race AFTER INSERT ON platform_query WHEN NEW.query_key=${quote(sibling.queryKey)} BEGIN ${competing}; END`)
    try {
      const result = await submit('commit', body)
      expect(result.status, JSON.stringify(result)).toBe('failed'); expect(result.summary).toMatchObject({ written: 0, skipped: 0 })
      expect(result.items[0].error.code).toBe('commit_rolled_back')
      expect(result.items[1].error.code).toBe(kind === 'query' ? 'query_payload_conflict' : 'export_row_payload_conflict')
      expect(state()).toEqual(before)
    } finally { db.$client.exec('DROP TRIGGER synthetic_issue300_race') }
  }
})

it(`${protocol} discovery explains the existing reuseExisting field and immutable replay boundary`, async () => {
  for (const action of ['preflight', 'commit']) expect(metadata[action].requestBody.content['application/json'].schema.properties.payload.properties.platformQueries.items.properties.reuseExisting).toMatchObject({ type: 'boolean', enum: [true] })
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
  const before = state(), reference = structuredClone(q)
  delete reference.titleCode; delete reference.status
  expect((await submit('commit', request({ platformQueries: [reference] }))).status).toBe('committed')
  const minimal = { interface: q.interface, queryKey: q.queryKey, rdjb: q.rdjb, queriedAt: q.queriedAt, reuseExisting: true as const }
  expect((await submit('commit', request({ platformQueries: [minimal] }))).status).toBe('committed')
  await rejectAtomically(request({ platformQueries: [{ ...minimal, status: 'failed' }] }), 'query_payload_conflict')
  const changed = structuredClone(q); changed.collectionEvidence!.completedAt = '2099-01-01T00:00:00Z'
  await rejectAtomically(request({ platformQueries: [changed] }), 'collection_evidence_conflict')
  await rejectAtomically(request({ platformQueries: [{ ...minimal, relations: [{ sequenceNo: 1, rawFields: { ...row, typedNull: 'null' } }] }] }), 'observation_payload_conflict')
  expect(state()).toEqual(before)
  const read = await readQuery(Number(saved.items[0].ref.slice(6)))
  expect(read.rows[0].query.collectionEvidence).toEqual(evidence)
  expect(read.rows[0].relations[0].rawFields).toEqual(row)
})

it(`${protocol} pairs explicit reference, omitted row raw, complete legacy raw and second replay without changing the original archive`, async () => {
  const q = query()
  const old = db.insert(schema.platformQuery).values({ interface: q.interface, queryKey: q.queryKey, rdjb: q.rdjb, titleCode: q.titleCode, queriedAt: q.queriedAt, status: q.status, rawResponse: q.rawResponse }).returning().get()
  const original = q.relations![0]!
  const { declareKind, ...sourceRow } = original
  if (declareKind != null && declareKind !== 'apply' && declareKind !== 'update' && declareKind !== 'review') throw new Error('Synthetic source row has an unsupported declaration kind')
  const rel = db.insert(schema.platformRelation).values({ queryId: old.id, ...sourceRow, declareKind }).returning().get()
  const before = { query: db.$client.prepare('SELECT * FROM platform_query WHERE id=?').get(old.id), relation: db.$client.prepare('SELECT * FROM platform_relation WHERE id=?').get(rel.id) }
  const counts = () => [
    (db.$client.prepare('SELECT count(*) n FROM platform_business_record WHERE platform_key=?').get(original.relationKey) as { n: number }).n,
    (db.$client.prepare('SELECT count(*) n FROM platform_business_record_version WHERE record_id IN (SELECT id FROM platform_business_record WHERE platform_key=?)').get(original.relationKey) as { n: number }).n,
    (db.$client.prepare('SELECT count(*) n FROM platform_business_observation WHERE relation_id=?').get(rel.id) as { n: number }).n,
  ]
  for (const reference of [{ ...q, reuseExisting: true as const }, { ...q, rawResponse: null, relations: [{ sequenceNo: 1, relationKey: original.relationKey }] }]) {
    const out = await submit('commit', request({ platformQueries: [reference] }))
    expect(out.status).toBe('committed'); expect(out.summary).toMatchObject({ written: 0, skipped: 1 })
    expect(out.items[0].detail.canonicalProjection).toEqual([])
    expect(counts()).toEqual([0, 0, 0])
  }
  const normal = { ...q, rawResponse: null }
  const added = await submit('commit', request({ platformQueries: [normal] }))
  expect(added.status).toBe('committed'); expect(added.summary).toMatchObject({ written: 0, skipped: 1, canonicalProjection: { recordsCreated: 1, versionsCreated: 1, observationsCreated: 1 } })
  expect(counts()).toEqual([1, 1, 1])
  const versions = db.$client.prepare('SELECT * FROM platform_business_record_version ORDER BY id').all()
  const again = await submit('commit', request({ platformQueries: [normal] }))
  expect(again.status).toBe('committed'); expect(again.summary).toMatchObject({ written: 0, skipped: 1, canonicalProjection: { recordsCreated: 0, versionsCreated: 0, observationsCreated: 0, observationsReused: 1 } })
  expect(counts()).toEqual([1, 1, 1])
  expect(db.$client.prepare('SELECT * FROM platform_business_record_version ORDER BY id').all()).toEqual(versions)
  expect({ query: db.$client.prepare('SELECT * FROM platform_query WHERE id=?').get(old.id), relation: db.$client.prepare('SELECT * FROM platform_relation WHERE id=?').get(rel.id) }).toEqual(before)
})
it(`${protocol} accepts same-payload references that omit raw assertions and rejects explicit source-field changes before commit`, async () => {
  const q = query()
  expect((await submit('commit', request({ platformQueries: [q] }))).status).toBe('committed')
  const omitted = { ...q, relations: [{ sequenceNo: 1, relationKey: q.relations![0]!.relationKey }] }
  const body = request({ platformQueries: [omitted, q] })
  const plan = await submit('preflight', body)
  expect(plan.preflight.conflicts).toEqual([])
  expect(plan.preflight.canonicalProjection).toHaveLength(2)
  for (const projection of plan.preflight.canonicalProjection) expect(projection).toMatchObject({ identityState: 'resolved', contentState: 'verified', keySource: 'both' })
  expect((await submit('commit', body)).status).toBe('committed')
  const duplicated = query(); duplicated.relations!.push({ sequenceNo: 1 })
  const duplicateBody = request({ platformQueries: [duplicated] })
  expect((await submit('preflight', duplicateBody)).preflight.conflicts).toEqual([])
  expect((await submit('commit', duplicateBody)).status).toBe('committed')
  const fresh = query(), changed = { ...fresh, relations: [{ ...fresh.relations![0]!, nameRaw: 'different' }] }
  await rejectAtomically(request({ platformQueries: [fresh, changed] }), 'relation_payload_conflict')
})

it.each([
  { name: 'one-to-empty', first: [1], next: [], accepted: false },
  { name: 'empty-to-one', first: [], next: [1], accepted: false },
  { name: 'deleted-subset', first: [1, 2], next: [2], accepted: false },
  { name: 'reordered-same-set', first: [1, 2], next: [2, 1], accepted: true },
])(`${protocol} full row-set $name has the same preflight and commit outcome for staged and stored sources`, async ({ first, next, accepted }) => {
  for (const stored of [false, true]) {
    const original = query()
    const rows = (sequences: number[]) => sequences.map(sequenceNo => ({ sequenceNo, relationKey: `${original.queryKey}-r${sequenceNo}`, rawFields: { id: `${original.queryKey}-r${sequenceNo}`, value: sequenceNo } }))
    original.relations = rows(first)
    if (stored) expect((await submit('commit', request({ platformQueries: [original] }))).status).toBe('committed')
    const replay = { ...original, relations: rows(next) }
    const body = request({ platformQueries: stored ? [replay] : [original, replay] })
    if (!accepted) {
      await rejectAtomically(body, 'query_relation_set_conflict')
      continue
    }
    const before = state()
    const plan = await submit('preflight', body)
    expect(plan.preflight.conflicts).toEqual([])
    expect(state()).toEqual(before)
    const result = await submit('commit', body)
    expect(result.status).toBe('committed')
    expect(result.summary.written).toBe(stored ? 0 : 3)
    const saved = db.select().from(schema.platformQuery).all().filter(row => row.queryKey === original.queryKey)
    expect(saved).toHaveLength(1)
    const read = await readQuery(saved[0]!.id)
    expect(read.rows[0].query.rawResponse).toBe(original.rawResponse)
    expect(read.rows[0].relations.map((row: { sequenceNo: number }) => row.sequenceNo)).toEqual([1, 2])
    expect(read.rows[0].relations.map((row: { rawFields: unknown }) => row.rawFields)).toEqual(rows([1, 2]).map(row => row.rawFields))
    if (stored) expect(state()).toEqual(before)
  }
})

it.each(['explicit-reuse', 'legacy-response-omission'] as const)(`${protocol} %s permits row subsets without declaring a complete staged or stored source`, async mode => {
  for (const stored of [false, true]) for (const subset of [[], [2]]) {
    const original = query()
    original.relations = [1, 2].map(sequenceNo => ({ sequenceNo, relationKey: `${original.queryKey}-r${sequenceNo}`, rawFields: { id: `${original.queryKey}-r${sequenceNo}`, value: sequenceNo } }))
    if (stored) expect((await submit('commit', request({ platformQueries: [original] }))).status).toBe('committed')
    const reference = {
      ...original,
      ...(mode === 'explicit-reuse' ? { reuseExisting: true as const } : { rawResponse: null }),
      relations: subset.map(sequenceNo => ({ sequenceNo })),
    }
    const body = request({ platformQueries: stored ? [reference] : [original, reference] })
    const before = state()
    expect((await submit('preflight', body)).preflight.conflicts).toEqual([])
    expect(state()).toEqual(before)
    const result = await submit('commit', body)
    expect(result.status).toBe('committed')
    expect(result.summary.written).toBe(stored ? 0 : 3)
    const replayItem = result.items[result.items.length - 1]
    expect(replayItem.detail.rowsWritten).toBe(0)
    expect(replayItem.detail.canonicalProjection).toHaveLength(subset.length)
    expect(replayItem.detail.canonicalProjection.every((projection: { observationCreated: boolean }) => !projection.observationCreated)).toBe(true)
    if (stored) expect(state()).toEqual(before)
    const saved = db.select().from(schema.platformQuery).all().filter(row => row.queryKey === original.queryKey)
    expect(saved).toHaveLength(1)
    const read = await readQuery(saved[0]!.id)
    expect(read.rows[0].query.rawResponse).toBe(original.rawResponse)
    expect(read.rows[0].relations.map((row: { sequenceNo: number }) => row.sequenceNo)).toEqual([1, 2])
    expect(read.rows[0].relations.map((row: { rawFields: unknown }) => row.rawFields)).toEqual(original.relations.map(row => row.rawFields))
  }
})
