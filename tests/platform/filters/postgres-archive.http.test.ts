import { createApp, createError, createRouter, defineEventHandler, getMethod, getQuery, setHeader, setResponseStatus, toWebHandler } from 'h3'
import pg from 'pg'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { schema } from '../../../db'
import { closePostgresDirectoryDb } from '../../../db/postgresql/client'
import { nativeCatalogFixture, type NativeSource } from '../fixtures/native-catalog'
import { submitNativePlatformQuery } from '../fixtures/native-query'
import { installArchiveFixture } from './postgres-archive-fixture'

const url = process.env.TEST_MIIT_ARCHIVE_PG_URL
vi.mock('@nuxtjs/mcp-toolkit/server', () => ({ defineMcpTool: (tool: unknown) => tool }))

const sources = {
  declarations: 'apply_list',
  'business-processes': 'business_list',
  'recognized-directory': 'recognized_list',
} as const
type Source = keyof typeof sources

const scenarios = {
  declarations: {
    first: { sblx: '申请', year: 2024, cszt: '通过', sqsj: '2024-06-01' },
    second: { sblx: '复核', year: 2025, cszt: '待审' },
    match: { declareKind: '申请', year: 2024 },
    cross: { declareKind: '申请', year: 2025 },
    version: { declarationYear: 2024, declareKind: 'apply', status: '通过' },
    options: { declareKinds: ['apply', 'review'], years: [2025, 2024], statuses: ['待审', '通过'] },
  },
  'business-processes': {
    first: { sblx: '申请', year: 2024, cszt: '通过', whpc: 'A', sqsj: '2024-06-01' },
    second: { sblx: '复核', year: 2025, cszt: '待审', whpc: 'B' },
    match: { rdjb: '2', declareKind: '申请', year: 2024, batch: 'A' },
    cross: { rdjb: '1', batch: 'A' },
    version: { businessYear: 2024, declareKind: 'apply', batch: 'A' },
    options: { declareKinds: ['apply', 'review'], years: [2025, 2024], batches: ['A', 'B'] },
  },
  'recognized-directory': {
    first: { rddqrq: '2028', whpcyear: '2024', whpc: 'A', szq: '3302', rdjb: '3' },
    second: { rddqrq: '2028-12-31', whpcyear: '2025', whpc: 'B', szq: '3303' },
    match: { rdjb: '2', titleRaw: '3', rddqrq: '2028', whpcyear: 2024, whpc: 'A', szq: '3302' },
    cross: { rddqrq: '2028', whpcyear: 2025 },
    version: { validityDateRaw: '2028', maintenanceYear: 2024, maintenanceBatch: 'A', district: '3302', titleRaw: '3' },
    options: { years: [], validityDates: ['2028', '2028-12-31'], districts: ['3302', '3303'] },
  },
} as const

let request: ReturnType<typeof toWebHandler>
let fixture: ReturnType<typeof nativeCatalogFixture>
let pgClient: pg.Client
const recordIds = new Map<NativeSource, number>()
const isolatedIds = new Map<NativeSource, { text: number; blob: number }>()
const rawArchive = '工信部原始响应🙂\n第二行'
let evidenceCoordinates: { queryId: number; relationId: number }
let reassignedCoordinates: { queryId: number; relationId: number; enterpriseId: number }
let snapshotIds: { from: number; to: number; other: number }
const capturedProjections = {
  declarations: ['platform_apply_projection', 'sql_fact_title_state'],
  'business-processes': ['platform_business_projection', 'sql_fact_title_state'],
  'recognized-directory': ['platform_recognized_projection', 'exact_title_state'],
} as const

async function read(backend: 'sqlite' | 'postgres', path: string, params: Record<string, string | number> = {}) {
  vi.stubEnv('NUXT_POSTGRES_DIRECTORY_URL', backend === 'postgres' ? url : undefined)
  const target = new URL('/api/platform/' + path, 'http://localhost')
  for (const [key, value] of Object.entries(params)) target.searchParams.set(key, String(value))
  const response = await request(new Request(target))
  return {
    status: response.status,
    cacheControl: response.headers.get('cache-control'),
    body: response.ok ? await response.json() : await response.json().then(body => body.statusMessage ?? body.message),
  }
}

