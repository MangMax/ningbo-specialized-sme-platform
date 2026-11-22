import { closePostgresDirectoryDb } from '../../../db/postgresql/client'
import { upgradeTitleCycleDisposition } from '../../../db/title-cycle-disposition'
import { upgradeEnterpriseKernel } from '../../../upgrade/enterprise-kernel'
import { postgresRuntimeFixture } from '../../support/postgres-fixture.mjs'
import { syntheticEnterpriseDictionaries } from '../../support/pre-enterprise-kernel'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { createApp, createRouter, toWebHandler, defineEventHandler, createError } from 'h3'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { ensurePlatformObservation } from '../../../upgrade/frozen/server/platform-business-record'
import { finalEvidenceFromSource } from '../fixtures/completed-upgrade'
import { join } from 'node:path'
import { records } from './fixtures/migrated-declarations'
import * as legacySchema from '../../../upgrade/legacy-schema'
import { listPlatformDeclarations, getPlatformDeclaration } from '../../../upgrade/frozen/server/platform-declarations'
import { readPlatformFilterOptions } from '../../../upgrade/frozen/server/platform-filter-options'
import { writeCollectionTarget } from '../../../layers/sme-roster/lib/platform/collection-target-command'

let postgres: Awaited<ReturnType<typeof postgresRuntimeFixture>> | undefined
async function materializePostgres() {
  await closePostgresDirectoryDb()
  postgres?.close()
  postgres = await postgresRuntimeFixture({ dir: fixture.root, sourcePath: fixture.target })
  for (const [name, value] of Object.entries(postgres.env)) vi.stubEnv(name, value)
  vi.stubEnv('NUXT_DB_READONLY', '1')
}

