import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { createApp, createRouter, toWebHandler, defineEventHandler, createError } from 'h3'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ready, records } from './helpers/declarations-target'
import * as legacySchema from '../db/schema'
import { targetSchema } from '../lib/platform/target-schema'
import { listPlatformDeclarations, getPlatformDeclaration } from '../server/utils/platform-declarations'
import { readPlatformFilterOptions } from '../server/utils/platform-filter-options'
import { writeCollectionTarget } from '../lib/platform/collection-target-command'

const statements: { sql: string; params: unknown[] }[] = []
let fixture: ReturnType<typeof ready>, old: Database.Database
let legacy: ReturnType<typeof drizzle<typeof legacySchema>>
let request: ReturnType<typeof toWebHandler>
let listTool: typeof import('../server/mcp/tools/list_platform_declarations')['default']
let detailTool: typeof import('../server/mcp/tools/get_platform_declaration')['default']
const json = (value: unknown) => JSON.parse(JSON.stringify(value))
async function get(path = '') {
  const response = await request(new Request(`http://localhost/api/platform/${path}`))
  return { response, body: await response.json() }
}
async function mcp(input: unknown, detail = false) {
  const tool = detail ? detailTool : listTool
  const result = await Reflect.apply(tool.handler!, undefined, [input])
  expect(JSON.parse(result.content[0].text)).toEqual(json(result.structuredContent))
  return json(result.structuredContent)
}
beforeAll(async () => {
  fixture = ready(db => {
    records(db)
    const q = db.insert(legacySchema.platformQuery).values({ interface: 'apply_list', queryKey: 'bounds', rdjb: '2', queriedAt: 'zz', status: 'success' }).returning().get()
    for (let i = 0; i < 201; i++) db.insert(legacySchema.platformRelation).values({ queryId: q.id, sequenceNo: i + 1, relationKey: 'MANY', rawFields: { id: 'MANY', rdjb: '2', cszt: `history-${i % 101}` } }).run()
    for (let i = 0; i < 205; i++) db.insert(legacySchema.platformRelation).values({ queryId: q.id, sequenceNo: i + 202, relationKey: `EXTRA-${i}`, rawFields: { id: `EXTRA-${i}`, rdjb: '2', year: '2090', cszt: i === 204 ? 'outside-page' : 'common' } }).run()
  })
  old = new Database(fixture.f.legacySource)
  legacy = drizzle(old, { schema: legacySchema })
  const db = drizzle(fixture.t, { schema: targetSchema, logger: { logQuery(sql, params) { statements.push({ sql, params }) } } })
  // Test application wiring only: actual handlers execute their actual ORM on this target.
  vi.doMock('@db', () => ({ useDb: () => db }))
  vi.doMock('@nuxtjs/mcp-toolkit/server', () => ({ defineMcpTool: (tool: unknown) => tool }))
  vi.stubGlobal('defineEventHandler', defineEventHandler)
  vi.stubGlobal('createError', createError)
  const router = createRouter()
    .get('/api/platform/declarations', (await import('../server/api/platform/declarations.get')).default)
    .get('/api/platform/declarations/:recordId', (await import('../server/api/platform/declarations/[recordId].get')).default)
    .get('/api/platform/filter-options', (await import('../server/api/platform/filter-options.get')).default)
  request = toWebHandler(createApp().use(router))
  listTool = (await import('../server/mcp/tools/list_platform_declarations')).default
  detailTool = (await import('../server/mcp/tools/get_platform_declaration')).default
}, 60000)
afterAll(() => {
  if (process.env.APPLY_STORED_EVIDENCE_DIR) writeFileSync(join(process.env.APPLY_STORED_EVIDENCE_DIR, 'HTTP-MCP-SQL.json'), JSON.stringify(statements, null, 2))
  old?.close(); fixture?.t.close()
  vi.doUnmock('@db'); vi.doUnmock('@nuxtjs/mcp-toolkit/server'); vi.unstubAllGlobals()
})
it('real HTTP and MCP preserve independent legacy records isolated filters pages details and no-store', async () => {
  for (const input of [{}, { view: 'isolated' }, { view: 'isolated', status: 'pending' }, { view: 'isolated', titleRaw: 'X' }, { titleRaw: '2' }, { titleRaw: '3' }, { declareKind: '申请' }, { year: 2024 }, { status: 'passed' }, { platformKey: 'A' }, { enterpriseId: 1 }, { q: 'Alpha' }, { pageSize: 1, page: 2 }, { page: 999 }]) {
    const query = new URLSearchParams(Object.entries(input).map(([k, v]) => [k, String(v)]))
    const { response, body } = await get(`declarations?${query}`)
    expect(response.status, query.toString()).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(body).toEqual(json(listPlatformDeclarations(input, legacy)))
    expect(await mcp(input)).toEqual(body)
  }
  const literal = await mcp({ status: 'pending' })
  expect(literal.rows[0]).toMatchObject({ record: { platformKey: 'A' }, matchedVersionCount: 1, versionCount: 2, observationCount: 3, enterpriseIds: [1, 2], conflicts: ['enterprise_assignment_conflict'] })
  for (const row of listPlatformDeclarations({}, legacy).rows) {
    if (row.kind !== 'record') throw new Error('expected record')
    const { response, body } = await get(`declarations/${row.record.id}`)
    expect(response.status).toBe(200)
    expect(body).toEqual(json(getPlatformDeclaration(legacy, row.record.id)))
    expect(await mcp({ recordId: row.record.id }, true)).toEqual(body)
    expect(JSON.stringify(body)).not.toMatch(/canonicalRawJson|rawFields|rawResponse/)
  }
})
it('public pagination caps at 200 and detail reports 101 versions 201 observations without silent truncation', async () => {
  const page = await get('declarations?year=2090&pageSize=200')
  expect(page.body.total).toBe(205); expect(page.body.rows).toHaveLength(200)
  const second = await get('declarations?year=2090&pageSize=200&page=2')
  expect(second.body.rows).toHaveLength(5)
  expect(await mcp({ year: 2090, pageSize: 200, page: 2 })).toEqual(second.body)
  const many = (await get('declarations?platformKey=MANY')).body.rows[0]
  const detail = (await get(`declarations/${many.record.id}`)).body
  expect(detail.counts).toEqual({ versions: 101, observations: 201, versionsTruncated: true, observationsTruncated: true })
  expect(detail.versions).toHaveLength(100); expect(detail.observations).toHaveLength(200)
  expect(detail).toEqual(json(getPlatformDeclaration(legacy, many.record.id)))
  expect(await mcp({ recordId: many.record.id }, true)).toEqual(detail)
  expect((await get('filter-options?source=declarations')).body.statuses).toContain('outside-page')
})
it('declarations HTTP options retain blank status duplicate JSON title facts and global candidates', async () => {
  for (const view of ['records', 'isolated']) {
    const { response, body } = await get(`filter-options?source=declarations&view=${view}`)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(body).toEqual(json(readPlatformFilterOptions({ source: 'declarations', view }, legacy)))
    if (view === 'isolated') expect(body).toMatchObject({ titles: ['X'], statuses: [' pending ', 'pending'] })
  }
})
it('HTTP and MCP preserve invalid input and missing detail errors', async () => {
  for (const path of ['declarations?year=bad', 'declarations?view=bad', 'declarations?pageSize=201', 'declarations?page=0', 'declarations?titleRaw=', 'declarations?titleRaw=1&titleRaw=2', 'declarations/0', 'filter-options', 'filter-options?source=declarations&view=records&view=isolated', 'filter-options?source=declarations&page=2']) {
    const { response } = await get(path)
    expect(response.status, path).toBe(400)
    expect(response.headers.get('cache-control')).toBe('no-store')
  }
  expect((await get('declarations/99999')).response.status).toBe(404)
  await expect(mcp({ page: 0 })).rejects.toMatchObject({ statusCode: 400, code: 'invalid_declaration_filter' })
  await expect(mcp({ recordId: 0 }, true)).rejects.toMatchObject({ statusCode: 400, code: 'invalid_declaration_id' })
  await expect(mcp({ recordId: 99999 }, true)).rejects.toMatchObject({ statusCode: 404, code: 'declaration_not_found' })
})
it('new W ordinary and reference replay are publicly readable with old namespace aliases distinct from target IDs', async () => {
  fixture.t.exec("UPDATE platform_legacy_alias_sequence SET high_water=1000 WHERE namespace='relation'; UPDATE platform_legacy_alias_sequence SET high_water=2000 WHERE namespace='query'")
  const command = { queryText: JSON.stringify({ interface: 'apply_list', queryKey: 'new', rdjb: '2', queriedAt: 'newtime', status: 'success', rawResponse: '{}', relations: [{ sequenceNo: 1, status: ' pending ', declareKind: '申请', rawFields: { id: 'NEW', rdjb: ' 2 ', cszt: 'pending', year: '2024' } }] }), evidenceText: null, createdAt: 'creation', assignments: [{ matchBasis: 'none' as const, verificationStatus: 'pending' as const, origin: 'command' as const, actor: { type: 'agent' as const, id: 'R1b' }, basis: 'explicit' }] }
  const written = writeCollectionTarget(fixture.db, command)
  expect(writeCollectionTarget(fixture.db, command).reused).toBe(true)
  const ref = JSON.parse(command.queryText)
  ref.reuseExisting = true; delete ref.rawResponse; delete ref.status; ref.relations = [{ sequenceNo: 1 }]
  expect(writeCollectionTarget(fixture.db, { ...command, queryText: JSON.stringify(ref), assignments: [] }).reused).toBe(true)
  const body = (await get('declarations?platformKey=NEW')).body
  expect(await mcp({ platformKey: 'NEW' })).toEqual(body)
  expect(body.rows[0]).toMatchObject({ matchedVersion: { status: 'pending', declarationYear: 2024 }, observationCount: 1, versionCount: 1 })
  const observation = written.observations[0]!
  expect(observation.relationAlias).toBe(1001)
  expect(observation.observationId).not.toBe(1001)
  const detail = (await get(`declarations/${observation.recordId}`)).body
  expect(detail.observations[0]).toMatchObject({ relationId: 1001, queryId: 2001 })
  expect(await mcp({ recordId: observation.recordId }, true)).toEqual(detail)
  expect((await get('filter-options?source=declarations')).body.statuses).toContain('pending')
})
it('public serialization preserves raw SQLite REAL TEXT and BLOB cells without silent repair', async () => {
  fixture.t.exec('DROP TRIGGER platform_apply_stored_no_update')
  for (const value of [2024.5, 'bad', Buffer.from('2024'), null]) {
    old.prepare('UPDATE platform_relation SET year=? WHERE id=1').run(value)
    fixture.t.prepare('UPDATE platform_apply_projection SET exact_year=? WHERE observation_id=1').run(value)
    const input = { view: 'isolated' }
    const body = (await get('declarations?view=isolated')).body
    expect(body).toEqual(json(listPlatformDeclarations(input, legacy)))
    expect(await mcp(input)).toEqual(body)
    expect((await get('filter-options?source=declarations&view=isolated')).body).toEqual(json(readPlatformFilterOptions({ source: 'declarations', view: 'isolated' }, legacy)))
    expect(body.rows.find((row: { relationId: number }) => row.relationId === 1).declarationYear).toEqual(json(value))
  }
  for (const [oldColumn, targetColumn] of [['status', 'exact_status'], ['title_raw', 'exact_title_raw'], ['declare_kind', 'exact_declare_kind'], ['applied_at', 'exact_applied_at']]) {
    for (const value of [Buffer.from('raw-cell'), 2024.5, '  unknown  ', null]) {
      // Fixed column inventory; this is synthetic cell corruption, never application SQL.
      old.prepare(`UPDATE platform_relation SET ${oldColumn}=? WHERE id=1`).run(value)
      fixture.t.prepare(`UPDATE platform_apply_projection SET ${targetColumn}=? WHERE observation_id=1`).run(value)
      const body = (await get('declarations?view=isolated')).body
      expect(body).toEqual(json(listPlatformDeclarations({ view: 'isolated' }, legacy)))
      expect(await mcp({ view: 'isolated' })).toEqual(body)
      expect((await get('filter-options?source=declarations&view=isolated')).body).toEqual(json(readPlatformFilterOptions({ source: 'declarations', view: 'isolated' }, legacy)))
    }
  }
})
it('public target SQL never reads legacy entities or business JSON and rejects uncaptured before empty filtering', async () => {
  expect(statements.map(row => row.sql).join('\n')).not.toMatch(/\b(?:platform_query|platform_relation)\b|\bjson\w*\s*\(/i)
  expect(fixture.t.pragma('foreign_key_check')).toEqual([])
  expect(fixture.t.pragma('integrity_check', { simple: true })).toBe('ok')
  fixture.t.exec('PRAGMA ignore_check_constraints=ON; PRAGMA foreign_keys=OFF; UPDATE platform_apply_projection SET sql_fact_title_state=NULL WHERE observation_id=1')
  expect((await get('declarations?platformKey=absent&page=999')).response.status).toBe(409)
  expect((await get('filter-options?source=declarations')).response.status).toBe(409)
  await expect(mcp({ platformKey: 'absent' })).rejects.toMatchObject({ statusCode: 409, code: 'apply_stored_uncaptured' })
})