beforeAll(async () => {
  if (!url) return
  fixture = nativeCatalogFixture()
  pgClient = new pg.Client({ connectionString: url })
  await pgClient.connect()

  const other = fixture.db.insert(schema.enterprise).values({
    name: '另一个归属企业', nameNorm: '宁波另一个归属企业', usccNorm: '91330211255994458Q',
  }).returning().get()
  const sqlite = fixture.db.$client
  sqlite.exec('DROP TRIGGER platform_apply_stored_no_update; DROP TRIGGER platform_process_stored_no_update; DROP TRIGGER recognized_stored_update')
  for (const source of Object.keys(sources) as Source[]) {
    const interfaceName = sources[source]
    const { first, second } = scenarios[source]
    const raw = fixture.raw('A', { ...first, privateEvidence: 'archive-private' })
    const stored = source === 'declarations'
      ? submitNativePlatformQuery(fixture.db, { ...fixture.query(interfaceName, raw, '2'), rawResponse: rawArchive })
      : fixture.seed(interfaceName, raw, '2')
    if (source === 'declarations') evidenceCoordinates = { queryId: stored.queryId, relationId: stored.relationIds[0]! }
    recordIds.set(interfaceName, stored.observations[0]!.recordId!)
    if (source === 'business-processes') {
      fixture.save(fixture.request('archive-review', [{
        action: 'create', status: 'confirmed', edge: fixture.edge(stored.relationIds[0]!),
      }]))
    }
    const later = fixture.seed(interfaceName, fixture.raw('A', second), '1')
    fixture.db.insert(schema.platformObservationAssignment).values({
      observationId: later.observations[0]!.observationId, revision: 2, enterpriseId: other.id,
      matchBasis: 'manual', verificationStatus: 'confirmed', origin: 'command',
    }).run()
    if (source === 'declarations') reassignedCoordinates = {
      queryId: later.queryId, relationId: later.relationIds[0]!, enterpriseId: other.id,
    }
    fixture.seed(interfaceName, fixture.raw('B', first), '2')
    const { id: _, ...unkeyed } = fixture.raw('', { rdjb: ' unknown ', ...(source !== 'recognized-directory' && { cszt: '孤立', year: 2022 }) })
    const text = fixture.seed(interfaceName, unkeyed, '3')
    const blob = fixture.seed(interfaceName, unkeyed, '3')
    isolatedIds.set(interfaceName, { text: text.relationIds[0]!, blob: blob.relationIds[0]! })
    const [table] = capturedProjections[source]
    const update = sqlite.prepare(`UPDATE ${table} SET exact_title_raw = ? WHERE observation_id = ?`)
    update.run(' unknown ', text.observations[0]!.observationId)
    update.run(Buffer.from([0, 255, 32]), blob.observations[0]!.observationId)
    if (source !== 'recognized-directory') {
      sqlite.prepare(`UPDATE ${table} SET exact_year = ? WHERE observation_id = ?`)
        .run(2022.5, blob.observations[0]!.observationId)
    }
  }

  const addBatch = (titleCode: string, revision: number, replacedBatchId?: number) =>
    fixture.db.insert(schema.platformExportBatch).values({
      titleCode, year: 2025, collectedOn: '2025-12-20', originalFilename: `快照-${revision}.xlsx`,
      sha256: String(revision).repeat(64), rowCount: 2, importStatus: 'imported', replacedBatchId,
    }).returning({ id: schema.platformExportBatch.id }).get().id
  const from = addBatch('specialized_sme', 1)
  snapshotIds = { from, to: addBatch('specialized_sme', 2, from), other: addBatch('little_giant', 3) }
  fixture.db.insert(schema.platformExportRow).values([
    { batchId: from, sourceRowNo: 7, usccRaw: ' a ', nameRaw: '公司甲', district: '海曙区' },
    { batchId: from, sourceRowNo: 8, usccRaw: 'B', nameRaw: '公司乙' },
    { batchId: snapshotIds.to, sourceRowNo: 9, usccRaw: 'A', nameRaw: '公司甲', district: '江北区' },
    { batchId: snapshotIds.to, sourceRowNo: 20, usccRaw: 'C', nameRaw: '公司丙' },
  ]).run()
  await installArchiveFixture(pgClient, fixture.db.$client)
  vi.stubGlobal('defineEventHandler', defineEventHandler)
  vi.stubGlobal('createError', createError)
  vi.stubGlobal('getMethod', getMethod)
  vi.stubGlobal('getQuery', getQuery)
  vi.stubGlobal('setHeader', setHeader)
  vi.stubGlobal('setResponseStatus', setResponseStatus)
  vi.stubEnv('NUXT_DB_READONLY', '1')
  vi.doMock('@db', () => ({ useDb: () => {
    if (process.env.NUXT_POSTGRES_DIRECTORY_URL) throw new Error('Unexpected SQLite access in PostgreSQL mode')
    return fixture.db
  } }))
  const router = createRouter()
    .get('/api/platform/declarations', (await import('../../../layers/sme-roster/server/api/platform/declarations.get')).default)
    .get('/api/platform/declarations/:recordId', (await import('../../../layers/sme-roster/server/api/platform/declarations/[recordId].get')).default)
    .get('/api/platform/business-processes', (await import('../../../layers/sme-roster/server/api/platform/business-processes.get')).default)
    .get('/api/platform/business-processes/:recordId', (await import('../../../layers/sme-roster/server/api/platform/business-processes/[recordId].get')).default)
    .get('/api/platform/recognized-directory', (await import('../../../layers/sme-roster/server/api/platform/recognized-directory.get')).default)
    .get('/api/platform/recognized-directory/:recordId', (await import('../../../layers/sme-roster/server/api/platform/recognized-directory/[recordId].get')).default)
    .get('/api/platform/filter-options', (await import('../../../layers/sme-roster/server/api/platform/filter-options.get')).default)
    .get('/api/platform/queries', (await import('../../../layers/sme-roster/server/api/platform/queries.get')).default)
    .get('/api/platform/snapshots', (await import('../../../layers/sme-roster/server/api/platform/snapshots.get')).default)
    .get('/api/platform/snapshots/diff', (await import('../../../layers/sme-roster/server/api/platform/snapshots/diff.get')).default)
    .get('/api/platform/queries/:queryId/evidence', (await import('../../../layers/sme-roster/server/api/platform/queries/[queryId]/evidence.get')).default)
  request = toWebHandler(createApp().use(router))
}, 30_000)