function alterSyntheticCapture(update: string) {
  // The historical negative cases inject incomplete or unusual capture in an isolated fixture.
  // Leave the production table's append-only and FK triggers installed.
  postgres!.psql(['-c', 'BEGIN; SET LOCAL session_replication_role = replica; ' + update + '; COMMIT'])
}
const statements: { sql: string; params: unknown[] }[] = []
let fixture: ReturnType<typeof finalEvidenceFromSource>, old: Database.Database
let legacy: ReturnType<typeof drizzle<typeof legacySchema>>
let request: ReturnType<typeof toWebHandler>
let listTool: typeof import('../../../layers/sme-roster/server/mcp/tools/list_platform_declarations')['default']
let detailTool: typeof import('../../../layers/sme-roster/server/mcp/tools/get_platform_declaration')['default']
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
  const root = mkdtempSync(join(process.env.APPLY_STORED_EVIDENCE_DIR ?? tmpdir(), 'declarations-http-'))
  const legacySource = join(root, 'legacy.sqlite')
  const source = new Database(legacySource)
  try {
    migrate(drizzle(source), { migrationsFolder: 'db/migrations' })
    source.exec(`INSERT INTO platform_query(id,interface,query_key,rdjb,queried_at,status,created_at) VALUES(1,'apply_list','Q','2','t','success','c');
      INSERT INTO platform_relation(id,query_id,sequence_no,status,raw_fields,created_at)
      VALUES(1,1,1,' pending ','{"rdjb":"2","rdjb":"3","cszt":"pending"}','c'),(2,1,2,'pending','{"rdjb":"1","rdjb":"3","cszt":"pending"}','c');
      UPDATE platform_relation SET title_raw='X';`)
    const db = drizzle(source, { schema: legacySchema })
    records(db)
    const q = db.insert(legacySchema.platformQuery).values({ interface: 'apply_list', queryKey: 'bounds', rdjb: '2', queriedAt: 'zz', status: 'success' }).returning().get()
    for (let i = 0; i < 201; i++) db.insert(legacySchema.platformRelation).values({ queryId: q.id, sequenceNo: i + 1, relationKey: 'MANY', rawFields: { id: 'MANY', rdjb: '2', cszt: `history-${i % 101}` } }).run()
    for (let i = 0; i < 205; i++) db.insert(legacySchema.platformRelation).values({ queryId: q.id, sequenceNo: i + 202, relationKey: `EXTRA-${i}`, rawFields: { id: `EXTRA-${i}`, rdjb: '2', year: '2090', cszt: i === 204 ? 'outside-page' : 'common' } }).run()
    for (const { id } of source.prepare('SELECT id FROM platform_relation').all() as { id: number }[])
      ensurePlatformObservation(db, id)
  } finally { source.close() }
  fixture = finalEvidenceFromSource(root, legacySource)
  const oraclePath = join(root, 'legacy-oracle.sqlite')
  copyFileSync(legacySource, oraclePath)
  old = new Database(oraclePath)
  legacy = drizzle(old, { schema: legacySchema })
  expect(fixture.t.pragma('foreign_key_check')).toEqual([])
  expect(fixture.t.pragma('integrity_check', { simple: true })).toBe('ok')
  upgradeEnterpriseKernel(fixture.t, syntheticEnterpriseDictionaries)
  upgradeTitleCycleDisposition(fixture.t)
  await materializePostgres()
  // Record the statements executed by the real PostgreSQL adapter.
  vi.doMock('../../../db/postgresql/client', async importOriginal => {
    const client = await importOriginal<typeof import('../../../db/postgresql/client')>()
    return { ...client, usePostgresDirectoryDb: () => client.usePostgresDirectoryDb({
      logQuery(sql, params) { statements.push({ sql, params }) },
    }) }
  })
  vi.doMock('@nuxtjs/mcp-toolkit/server', () => ({ defineMcpTool: (tool: unknown) => tool }))
  vi.stubGlobal('defineEventHandler', defineEventHandler)
  vi.stubGlobal('createError', createError)
  const router = createRouter()
    .get('/api/platform/declarations', (await import('../../../layers/sme-roster/server/api/platform/declarations.get')).default)
    .get('/api/platform/declarations/:recordId', (await import('../../../layers/sme-roster/server/api/platform/declarations/[recordId].get')).default)
    .get('/api/platform/filter-options', (await import('../../../layers/sme-roster/server/api/platform/filter-options.get')).default)
  request = toWebHandler(createApp().use(router))
  listTool = (await import('../../../layers/sme-roster/server/mcp/tools/list_platform_declarations')).default
  detailTool = (await import('../../../layers/sme-roster/server/mcp/tools/get_platform_declaration')).default
}, 300_000)
afterAll(async () => {
  await closePostgresDirectoryDb()
  postgres?.close()
  vi.unstubAllEnvs()
  if (process.env.APPLY_STORED_EVIDENCE_DIR) writeFileSync(join(process.env.APPLY_STORED_EVIDENCE_DIR, 'HTTP-MCP-SQL.json'), JSON.stringify(statements, null, 2))
  old?.close(); fixture?.close()
  if (!process.env.APPLY_STORED_EVIDENCE_DIR && fixture) rmSync(fixture.root, { recursive: true, force: true })
  vi.doUnmock('../../../db/postgresql/client'); vi.doUnmock('@nuxtjs/mcp-toolkit/server'); vi.unstubAllGlobals()
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
  await materializePostgres()
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
}, 60_000)
it('public serialization preserves raw SQLite REAL TEXT and BLOB cells without silent repair', async () => {
  fixture.t.exec('DROP TRIGGER platform_apply_stored_no_update')
  function setExactCell(column: string, value: Buffer | number | string | null) {
    fixture.t.prepare(`UPDATE platform_apply_projection SET ${column}=? WHERE observation_id=1`).run(value)
    const cell = fixture.t.prepare(`SELECT typeof(${column}) AS storage, ${column} AS value FROM platform_apply_projection WHERE observation_id=1`)
      .safeIntegers().get() as { storage: 'null' | 'integer' | 'real' | 'text' | 'blob'; value: Buffer | bigint | number | string | null }
    const bytes = cell.storage === 'integer' || cell.storage === 'real' ? Buffer.alloc(8) : Buffer.from(cell.value as Buffer | string ?? '')
    if (cell.storage === 'integer') bytes.writeBigInt64BE(cell.value as bigint)
    if (cell.storage === 'real') bytes.writeDoubleBE(cell.value as number)
    const encoded = cell.storage === 'null' ? 'NULL' : `decode('${bytes.toString('hex')}', 'hex')`
    alterSyntheticCapture(`UPDATE business.platform_apply_projection SET ${column}=${encoded}, ${column}_sqlite_storage='${cell.storage}' WHERE observation_id=1`)
  }
  for (const value of [2024.5, 'bad', Buffer.from('2024'), null]) {
    old.prepare('UPDATE platform_relation SET year=? WHERE id=1').run(value)
    setExactCell('exact_year', value)
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
      setExactCell(targetColumn!, value)
      const body = (await get('declarations?view=isolated')).body
      expect(body).toEqual(json(listPlatformDeclarations({ view: 'isolated' }, legacy)))
      expect(await mcp({ view: 'isolated' })).toEqual(body)
      expect((await get('filter-options?source=declarations&view=isolated')).body).toEqual(json(readPlatformFilterOptions({ source: 'declarations', view: 'isolated' }, legacy)))
    }
  }
}, 30_000)
it('public target SQL never reads legacy entities or business JSON and rejects uncaptured before empty filtering', async () => {
  expect(statements.length).toBeGreaterThan(0)
  expect(statements.map(row => row.sql).join('\n')).not.toMatch(/\b(?:platform_query|platform_relation|platform_archive_value|raw_fields|raw_response|canonical_raw_json)\b|\bjsonb?_extract\w*\s*\(/i)
  expect(fixture.t.pragma('foreign_key_check')).toEqual([])
  expect(fixture.t.pragma('integrity_check', { simple: true })).toBe('ok')
  alterSyntheticCapture(`
    UPDATE business.platform_apply_projection
    SET sql_fact_title=NULL, sql_fact_title_rule=NULL, sql_fact_title_state='uncaptured',
      sql_fact_title_reason='synthetic incomplete capture'
    WHERE observation_id=1;
    UPDATE business.platform_business_observation
    SET apply_sql_fact_title_state='uncaptured' WHERE id=1
  `)
  expect((await get('declarations?platformKey=absent&page=999')).response.status).toBe(409)
  expect((await get('filter-options?source=declarations')).response.status).toBe(409)
  await expect(mcp({ platformKey: 'absent' })).rejects.toMatchObject({ statusCode: 409, code: 'apply_stored_uncaptured' })
})
