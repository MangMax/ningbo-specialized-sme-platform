import { ensurePlatformObservation } from '../server/utils/platform-business-record'
import * as legacySchema from '../db/schema'
import Database from 'better-sqlite3'
import { assertExpandRuntime } from '../db/schema-phase'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { createApp, createRouter, toWebHandler, defineEventHandler, createError } from 'h3'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { processReaderFixture } from './helpers/process-target-734'
import { targetSchema } from '../lib/platform/target-schema'
import { listPlatformBusinessProcesses, getPlatformBusinessProcess } from '../server/utils/platform-business-processes'
import { readPlatformFilterOptions } from '../server/utils/platform-filter-options'
import { writeCollectionTarget } from '../lib/platform/collection-target-command'

const responses: unknown[] = []
const statements: { sql: string; params: unknown[] }[] = []
let fixture: Awaited<ReturnType<typeof processReaderFixture>>
let request: ReturnType<typeof toWebHandler>
let listTool: typeof import('../server/mcp/tools/list_platform_business_processes')['default']
let detailTool: typeof import('../server/mcp/tools/get_platform_business_process')['default']
const json = (value: unknown) => JSON.parse(JSON.stringify(value))
async function get(path = '') {
  const response = await request(new Request(`http://localhost/api/platform/${path}`))
  const body = await response.json()
  responses.push({ path, status: response.status, cacheControl: response.headers.get('cache-control'), body })
  return { response, body }
}
async function mcp(input: unknown, detail = false) {
  const tool = detail ? detailTool : listTool
  const result = await Reflect.apply(tool.handler!, undefined, [input])
  expect(JSON.parse(result.content[0].text)).toEqual(json(result.structuredContent))
  responses.push({ mcpHandler: detail ? 'detail' : 'list', input, result })
  return json(result.structuredContent)
}
beforeAll(async () => {
  fixture = await processReaderFixture(false, source => {
    source.exec("INSERT INTO platform_query(id,interface,query_key,rdjb,queried_at,status,created_at) VALUES(100,'business_list','bounds','2','zz','success','c')")
    const insert = source.prepare('INSERT INTO platform_relation(query_id,sequence_no,relation_key,raw_fields,created_at) VALUES(100,?,?,?,\'c\')')
    for (let i = 0; i < 201; i++) insert.run(i + 1, 'MANY', JSON.stringify({ id: 'MANY', rdjb: '2', cszt: `history-${i % 101}` }))
    for (let i = 0; i < 205; i++) insert.run(i + 202, `EXTRA-${i}`, JSON.stringify({ id: `EXTRA-${i}`, rdjb: '2', year: '2090', cszt: i === 204 ? 'outside-page' : 'common' }))
    const old = drizzle(source, { schema: legacySchema })
    for (const { id } of old.select({ id: legacySchema.platformRelation.id }).from(legacySchema.platformRelation).all()) ensurePlatformObservation(old, id)
  })
  const db = drizzle(fixture.t, { schema: targetSchema, logger: { logQuery(sql, params) { statements.push({ sql, params }) } } })
  // Test application wiring only: actual handlers execute their actual ORM on this target.
  vi.doMock('@db', () => ({ useDb: () => db }))
  vi.doMock('@nuxtjs/mcp-toolkit/server', () => ({ defineMcpTool: (tool: unknown) => tool }))
  vi.stubGlobal('defineEventHandler', defineEventHandler)
  vi.stubGlobal('createError', createError)
  const router = createRouter()
    .get('/api/platform/business-processes', (await import('../server/api/platform/business-processes.get')).default)
    .get('/api/platform/business-processes/:recordId', (await import('../server/api/platform/business-processes/[recordId].get')).default)
    .get('/api/platform/filter-options', (await import('../server/api/platform/filter-options.get')).default)
  request = toWebHandler(createApp().use(router))
  listTool = (await import('../server/mcp/tools/list_platform_business_processes')).default
  detailTool = (await import('../server/mcp/tools/get_platform_business_process')).default
}, 120000)
afterAll(() => {
  if (process.env.PROCESS_STORED_EVIDENCE_DIR) writeFileSync(join(process.env.PROCESS_STORED_EVIDENCE_DIR, 'HTTP-MCP-SQL.json'), JSON.stringify(statements, null, 2))
  if (process.env.PROCESS_STORED_EVIDENCE_DIR) writeFileSync(join(process.env.PROCESS_STORED_EVIDENCE_DIR, 'HTTP-RESPONSES.json'), JSON.stringify(responses, null, 2))
  fixture?.close()
  vi.doUnmock('@db'); vi.doUnmock('@nuxtjs/mcp-toolkit/server'); vi.unstubAllGlobals()
})
it('real HTTP and MCP preserve independent legacy records isolated filters pages details and no-store', async () => {
  for (const input of [{}, { view: 'isolated' }, { view: 'isolated', status: 'pending' }, { view: 'isolated', titleRaw: ' X ' }, { titleRaw: '2' }, { titleRaw: '3' }, { declareKind: '申请' }, { year: 2024 }, { status: 'done' }, { batch: 'C' }, { rdjb: '2' }, { rdjb: '3', titleRaw: '2', year: 2025, declareKind: 'review', status: 'done', batch: 'C' }, { year: 2024, batch: 'C' }, { q: 'U2' }, { platformKey: 'A' }, { enterpriseId: 1 }, { q: 'Alpha' }, { pageSize: 1, page: 2 }, { page: 999 }]) {
    const query = new URLSearchParams(Object.entries(input).map(([k, v]) => [k, String(v)]))
    const { response, body } = await get(`business-processes?${query}`)
    expect(response.status, query.toString()).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(body).toEqual(json(listPlatformBusinessProcesses(input, fixture.old)))
    expect(await mcp(input)).toEqual(body)
  }
  const literal = await mcp({ status: 'pending', platformKey: 'A' })
  expect(literal.rows[0]).toMatchObject({ record: { platformKey: 'A' }, matchedVersionCount: 1, versionCount: 2, observationCount: 3, enterpriseIds: [1, 2], conflicts: ['enterprise_assignment_conflict'] })
  for (const row of listPlatformBusinessProcesses({}, fixture.old).rows) {
    if (row.kind !== 'record') throw new Error('expected record')
    const { response, body } = await get(`business-processes/${row.record.id}`)
    expect(response.status).toBe(200)
    expect(body).toEqual(json(getPlatformBusinessProcess(fixture.old, row.record.id)))
    expect(await mcp({ recordId: row.record.id }, true)).toEqual(body)
    expect(JSON.stringify(body)).not.toMatch(/canonicalRawJson|rawFields|rawResponse/)
  }
})
it('public pagination caps at 200 and detail reports 101 versions 201 observations without silent truncation', async () => {
  const page = await get('business-processes?year=2090&pageSize=200')
  expect(page.body.total).toBe(205); expect(page.body.rows).toHaveLength(200)
  const second = await get('business-processes?year=2090&pageSize=200&page=2')
  expect(second.body.rows).toHaveLength(5)
  expect(await mcp({ year: 2090, pageSize: 200, page: 2 })).toEqual(second.body)
  const many = (await get('business-processes?platformKey=MANY')).body.rows[0]
  const detail = (await get(`business-processes/${many.record.id}`)).body
  expect(detail.counts).toEqual({ versions: 101, observations: 201, versionsTruncated: true, observationsTruncated: true })
  expect(detail.versions).toHaveLength(100); expect(detail.observations).toHaveLength(200)
  expect(detail).toEqual(json(getPlatformBusinessProcess(fixture.old, many.record.id)))
  expect(await mcp({ recordId: many.record.id }, true)).toEqual(detail)
  expect((await get('filter-options?source=business-processes')).body.statuses).toContain('outside-page')
})
it('business-processes HTTP options retain exact whitespace BLOB titles and global candidates', async () => {
  for (const view of ['records', 'isolated']) {
    const { response, body } = await get(`filter-options?source=business-processes&view=${view}`)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(body).toEqual(json(readPlatformFilterOptions({ source: 'business-processes', view }, fixture.old)))
    if (view === 'isolated') expect(body).toMatchObject({ titles: expect.arrayContaining([' X ']), statuses: expect.arrayContaining([' pending ', 'other']) })
  }
})
it('HTTP and MCP preserve invalid input and missing detail errors', async () => {
  for (const path of ['business-processes?year=bad', 'business-processes?view=bad', 'business-processes?pageSize=201', 'business-processes?page=0', 'business-processes?titleRaw=', 'business-processes?titleRaw=1&titleRaw=2', 'business-processes/0', 'filter-options', 'filter-options?source=business-processes&view=records&view=isolated', 'filter-options?source=business-processes&page=2']) {
    const { response } = await get(path)
    expect(response.status, path).toBe(400)
    expect(response.headers.get('cache-control')).toBe('no-store')
  }
  const missing = await get('business-processes/99999')
  expect(missing.response.status).toBe(404)
  expect(missing.body.statusMessage).toBe('Business process record not found')
  expect((await get('business-processes?year=bad')).body.statusMessage).toBe('year must be a positive integer')
  expect((await get('business-processes?view=bad')).body.statusMessage).toBe('Invalid business process query parameters')
  expect((await get('business-processes/0')).body.statusMessage).toBe('recordId must be a positive safe integer')
  await expect(mcp({ page: 0 })).rejects.toMatchObject({ statusCode: 400, code: 'invalid_business_process_filter' })
  await expect(mcp({ recordId: 0 }, true)).rejects.toMatchObject({ statusCode: 400, code: 'invalid_business_process_id' })
  await expect(mcp({ recordId: 99999 }, true)).rejects.toMatchObject({ statusCode: 404, code: 'business_process_not_found' })
})
it('new W ordinary and reference replay are publicly readable with old namespace aliases distinct from target IDs', async () => {
  fixture.t.exec("UPDATE platform_legacy_alias_sequence SET high_water=1000 WHERE namespace='relation'; UPDATE platform_legacy_alias_sequence SET high_water=2000 WHERE namespace='query'")
  const command = { queryText: JSON.stringify({ interface: 'business_list', queryKey: 'new', rdjb: '2', queriedAt: 'newtime', status: 'success', rawResponse: '{}', relations: [{ sequenceNo: 1, status: ' pending ', declareKind: '申请', rawFields: { id: 'NEW', rdjb: ' 2 ', cszt: 'pending', year: '2024' } }] }), evidenceText: null, createdAt: 'creation', assignments: [{ matchBasis: 'none' as const, verificationStatus: 'pending' as const, origin: 'command' as const, actor: { type: 'agent' as const, id: 'R2b' }, basis: 'explicit' }] }
  const written = writeCollectionTarget(fixture.db, command)
  const initial = (await get('business-processes?platformKey=NEW')).body
  expect(writeCollectionTarget(fixture.db, command).reused).toBe(true)
  expect((await get('business-processes?platformKey=NEW')).body).toEqual(initial)
  const ref = JSON.parse(command.queryText)
  ref.reuseExisting = true; delete ref.rawResponse; delete ref.status; ref.relations = [{ sequenceNo: 1 }]
  expect(writeCollectionTarget(fixture.db, { ...command, queryText: JSON.stringify(ref), assignments: [] }).reused).toBe(true)
  const body = (await get('business-processes?platformKey=NEW')).body
  expect(body).toEqual(initial)
  expect(await mcp({ platformKey: 'NEW' })).toEqual(body)
  expect(body.rows[0]).toMatchObject({ matchedVersion: { status: 'pending', businessYear: 2024 }, observationCount: 1, versionCount: 1 })
  const observation = written.observations[0]!
  expect(observation.relationAlias).toBe(1001)
  expect(observation.observationId).not.toBe(1001)
  const detail = (await get(`business-processes/${observation.recordId}`)).body
  expect(detail.observations[0]).toMatchObject({ relationId: 1001, queryId: 2001 })
  expect(await mcp({ recordId: observation.recordId }, true)).toEqual(detail)
  expect((await get('filter-options?source=business-processes')).body.statuses).toContain('pending')
})
it('HTTP and MCP preserve all eight exact SQLite cell types blanks NULL and BLOB values', async () => {
  const old = new Database(fixture.legacySource)
  const legacyCells = drizzle(old, { schema: legacySchema })
  try {
    for (const [column, target] of [['year', 'exact_year'], ['status', 'exact_status'], ['title_raw', 'exact_title_raw'], ['declare_kind', 'exact_declare_kind'], ['applied_at', 'exact_applied_at'], ['batch', 'exact_batch'], ['award_batch_label', 'exact_award_batch_label'], ['province', 'exact_province']]) {
      for (const value of [2024.5, '  unknown  ', Buffer.from('raw-cell'), null]) {
        old.exec('SAVEPOINT cell'); fixture.t.exec('SAVEPOINT cell')
        try {
          const trigger = fixture.t.prepare("SELECT sql FROM sqlite_schema WHERE type='trigger' AND name='platform_process_stored_no_update'").get() as { sql: string }
          fixture.t.exec('DROP TRIGGER platform_process_stored_no_update')
          old.prepare(`UPDATE platform_relation SET ${column}=? WHERE id=5`).run(value)
          fixture.t.prepare(`UPDATE platform_business_projection SET ${target}=? WHERE observation_id=(SELECT observation_id FROM platform_legacy_relation_alias WHERE old_id=5)`).run(value)
          fixture.t.exec(trigger.sql)
          const body = (await get('business-processes?view=isolated')).body
          expect(body).toEqual(json(listPlatformBusinessProcesses({ view: 'isolated' }, legacyCells)))
          expect(await mcp({ view: 'isolated' })).toEqual(body)
          expect((await get('filter-options?source=business-processes&view=isolated')).body).toEqual(json(readPlatformFilterOptions({ source: 'business-processes', view: 'isolated' }, legacyCells)))
          const field = { year: 'businessYear', status: 'status', title_raw: 'titleRaw', declare_kind: 'declareKind', applied_at: 'appliedAt', batch: 'batch', award_batch_label: 'awardBatchLabel', province: 'province' }[column!]!
          expect(body.rows.find((row: { relationId: number }) => row.relationId === 5)[field]).toEqual(json((old.prepare(`SELECT ${column} AS value FROM platform_relation WHERE id=5`).get() as {value: unknown}).value))
        } finally { old.exec('ROLLBACK TO cell; RELEASE cell'); fixture.t.exec('ROLLBACK TO cell; RELEASE cell') }
      }
    }
  } finally { old.close() }
})
it('public target SQL never reads legacy entities or business JSON and rejects uncaptured before empty filtering', async () => {
  expect(statements.map(row => row.sql).join('\n')).not.toMatch(/\b(?:platform_query|platform_relation)\b|\bjson\w*\s*\(/i)
  expect(() => assertExpandRuntime(fixture.t)).toThrow(/finalized|phase|runtime/i)
  expect(statements.map(row => row.sql).join('\n')).not.toMatch(/(?:from|join)\s+"?platform_archive/i)
  expect(fixture.t.pragma('foreign_key_check')).toEqual([])
  expect(fixture.t.pragma('integrity_check', { simple: true })).toBe('ok')
  const trigger = fixture.t.prepare("SELECT sql FROM sqlite_schema WHERE name='platform_process_stored_no_update'").get() as { sql: string }
  fixture.t.exec("DROP TRIGGER platform_process_stored_no_update; PRAGMA ignore_check_constraints=ON; PRAGMA foreign_keys=OFF; UPDATE platform_business_projection SET sql_fact_title_state=NULL WHERE observation_id=1")
  fixture.t.exec(trigger.sql)
  expect((await get('business-processes?platformKey=absent&page=999')).response.status).toBe(409)
  expect((await get('filter-options?source=business-processes')).response.status).toBe(409)
  await expect(mcp({ platformKey: 'absent' })).rejects.toMatchObject({ statusCode: 409, code: 'process_target_uncaptured' })
})
