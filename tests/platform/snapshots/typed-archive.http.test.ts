import { createServer } from 'node:http'
import { createHash } from 'node:crypto'

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
import { eq, sql } from 'drizzle-orm'
import { postgresRuntimeFixture } from '../../support/postgres-fixture.mjs'
import { closePostgresDirectoryDb, usePostgresDirectoryDb } from '../../../db/postgresql/client'
import { platformArchiveValue } from '../../../db/postgresql/platform-archive-tables'
import { platformBusinessRecordVersion, platformLegacyRelationAlias } from '../../../db/postgresql/platform-tables'
import { recordCorrespondence, recordCorrespondenceAudit } from '../../../db/postgresql/qualification-tables'
import { runPostgresMixedImport } from '../../../layers/sme-roster/server/utils/roster-mixed-import-postgres'
import { updatePostgresCredentialState } from '../../../layers/core/server/utils/credential-state-postgres'
import { stopPostgresJobs } from '../../../layers/core/server/utils/postgres-jobs'

import type { PlatformLiveQueryResult } from '../../../layers/sme-roster/lib/platform/live-query'
import type { RosterImportPlatformQuery } from '../../../layers/sme-roster/lib/roster-import-client'
import { recognizedResultToImport, platformResultToImport } from '../../../layers/sme-roster/lib/platform/recognized-evidence'
import { readMcpToken, resolveMcpAuth } from '../../../layers/core/server/utils/mcp-auth'

const dir = mkdtempSync(join(tmpdir(), 'issue327-typed-archive-'))
let postgres: Awaited<ReturnType<typeof postgresRuntimeFixture>> | undefined
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
const importMetadata: Record<string, any> = {}
async function post(path: string, body: unknown) {
  return nativeFetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) })
}
async function call(name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args })
  expect(result.isError).not.toBe(true)
  if (result.structuredContent) expect(result.content).toContainEqual({ type: 'text', text: JSON.stringify(result.structuredContent) })
  return result.structuredContent ?? JSON.parse((result.content as any)[0].text)
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
  const evidenceRoute = (await import('../../../layers/sme-roster/server/api/platform/queries/[queryId]/evidence.get')).default
  const declarationsRoute = (await import('../../../layers/sme-roster/server/api/platform/declarations.get')).default
  const router = createRouter().post('/api/platform/query', queryRoute).get('/api/platform/queries', readRoute).get('/api/platform/queries/:queryId/evidence', evidenceRoute).get('/api/platform/declarations', declarationsRoute)
  for (const action of ['preflight', 'commit'] as const) {
    vi.stubGlobal('defineRouteMeta', (value: any) => { importMetadata[action] = value.openAPI })
    router.post(`/api/roster/import/${action}`, (await import(`../../../layers/sme-roster/server/api/roster/import/${action}.post.ts`)).default)
  }
  const { createPlatformBatchRoute } = await import('../../../layers/sme-roster/server/utils/platform-batch-route')
  router.post('/api/platform/batches', createPlatformBatchRoute('submit'))
  const listener = toNodeListener(createApp().use(router))
  server = createServer((req, res) => {
    if (req.url !== '/mcp') { listener(req, res); return }
    const mcp = new McpServer({ name: 'issue298-public-tool-fixture', version: '1' })
    const mcpAuth = resolveMcpAuth({ given: readMcpToken({ authorization: req.headers.authorization }), configured: token })
    for (const tool of tools.filter(tool => !tool.enabled || tool.enabled({ context: { mcpAuth } }))) mcp.registerTool(tool.name, { description: tool.description, inputSchema: tool.inputSchema, ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}) }, async (args: Record<string, unknown>) => {
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
  vi.restoreAllMocks()
  vi.unstubAllGlobals(); vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true })
})