afterAll(async () => {
  await closePostgresDirectoryDb()
  await pgClient?.end()
  fixture?.close()
  vi.doUnmock('@db')
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

it.skipIf(!url)('reads export snapshots and row-level differences from the same PostgreSQL snapshot', async () => {
  const { from, to, other } = snapshotIds
  const params = { title: 'specialized_sme', year: '2025,2026' }
  const listed = await read('postgres', 'snapshots', params)
  expect(listed).toEqual(await read('sqlite', 'snapshots', params))
  expect(listed).toMatchObject({ status: 200, body: { count: 2, rows: [{ batch: { id: from } }, { batch: { id: to }, replacedBatchId: from }] } })
  const compared = await read('postgres', 'snapshots/diff', { from, to })
  expect(compared).toEqual(await read('sqlite', 'snapshots/diff', { from, to }))
  expect(compared).toMatchObject({ status: 200, body: { diff: {
    added: [{ sourceRowNo: 20 }], removed: [{ sourceRowNo: 8 }], unchanged: 0,
    changed: [{ fromSourceRowNo: 7, toSourceRowNo: 9, fields: [{ field: 'district', from: '海曙区', to: '江北区' }] }],
  } } })
  for (const scope of [{ from, to: other }, { from, to: 9_000_000 }, { from: 'bogus', to }]) {
    expect(await read('postgres', 'snapshots/diff', scope)).toEqual(await read('sqlite', 'snapshots/diff', scope))
  }
})

it.skipIf(!url)('reads historical query summaries with stable pages, title scope and the latest owner', async () => {
  const filter = { view: 'summary', pageSize: 2 }
  const first = await read('postgres', 'queries', filter)
  const second = await read('postgres', 'queries', { ...filter, page: 2 })
  expect(first.status).toBe(200)
  expect(first).toEqual(await read('sqlite', 'queries', filter))
  expect(second).toEqual(await read('sqlite', 'queries', { ...filter, page: 2 }))
  expect(first.body.rows).toHaveLength(2)
  expect(first.body.rows[0]).toMatchObject({
    relations: [], relationsIncluded: false, query: { relationCount: 1 },
  })
  expect(first.body.rows[0].query).not.toHaveProperty('collectionEvidence')
  const scopes: Record<string, string | number>[] = [
    { titleCode: 'specialized_sme', interface: 'apply_list' },
    { status: 'success', uscc: fixture.enterprise.usccNorm! },
    { enterpriseId: reassignedCoordinates.enterpriseId },
    { enterpriseId: fixture.enterprise.id, queryId: reassignedCoordinates.queryId },
    { enterpriseId: 1.5 },
    { page: Number.MAX_SAFE_INTEGER },
  ]
  for (const scope of scopes) {
    const params = { ...filter, ...scope }
    expect(await read('postgres', 'queries', params)).toEqual(await read('sqlite', 'queries', params))
  }
  const owned = await read('postgres', 'queries', {
    view: 'summary', enterpriseId: reassignedCoordinates.enterpriseId, queryId: reassignedCoordinates.queryId,
  })
  expect(owned.body).toMatchObject({ total: 1, rows: [{ query: { id: reassignedCoordinates.queryId, relationCount: 1 } }] })
  vi.stubEnv('NUXT_POSTGRES_DIRECTORY_URL', url)
  const tool = (await import('../../../layers/sme-roster/server/mcp/tools/list_platform_queries')).default as unknown as {
    handler(input: { view: 'summary'; pageSize: number }): Promise<unknown>
  }
  expect(await tool.handler({ view: 'summary', pageSize: 2 })).toEqual(first.body)
})

it.skipIf(!url)('reads original bytes and persisted relation evidence through HTTP and MCP', async () => {
  const { queryId, relationId } = evidenceCoordinates
  const path = `queries/${queryId}/evidence`
  const raw = Buffer.from(rawArchive)
  for (const offset of [0, 1, raw.length, Number.MAX_SAFE_INTEGER - 65536]) {
    const length = 3
    const result = await read('postgres', path, { field: 'rawResponse', offset, length })
    expect(result).toEqual(await read('sqlite', path, { field: 'rawResponse', offset, length }))
    expect(result).toMatchObject({ status: 200, body: { data: raw.subarray(offset, offset + length).toString('base64'), totalBytes: raw.length, isNull: false } })
  }
  for (const field of ['collectionEvidence', 'legacyProvenance', 'relations']) {
    expect(await read('postgres', path, { field })).toEqual(await read('sqlite', path, { field }))
  }
  const relation = { field: 'relation', relationId }
  const result = await read('postgres', path, relation)
  const previous = await read('sqlite', path, relation)
  expect(result.status).toBe(200)
  expect(JSON.parse(Buffer.from(result.body.data, 'base64').toString('utf8')))
    .toEqual(JSON.parse(Buffer.from(previous.body.data, 'base64').toString('utf8')))
  expect(await read('postgres', path, { field: 'relation', relationId: relationId + 2_000_000 }))
    .toMatchObject({ status: 404, body: 'Platform evidence not found' })
  expect(await read('postgres', path, { field: 'rawResponse', length: 65537 })).toMatchObject({ status: 400 })
  const reassigned = await read('postgres', `queries/${reassignedCoordinates.queryId}/evidence`, {
    field: 'relation', relationId: reassignedCoordinates.relationId,
  })
  expect(reassigned.status).toBe(200)
  expect(JSON.parse(Buffer.from(reassigned.body.data, 'base64').toString('utf8'))).toMatchObject({
    enterpriseId: reassignedCoordinates.enterpriseId, matchBasis: 'manual', verificationStatus: 'confirmed',
  })

  vi.stubEnv('NUXT_POSTGRES_DIRECTORY_URL', url)
  const tool = (await import('../../../layers/sme-roster/server/mcp/tools/get_platform_query_evidence')).default as unknown as {
    handler(input: { queryId: number; field: 'rawResponse'; length: number }): Promise<unknown>
  }
  expect(await tool.handler({ queryId, field: 'rawResponse', length: 3 })).toMatchObject({
    queryId, totalBytes: raw.length, data: raw.subarray(0, 3).toString('base64'),
  })
})

it.skipIf(!url)('returns the original byte ranges of T04 and supplemented legacy provenance', async () => {
  const { queryId } = evidenceCoordinates
  const { rows: [collection] } = await pgClient.query('SELECT collection_id FROM business.platform_legacy_query_alias WHERE old_id=$1', [queryId])
  const archiveId = 9_000_000
  const raw = Buffer.from('{ "原档": "宁波🙂" }')
  const fields: [string, string, string | Buffer][] = [
    ['query_id', 'integer', String(queryId)], ['source_identity', 'text', 'fixture'],
    ['source_sha256', 'text', 'a'.repeat(64)], ['segment_index', 'integer', '0'], ['collection', 'text', raw],
    ['input_fingerprint', 'text', 'b'.repeat(64)], ['import_batch_id', 'integer', '1'], ['created_at', 'null', ''],
  ]
  const envelope = Buffer.concat([Buffer.from('T04-PROVENANCE\n'), ...fields.flatMap(([name, type, value]) => {
    const bytes = typeof value === 'string' ? Buffer.from(value) : value
    return [Buffer.from(`${name} ${type} ${bytes.length}\n`), bytes, Buffer.from('\n')]
  })])
  const path = `queries/${queryId}/evidence`
  try {
    await pgClient.query('INSERT INTO business.platform_archive_value VALUES ($1,$2,$3,$4)', [archiveId, 'blob', envelope, envelope.length])
    await pgClient.query("INSERT INTO business.platform_collection_legacy_provenance VALUES ($1,'t04_envelope',$2)", [collection.collection_id, archiveId])
    await pgClient.query("INSERT INTO business.platform_collection_archive_ref VALUES ($1,'legacyProvenance',$2,1)", [collection.collection_id, archiveId])
    const expected = { status: 200, body: { isNull: false, totalBytes: raw.length, data: raw.subarray(6, 10).toString('base64') } }
    expect(await read('postgres', path, { field: 'legacyProvenance', offset: 6, length: 4 })).toMatchObject(expected)
    await pgClient.query("DELETE FROM business.platform_collection_archive_ref WHERE archive_id=$1", [archiveId])
    await pgClient.query("UPDATE business.platform_collection_legacy_provenance SET origin='supplement' WHERE archive_id=$1", [archiveId])
    await pgClient.query("UPDATE business.platform_archive_value SET storage_class='text', bytes=$2, byte_length=$3 WHERE id=$1", [archiveId, raw, raw.length])
    expect(await read('postgres', path, { field: 'legacyProvenance', offset: 6, length: 4 })).toMatchObject(expected)
  } finally {
    await pgClient.query('DELETE FROM business.platform_collection_archive_ref WHERE archive_id=$1', [archiveId])
    await pgClient.query('DELETE FROM business.platform_collection_legacy_provenance WHERE archive_id=$1', [archiveId])
    await pgClient.query('DELETE FROM business.platform_archive_value WHERE id=$1', [archiveId])
  }
})

it.skipIf(!url).each(Object.keys(sources) as Source[])('%s HTTP filters and exposes the matching archived version and all history', async source => {
  const { match, cross, version } = scenarios[source]
  const id = recordIds.get(sources[source])!
  const filtered = { ...match, platformKey: 'A', pageSize: 1 }
  const listed = await read('postgres', source, filtered)
  expect(listed).toEqual(await read('sqlite', source, filtered))
  expect(listed).toMatchObject({ status: 200, cacheControl: 'no-store', body: {
    total: 1, pageSize: 1, rows: [{ record: { id, platformKey: 'A' }, matchedVersion: version, matchedVersionCount: 1, versionCount: 2 }],
  } })

  const ownerQuery = { platformKey: 'A', enterpriseId: fixture.enterprise.id, q: '91330211255994458q' }
  const owner = await read('postgres', source, ownerQuery)
  expect(owner).toEqual(await read('sqlite', source, ownerQuery))
  expect(owner).toMatchObject({ status: 200, body: { total: 0 } })
  const wildcard = { platformKey: 'A', q: '91330211%458_' }
  const partial = await read('postgres', source, wildcard)
  expect(partial).toEqual(await read('sqlite', source, wildcard))
  expect(partial).toMatchObject({ status: 200, body: { total: 1 } })

  const excluded = await read('postgres', source, { ...cross, platformKey: 'A' })
  expect(excluded).toMatchObject({ status: 200, body: { total: 0, rows: [] } })

  const detail = await read('postgres', source + '/' + id)
  expect(detail).toEqual(await read('sqlite', source + '/' + id))
  expect(detail).toMatchObject({ status: 200, cacheControl: 'no-store', body: { counts: { versions: 2, observations: 2 } } })
  expect(JSON.stringify(detail.body)).not.toContain('archive-private')
  if (source === 'business-processes') {
    expect(detail.body.observations[0].correspondenceRefs).toEqual([])
    expect(detail.body.observations[1].correspondenceRefs).toEqual([{ id: 1, status: 'confirmed', revision: 2 }])
  }
  if (source === 'recognized-directory') {
    expect(detail.body.conflicts).toEqual(['title_conflict', 'enterprise_assignment_conflict'])
    expect(detail.body.observations[1]).toMatchObject({ titleScopes: ['2'], titleConflict: true })
  }

  const page = await read('postgres', source, { page: 2, pageSize: 1 })
  expect(page).toEqual(await read('sqlite', source, { page: 2, pageSize: 1 }))
  expect(page.body).toMatchObject({ total: 2, rows: [{ record: { platformKey: 'A' } }] })
})

it.skipIf(!url).each(Object.keys(sources) as Source[])('%s HTTP preserves isolated cells, filter options and validation errors', async source => {
  for (const view of ['records', 'isolated'] as const) {
    const options = await read('postgres', 'filter-options', { source, view })
    expect(options).toEqual(await read('sqlite', 'filter-options', { source, view }))
    expect(options).toMatchObject({ status: 200, cacheControl: 'no-store',
      body: view === 'records' ? scenarios[source].options : {
        titles: [' unknown ', { type: 'Buffer', data: [0, 255, 32] }],
        years: source === 'recognized-directory' ? [] : [2022],
      } })
  }
  const input = { view: 'isolated', titleRaw: ' unknown ' }
  const isolated = await read('postgres', source, input)
  expect(isolated).toEqual(await read('sqlite', source, input))
  expect(isolated).toMatchObject({ status: 200, body: { total: 1, rows: [{ kind: 'observation', titleRaw: ' unknown ' }] } })

  const all = await read('postgres', source, { view: 'isolated' })
  expect(all).toEqual(await read('sqlite', source, { view: 'isolated' }))
  expect(all).toMatchObject({ status: 200, body: { total: 2, rows: [
    { relationId: isolatedIds.get(sources[source])!.blob, titleRaw: { type: 'Buffer', data: [0, 255, 32] } },
    { relationId: isolatedIds.get(sources[source])!.text, titleRaw: ' unknown ' },
  ] } })
  if (source !== 'recognized-directory') {
    const yearField = source === 'declarations' ? 'declarationYear' : 'businessYear'
    expect(all.body.rows[0][yearField]).toBe(2022.5)
    expect(await read('postgres', source, { view: 'isolated', year: 2022 })).toMatchObject({
      status: 200, body: { total: 1, rows: [{ relationId: isolatedIds.get(sources[source])!.text, [yearField]: 2022 }] },
    })
  }

  const errors = [
    { path: source + '/0', status: 400 },
    { path: source + '/9007199254740991', status: 404 },
    { path: source, params: { pageSize: 201 }, status: 400 },
  ]
  for (const { path, params, status } of errors) {
    const postgres = await read('postgres', path, params)
    expect(postgres).toEqual(await read('sqlite', path, params))
    expect(postgres.status).toBe(status)
  }
})

const tools = {
  declarations: async () => [
    (await import('../../../layers/sme-roster/server/mcp/tools/list_platform_declarations')).default,
    (await import('../../../layers/sme-roster/server/mcp/tools/get_platform_declaration')).default,
  ] as const,
  'business-processes': async () => [
    (await import('../../../layers/sme-roster/server/mcp/tools/list_platform_business_processes')).default,
    (await import('../../../layers/sme-roster/server/mcp/tools/get_platform_business_process')).default,
  ] as const,
  'recognized-directory': async () => [
    (await import('../../../layers/sme-roster/server/mcp/tools/list_platform_recognized_directory')).default,
    (await import('../../../layers/sme-roster/server/mcp/tools/get_platform_recognized_record')).default,
  ] as const,
}
type ToolResult = { structuredContent: unknown; content: { text: string }[] }

it.skipIf(!url).each(Object.keys(sources) as Source[])('%s MCP list and detail use the same PostgreSQL contract as HTTP', async source => {
  const listInput = { ...scenarios[source].match, platformKey: 'A' }
  const recordId = recordIds.get(sources[source])!
  const [list, detail] = await tools[source]()
  const expectedList = await read('postgres', source, listInput)
  const expectedDetail = await read('postgres', source + '/' + recordId)
  const listed = await Reflect.apply(list.handler!, undefined, [listInput]) as ToolResult
  const readDetail = await Reflect.apply(detail.handler!, undefined, [{ recordId }]) as ToolResult
  expect(listed.structuredContent).toEqual(expectedList.body)
  expect(JSON.parse(listed.content[0]!.text)).toEqual(expectedList.body)
  expect(readDetail.structuredContent).toEqual(expectedDetail.body)
  expect(JSON.parse(readDetail.content[0]!.text)).toEqual(expectedDetail.body)

  await expect(Reflect.apply(list.handler!, undefined, [{ page: 0 }])).rejects.toMatchObject({ statusCode: 400 })
  await expect(Reflect.apply(detail.handler!, undefined, [{ recordId: 999999 }])).rejects.toMatchObject({ statusCode: 404 })
})

it.skipIf(!url).each(Object.keys(sources) as Source[])('%s rejects unready captures before empty list and filter-options results', async source => {
  const [table, state] = capturedProjections[source]
  const interfaceName = sources[source]
  const recordId = recordIds.get(interfaceName)!
  const sqlite = fixture.db.$client
  const update = sqlite.prepare(`UPDATE ${table} SET ${state} = ? WHERE observation_id =
    (SELECT min(id) FROM platform_business_observation WHERE record_id = ?)`)
  const updatePg = (value: string) => pgClient.query(`UPDATE business.${table} SET ${state} = $1 WHERE observation_id =
    (SELECT min(id) FROM business.platform_business_observation WHERE record_id = $2)`, [value, recordId])
  sqlite.pragma('ignore_check_constraints = ON')
  sqlite.pragma('foreign_keys = OFF')
  try {
    update.run('uncaptured', recordId)
    await updatePg('uncaptured')
    for (const [path, params] of [
      [source, { platformKey: 'absent', page: 51 }],
      ['filter-options', { source }],
      [source + '/' + recordId, {}],
    ] as [string, Record<string, string | number>][]) {
      const result = await read('postgres', path, params)
      expect(result).toEqual(await read('sqlite', path, params))
      expect(result.status).toBe(409)
    }
    const missing = await read('postgres', source + '/999999')
    expect(missing).toEqual(await read('sqlite', source + '/999999'))
    expect(missing.status).toBe(source === 'declarations' ? 404 : 409)
  } finally {
    update.run('captured', recordId)
    sqlite.pragma('foreign_keys = ON')
    sqlite.pragma('ignore_check_constraints = OFF')
    await updatePg('captured')
  }
})

it.skipIf(!url)('list capture, count and page use one PostgreSQL snapshot during a concurrent collection update', async () => {
  const recordId = recordIds.get('apply_list')!
  const params = { platformKey: 'A' }
  const expected = await read('postgres', 'declarations', params)
  expect(expected.status).toBe(200)

  await pgClient.query('BEGIN')
  let inFlight: ReturnType<typeof read> | undefined
  try {
    await pgClient.query('LOCK TABLE business.platform_business_record_version IN ACCESS EXCLUSIVE MODE')
    inFlight = read('postgres', 'declarations', params)
    await expect.poll(async () => {
      const { rows } = await pgClient.query(`SELECT 1 FROM pg_locks
        WHERE relation = 'business.platform_business_record_version'::regclass AND NOT granted`)
      return rows.length
    }).toBe(1)
    await pgClient.query(`UPDATE business.platform_collection SET last_collected_at = '2026-12-01'
      WHERE id IN (SELECT collection_id FROM business.platform_business_observation WHERE record_id = $1)`, [recordId])
    await pgClient.query('COMMIT')
    expect(await inFlight).toEqual(expected)
    expect(await read('postgres', 'declarations', params)).toMatchObject({
      status: 200, body: { rows: [{ latestObservationAt: '2026-12-01' }] },
    })
  } finally {
    await pgClient.query('ROLLBACK')
    await inFlight
  }
})

it.skipIf(!url)('detail bounds version and observation history while retaining unprojected versions', async () => {
  await pgClient.query(`
    INSERT INTO business.platform_business_record (id, platform_key, interface, identity_rule_version, created_at)
      VALUES (10000, 'HISTORY', 'apply_list', 'rule', '2025-01-01');
    INSERT INTO business.platform_business_record_version (id, record_id, hash_algorithm, content_hash, created_at)
      SELECT 10000 + n, 10000, 'sha256', lpad(n::text, 64, '0'), '2025-01-01' FROM generate_series(1, 101) n;
    INSERT INTO business.platform_collection (id, interface, rdjb, queried_at, query_key, status)
      VALUES (10000, 'apply_list', '2', '2026-01-01', 'archive-history', 'success');
    INSERT INTO business.platform_legacy_query_alias (old_id, collection_id) VALUES (20000, 10000);
    INSERT INTO business.platform_business_observation (id, collection_id, record_id, version_id, sequence_no,
      identity_state, content_state, key_source, projection_rule_version)
      SELECT 10000 + n, 10000, 10000, 10000 + least(n, 101), n, 'resolved', 'verified', 'both', 'rule'
      FROM generate_series(1, 201) n;
    INSERT INTO business.platform_legacy_relation_alias (old_id, observation_id)
      SELECT 20000 + n, 10000 + n FROM generate_series(1, 201) n;
    INSERT INTO business.platform_apply_projection (id, observation_id, exact_stored_state, sql_fact_title_state)
      SELECT 10000 + n, 10000 + n, 'captured', 'captured' FROM generate_series(1, 201) n;
  `)
  const detail = await read('postgres', 'declarations/10000')
  expect(detail.status).toBe(200)
  expect(detail.body.counts).toEqual({ versions: 101, observations: 201, versionsTruncated: true, observationsTruncated: true })
  expect(detail.body.versions).toHaveLength(100)
  expect(detail.body.versions.at(0)).toMatchObject({ versionId: 10101, observationCount: 101, titleRaw: null })
  expect(detail.body.versions.at(-1)).toMatchObject({ versionId: 10002, observationCount: 1 })
  expect(detail.body.observations).toHaveLength(200)
  expect(detail.body.observations.at(0)).toMatchObject({
    relationId: 20201, queryId: 20000, version: { versionId: 10101, declarationYear: null },
  })
  expect(detail.body.observations.at(-1)).toMatchObject({ relationId: 20002, queryId: 20000 })
})