let serial = 0
type Transport = 'REST' | 'MCP'
async function collect(row: Record<string, unknown>, transport: Transport = 'REST', sourceName = 'queryBusList'): Promise<PlatformLiveQueryResult> {
  const grid = sourceName === 'queryList' ? 'applyGrid' : sourceName === 'businessList' ? 'businessListGrid' : 'businessGrid'
  raw = JSON.stringify({ zrarData: { grid: { [grid]: { pageSet: [row], page: 1, pageSize: 1, maxCount: 1, maxPage: 1 } } } })
  const query = sourceName === 'queryBusList' ? input : sourceName === 'queryList'
    ? { source: sourceName, name: '合成', rawDataVersion: 1, pageSize: 1 }
    : { source: sourceName, uscc: '91330211255994457P', rdjb: '2', rawDataVersion: 1, pageSize: 1 }
  const result = transport === 'REST' ? await (await post('/api/platform/query', query)).json() : await call('query_platform', query)
  expect(result.status).toBe('success')
  // Make distinct, explicit synthetic observation times without timer dependence.
  result.queriedAt = result.completedAt = new Date(Date.UTC(2026, 9, 1, 0, 0, serial++)).toISOString()
  return result
}
function archive(e: PlatformLiveQueryResult): RosterImportPlatformQuery {
  const legacy = e.rows[0]!
  return {
    interface: e.source === 'queryBusList' ? 'recognized_list' : e.source === 'queryList' ? 'apply_list' : 'business_list',
    queryKey: e.effectiveConditions.uscc ?? `name:${e.effectiveConditions.name}`,
    rdjb: e.titleScope.rdjb.join(','), titleCode: e.titleScope.rdjb.length === 1 ? 'specialized_sme' : null,
    queriedAt: e.queriedAt, status: 'success', collectionEvidence: e,
    relations: [{ sequenceNo: 1, relationKey: legacy.id ?? null, nameRaw: legacy.qymc ?? null, usccRaw: legacy.tyshxydm ?? null, rawFields: e.rawData!.rows[0] }],
  }
}
function request(queries: RosterImportPlatformQuery[]) {
  return { idempotencyKey: `issue327-${serial++}`, sourceKind: 'platform_archive' as const, sourceIdentity: 'issue327-synthetic', payload: { platformQueries: queries } }
}
async function submit(transport: Transport, action: 'preflight' | 'commit', body: ReturnType<typeof request>) {
  if (transport === 'MCP') return call(action === 'commit' ? 'save_roster_batch' : 'preflight_roster_batch', body)
  const response = await post(`/api/roster/import/${action}`, body)
  expect(response.status).toBe(200)
  return response.json()
}
async function readSaved(saved: any, index = 0) {
  const item = saved.items.filter((item: any) => item.kind === 'platform_query')[index]
  const queryId = Number(item.ref.slice(6))
  const history = await call('list_platform_queries', { queryId })
  return { row: history.rows[0], projection: item.detail.canonicalProjection[0] }
}
async function businessState() {
  return usePostgresDirectoryDb().transaction(async tx => {
    const tables = await tx.execute<{ name: string }>(sql`
      SELECT tablename AS name FROM pg_tables WHERE schemaname = 'business' AND (
        tablename LIKE 'platform_%' OR tablename IN ('record_correspondence', 'record_correspondence_audit', 'difference_reason')
      ) ORDER BY tablename
    `)
    const snapshot: Record<string, Record<string, unknown>[]> = {}
    for (const { name } of tables.rows) {
      const { rows } = await tx.execute<{ row: Record<string, unknown> }>(sql`
        SELECT row_to_json(t) AS row FROM business.${sql.identifier(name)} AS t ORDER BY row_to_json(t)::text
      `)
      snapshot[name] = rows.map(item => item.row)
    }
    return snapshot
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' })
}
async function waitForBatch(batchId: string) {
  await expect.poll(async () => (await call('get_platform_batch', { batchId })).state).toMatch(/^(done|failed)$/)
}

  const mutations: [string, (q: RosterImportPlatformQuery) => void][] = [
    ['typed-row', q => { q.collectionEvidence!.rawData!.rows[0]!.n = '1' }],
    ['legacy-projection', q => { q.collectionEvidence!.rows[0]!.n = 'wrong' }],
    ['legacy-as-raw', q => { q.relations![0]!.rawFields = q.collectionEvidence!.rows[0] }],
    ['raw-version', q => { Object.assign(q.collectionEvidence!.rawData!, { version: 2 }) }],
    ['raw-null', q => { Object.assign(q.collectionEvidence!, { rawData: null }) }],
    ['raw-count', q => { q.collectionEvidence!.rawData!.rows = [] }],
    ['relation-count', q => { q.relations = [] }],
    ['malformed-relation', q => { Object.assign(q, { relations: [null] }) }],
    ['page-position', q => { q.collectionEvidence!.rawData!.pages[0]!.page++ }],
    ['page-source', q => { q.collectionEvidence!.rawData!.pages[0]!.source = q.collectionEvidence!.source === 'queryList' ? 'businessList' : 'queryList' }],
    ['page-title', q => { q.collectionEvidence!.rawData!.pages[0]!.rdjb = '3' }],
    ['page-count', q => { q.collectionEvidence!.pages[0]!.fetchedCount = 0 }],
    ['response-body', q => { q.collectionEvidence!.rawData!.pages[0]!.body = '{}' }],
    ['relation-position', q => { q.relations![0]!.sequenceNo = 2 }],
    ['relation-id', q => { q.relations![0]!.relationKey = 'another' }],
    ['query-key', q => { q.queryKey = 'name:another' }],
    ['query-time', q => { q.queriedAt = '2026-09-01T00:00:00Z' }],
    ['query-status', q => { q.status = 'no_record' }],
    ['query-rdjb', q => { q.rdjb = '3' }],
    ['source-interface', q => { q.interface = q.interface === 'apply_list' ? 'business_list' : 'apply_list' }],
    ['title', q => { q.titleCode = 'little_giant' }],
    ['owner', q => { q.relations![0]!.enterpriseId = 999999 }],
    ['name-only-confirm', q => { q.relations![0]!.verificationStatus = 'confirmed'; q.relations![0]!.matchBasis = 'alias' }],
  ]
const nativePairs = new Map<string, [RosterImportPlatformQuery, RosterImportPlatformQuery]>()
for (const sourceName of ['queryBusList', 'queryList', 'businessList']) it.each(sourceName === 'queryBusList' ? mutations : mutations.filter(([name]) => ['page-source', 'page-title', 'source-interface'].includes(name)))(`native ${sourceName} import rejects %s atomically with a valid sibling`, async (_label, mutate) => {
  if (!nativePairs.has(sourceName)) nativePairs.set(sourceName, [
    platformResultToImport(await collect({ id: 'native-sibling', qymc: '合成', n: 1 }, 'REST', sourceName)),
    platformResultToImport(await collect({ id: 'native-invalid', qymc: '合成', n: 1 }, 'REST', sourceName)),
  ])
  const [valid, bad] = structuredClone(nativePairs.get(sourceName)!)
  mutate(bad)
  const before = await businessState(), body = request([valid, bad])
  const preview = await runPostgresMixedImport('preflight', body, dir)
  if (!('preflight' in preview) || !preview.preflight) throw new Error('Expected preflight conflict details')
  expect(preview.preflight.conflicts).not.toEqual([])
  expect((await runPostgresMixedImport('commit', body, dir)).status).toBe('failed')
  expect(await businessState()).toEqual(before)
})
const transportMutations = mutations.filter(([name]) => ['typed-row', 'page-source', 'page-title', 'source-interface', 'owner', 'name-only-confirm'].includes(name))

for (const transport of ['REST', 'MCP'] as const) {
  it.each([
    ['null-empty', null, ''], ['number-string', 7, '7'], ['bool-string', true, 'true'],
    ['object-string', { a: 1 }, '{"a":1}'], ['missing-null', undefined, null],
  ])(`${transport} typed versions distinguish %s and replay identical content with stable IDs`, async (label, left, right) => {
    const key = `${transport}-${label}`
    const versions: number[] = [], records: number[] = [], relationIds: number[] = []
    for (const value of [left, right, left]) {
      const row = { id: key, qymc: '合成', ...(value === undefined ? {} : { unknown: value }), arr: [null, false, 2] }
      const evidence = await collect(row, transport)
      const body = request([archive(evidence)])
      const before = await businessState()
      const plan = await submit(transport, 'preflight', body)
      expect(plan.preflight.conflicts).toEqual([])
      expect(await businessState()).toEqual(before)
      const saved = await submit(transport, 'commit', body)
      expect(saved.status).toBe('committed')
      const { row: stored, projection } = await readSaved(saved)
      expect(stored.query.collectionEvidence).toEqual(evidence)
      expect(stored.relations[0].rawFields).toEqual(row)
      expect(stored.relations[0].id).toBe(projection.relationId)
      versions.push(projection.versionId); records.push(projection.recordId); relationIds.push(projection.relationId)
      const committed = await businessState()
      expect(await submit(transport, 'commit', body)).toEqual(saved)
      expect(await businessState()).toEqual(committed)
    }
    expect(versions[0]).not.toBe(versions[1]); expect(versions[2]).toBe(versions[0])
    expect(new Set(records).size).toBe(1); expect(new Set(relationIds).size).toBe(3)
  })

  it(`${transport} converter selects typed rows explicitly and legacy evidence retains unknown string types`, async () => {
    const evidence = await collect({ id: `${transport}-conversion`, qymc: '合成', unknown: null, n: 1 }, transport)
    const converted = recognizedResultToImport(evidence)
    expect(converted.relations![0]!.rawFields).toEqual(evidence.rawData!.rows[0])
    const old = structuredClone(evidence); delete old.rawData
    const legacy = recognizedResultToImport(old)
    const saved = await submit(transport, 'commit', request([legacy]))
    expect(saved.status).toBe('committed')
    const before = await businessState()
    const upgrade = await submit(transport, 'commit', request([converted]))
    expect(upgrade.status).toBe('failed')
    expect(upgrade.items.some((i: any) => i.error?.code === 'observation_payload_conflict')).toBe(true)
    expect(await businessState()).toEqual(before)
    expect((await readSaved(saved)).row.relations[0].rawFields).toEqual(old.rows[0])
  })

  it(`${transport} all three source interfaces retain independent identity and existing process normalization`, async () => {
    const row = { id: `${transport}-interfaces`, qymc: '合成', n: 9, sblx: '申请', cszt: '待审', year: '2025' }
    const queries = []
    for (const name of ['queryList', 'businessList', 'queryBusList']) queries.push(platformResultToImport(await collect(row, transport, name)))
    const saved = await submit(transport, 'commit', request(queries))
    expect(saved.status).toBe('committed')
    const ids = []
    for (let i = 0; i < 3; i++) {
      const stored = await readSaved(saved, i); ids.push(stored.projection.recordId)
      expect(stored.row.relations[0].rawFields).toEqual(row)
      if (i < 2) expect(stored.row.relations[0]).toMatchObject({ declareKind: 'apply', status: '待审', year: 2025 })
      else expect(stored.row.relations[0]).toMatchObject({ declareKind: null, status: null, year: null })
    }
    expect(new Set(ids).size).toBe(3)
  })

  it.each(transportMutations)(`${transport} rejects %s atomically with a valid sibling and no fallback`, async (_label, mutate) => {
    const valid = archive(await collect({ id: `sibling-${serial}`, qymc: '合成', n: 1 }, transport))
    const bad = archive(await collect({ id: `bad-${serial}`, qymc: '合成', n: 1 }, transport)); mutate(bad)
    const before = await businessState(), body = request([valid, bad])
    const plan = await submit(transport, 'preflight', body)
    expect(plan.preflight.conflicts).not.toEqual([])
    const result = await submit(transport, 'commit', body)
    expect(result.status).toBe('failed')
    expect(await businessState()).toEqual(before)
  })

  for (const sourceName of ['queryList', 'businessList']) it.each(transportMutations)(`${transport} ${sourceName} rejects %s with its own envelope`, async (_label, mutate) => {
    const valid = platformResultToImport(await collect({ id: `valid-${serial}`, n: 1 }, transport, sourceName))
    const bad = platformResultToImport(await collect({ id: `bad-${serial}`, n: 1 }, transport, sourceName)); mutate(bad)
    const before = await businessState(), body = request([valid, bad])
    expect((await submit(transport, 'preflight', body)).preflight.conflicts).not.toEqual([])
    expect((await submit(transport, 'commit', body)).status).toBe('failed')
    expect(await businessState()).toEqual(before)
  })

  it(`${transport} hash collision during commit rolls back earlier sibling and leaves historical rows unchanged`, async () => {
    const e = await collect({ id: `${transport}-collision`, qymc: '合成', n: 1 }, transport)
    const first = await submit(transport, 'commit', request([archive(e)]))
    expect(first.status).toBe('committed')
    const { projection } = await readSaved(first)
    // Seed a deliberately inconsistent archive in this disposable fixture. The online guard remains installed.
    await usePostgresDirectoryDb().transaction(async tx => {
      const [version] = await tx.select({ archiveId: platformBusinessRecordVersion.canonicalArchiveId })
        .from(platformBusinessRecordVersion).where(eq(platformBusinessRecordVersion.id, projection.versionId))
      const bytes = Buffer.from('{"syntheticCollision":true}')
      await tx.execute(sql`ALTER TABLE business.platform_archive_value DISABLE TRIGGER platform_archive_append_only`)
      await tx.update(platformArchiveValue).set({ bytes, byteLength: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
        .where(eq(platformArchiveValue.id, BigInt(version!.archiveId)))
      await tx.execute(sql`ALTER TABLE business.platform_archive_value ENABLE TRIGGER platform_archive_append_only`)
    })
    const sibling = archive(await collect({ id: `${transport}-collision-sibling`, n: 2 }, transport))
    const again = archive(await collect(e.rawData!.rows[0]!, transport))
    const before = await businessState()
    const saved = await submit(transport, 'commit', request([sibling, again]))
    expect(saved.status).toBe('failed')
    expect(saved.items.some((i: any) => i.error?.code === 'platform_content_hash_conflict'), JSON.stringify(saved)).toBe(true)
    expect(await businessState()).toEqual(before)
  })
}

it('public REST metadata and MCP discovery describe typed selection while preserving their actual auth boundaries', async () => {
  for (const action of ['preflight', 'commit']) {
    const payload = importMetadata[action].requestBody.content['application/json'].schema.properties.payload
    expect(payload.description).toContain('rawData.version=1')
    expect(payload.properties.platformQueries.items.properties.collectionEvidence.anyOf.find((branch: any) => branch.type === 'object').properties.rawData).toMatchObject({ required: ['version', 'rows', 'pages'], properties: { version: { const: 1 }, rows: { items: { additionalProperties: {} } } } })
  }
  const discovered = await client.listTools()
  for (const name of ['preflight_roster_batch', 'save_roster_batch']) expect(discovered.tools.find(t => t.name === name)?.description).toContain('rawData.version=1')
  const evidence = await collect({ id: 'auth', n: 1 }), body = request([recognizedResultToImport(evidence)])
  const before = await businessState()
  for (const action of ['preflight', 'commit']) {
    const result = await nativeFetch(`${base}/api/roster/import/${action}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    expect(result.status).toBe(401)
  }
  const anonymous = new Client({ name: 'issue327-anonymous', version: '1' })
  try {
    await anonymous.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)))
    const names = (await anonymous.listTools()).tools.map(t => t.name)
    expect(names).toContain('preflight_roster_batch'); expect(names).not.toContain('save_roster_batch')
    const plan = await anonymous.callTool({ name: 'preflight_roster_batch', arguments: body })
    expect(plan.isError).not.toBe(true)
    const value = plan.structuredContent ?? JSON.parse((plan.content as { text: string }[])[0]!.text)
    expect(value).toMatchObject({ preflight: { conflicts: [] } })
  } finally { await anonymous.close() }
  expect(await businessState()).toEqual(before)
})

it('typed apply_list archive feeds the declaration projection without rewriting its raw identity', async () => {
  const typedRow = { id: 'SQ-DECL-TYPED', qymc: '合成申报企业', tyshxydm: '91330211255994457P', sblx: '申请', year: 2024, sqsj: '2024-03-01 09:00:00', cszt: '待审核', unknown: null }
  const evidence = await collect(typedRow, 'REST', 'queryList')
  const saved = await submit('REST', 'commit', request([platformResultToImport(evidence)]))
  expect(saved.status).toBe('committed')
  const stored = await readSaved(saved)
  expect(stored.row.relations[0].rawFields).toEqual(typedRow)
  const response = await nativeFetch(`${base}/api/platform/declarations?platformKey=SQ-DECL-TYPED`)
  const listed: any = await response.json()
  expect(response.status, JSON.stringify(listed)).toBe(200)
  expect(listed.rows).toHaveLength(1)
  expect(listed.rows[0].matchedVersion).toMatchObject({ declareKind: 'apply', declarationYear: 2024, appliedAt: '2024-03-01 09:00:00', status: '待审核', nameRaw: '合成申报企业', usccRaw: '91330211255994457P' })
  expect(stored.row.relations[0].rawFields).toEqual(typedRow)
})

it('public typed archival ignores object key order for versions while preserving array order and original row objects', async () => {
  const rows = [
    { id: 'key-order', nested: { b: 2, a: 1 }, arr: [1, 2] },
    { arr: [1, 2], nested: { a: 1, b: 2 }, id: 'key-order' },
    { id: 'key-order', nested: { a: 1, b: 2 }, arr: [2, 1] },
  ]
  const versions = []
  for (const row of rows) {
    const result = await collect(row)
    const saved = await submit('REST', 'commit', request([recognizedResultToImport(result)]))
    expect(saved.status).toBe('committed')
    const stored = await readSaved(saved)
    expect(stored.row.relations[0].rawFields).toEqual(row)
    versions.push(stored.projection.versionId)
  }
  expect(versions[0]).toBe(versions[1]); expect(versions[1]).not.toBe(versions[2])
})

it('MCP typed prototype keys are retained in relation and version while strict REST rejects the same body', async () => {
  const evidence = await collect(typed, 'MCP')
  const body = request([recognizedResultToImport(evidence)])
  const before = await businessState()
  expect((await post('/api/roster/import/commit', body)).status).toBe(400)
  expect(await businessState()).toEqual(before)
  const saved = await submit('MCP', 'commit', body)
  expect(saved.status).toBe('committed')
  const stored = await readSaved(saved)
  expect(stored.row.relations[0].rawFields).toEqual(typed)
  expect(Object.hasOwn(stored.row.relations[0].rawFields, '__proto__')).toBe(true)
  const [version] = await usePostgresDirectoryDb().select({ bytes: platformArchiveValue.bytes }).from(platformBusinessRecordVersion)
    .innerJoin(platformArchiveValue, eq(platformArchiveValue.id, platformBusinessRecordVersion.canonicalArchiveId))
    .where(eq(platformBusinessRecordVersion.id, stored.projection.versionId))
  expect(JSON.parse(version!.bytes!.toString('utf8'))).toEqual(typed)
})

it('MCP batch partial and resumed segments archive with exact original page positions and reusable typed versions', async () => {
  const rows = [{ id: 'segments', n: null }, { id: 'segments', n: '' }, { id: 'segments', n: null }]
  pageBodies = new Map(rows.map((row, i) => [i + 1, source(row, i + 1, 3)]))
  try {
    const receipt = await call('submit_platform_batch', { items: [{ query: { ...input, maxRequests: 1 } }] })
    await waitForBatch(receipt.batchId)
    for (let i = 0; i < 2; i++) {
      await call('retry_platform_batch', { batchId: receipt.batchId, itemIds: receipt.itemIds }); await waitForBatch(receipt.batchId)
    }
    const item = await call('get_platform_batch_item', { batchId: receipt.batchId, itemId: receipt.itemIds[0] })
    expect(item.status).toBe('success'); expect(item.segments).toHaveLength(3)
    const versions = []
    for (const [i, segment] of item.segments.entries()) {
      expect(segment.rawData.pages).toEqual([{ source: 'queryBusList', rdjb: '2', page: i + 1, format: 'json', body: pageBodies.get(i + 1) }])
      const saved = await submit('MCP', 'commit', request([recognizedResultToImport(segment)]))
      expect(saved.status).toBe('committed')
      const stored = await readSaved(saved)
      expect(stored.row.query.status).toBe('partial')
      expect(stored.row.query.collectionEvidence).toEqual(segment)
      expect(stored.row.relations[0]).toMatchObject({ rawFields: rows[i], sourceRdjb: '2', sourcePage: i + 1 })
      versions.push(stored.projection.versionId)
    }
    expect(versions[0]).not.toBe(versions[1]); expect(versions[2]).toBe(versions[0])
  } finally { pageBodies = undefined }
})

it('new typed observations leave old string hashes, IDs, explicit decisions and append-only audit untouched', async () => {
  const e = await collect({ id: 'historical-decision', qymc: '合成', n: 1 })
  const old = structuredClone(e); delete old.rawData
  const saved = await submit('REST', 'commit', request([recognizedResultToImport(old)]))
  expect(saved.status).toBe('committed')
  const { projection } = await readSaved(saved)
  const db = usePostgresDirectoryDb()
  const [observation] = await db.select().from(platformLegacyRelationAlias).where(eq(platformLegacyRelationAlias.oldId, projection.relationId))
  const [edge] = await db.insert(recordCorrespondence).values({ edgeKey: 'issue327-old-edge', type: 'event_recognized', role: 'context_only', observationId: observation!.observationId, titleCode: 'specialized_sme', status: 'confirmed', revision: 1, targetIdentity: JSON.stringify({ synthetic: true }), provenance: JSON.stringify({ originalRelation: projection.relationId }), sourceFingerprint: 'synthetic-old-fingerprint', ruleId: 'manual', ruleVersion: '1', createdAt: '2026-01-01' }).returning()
  await db.insert(recordCorrespondenceAudit).values({ correspondenceId: edge!.id, batchId: saved.batchId, idempotencyKey: 'issue327-old-audit', toStatus: 'confirmed', expectedRevision: 0, resultingRevision: 1, actorType: 'agent', actorId: 'issue327', basis: 'synthetic prior decision', ruleId: 'manual', ruleVersion: '1', evidence: JSON.stringify({ originalRelation: projection.relationId }), decidedAt: '2026-01-01' })
  const before = await businessState()
  const fresh = await collect(e.rawData!.rows[0]!)
  const added = await submit('REST', 'commit', request([recognizedResultToImport(fresh)]))
  expect(added.status).toBe('committed')
  const newer = await readSaved(added)
  expect(newer.projection.recordId).toBe(projection.recordId)
  expect(newer.projection.versionId).not.toBe(projection.versionId)
  const after = await businessState()
  for (const table of Object.keys(before).filter(name => name !== 'platform_legacy_alias_sequence')) expect(after[table]).toEqual(expect.arrayContaining(before[table] as unknown[]))
  for (const row of before.platform_legacy_alias_sequence as { namespace: string; high_water: number }[]) {
    const next = (after.platform_legacy_alias_sequence as { namespace: string; high_water: number }[]).find(value => value.namespace === row.namespace)
    expect(next?.high_water).toBeGreaterThanOrEqual(row.high_water)
  }
  expect(after.record_correspondence).toEqual(before.record_correspondence)
  expect(after.record_correspondence_audit).toEqual(before.record_correspondence_audit)
})
