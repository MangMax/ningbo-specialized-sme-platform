import { closePostgresDirectoryDb } from '../../../db/postgresql/client'
import { upgradeTitleCycleDisposition } from '../../../db/title-cycle-disposition'
import { upgradeEnterpriseKernel } from '../../../upgrade/enterprise-kernel'
import { postgresRuntimeFixture } from '../../support/postgres-fixture.mjs'
import { syntheticEnterpriseDictionaries } from '../../support/pre-enterprise-kernel'
import { finalEvidenceFixture } from '../fixtures/completed-upgrade'
import { ensurePlatformObservation } from '../../../upgrade/frozen/server/platform-business-record'
import * as legacySchema from '../../../upgrade/legacy-schema'
import Database from 'better-sqlite3'
import { assertExpandRuntime } from '../../../upgrade/schema-phase'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { createApp, createRouter, toWebHandler, defineEventHandler, createError } from 'h3'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { seedRecognizedDirectory } from './fixtures/migrated-directory'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { listPlatformRecognizedDirectory, getPlatformRecognizedRecord } from '../../../upgrade/frozen/server/platform-recognized-directory'
import { readPlatformFilterOptions } from '../../../upgrade/frozen/server/platform-filter-options'
import { platformResultToImport } from '../../../layers/sme-roster/lib/platform/recognized-evidence'
import type { PlatformLiveQueryResult } from '../../../layers/sme-roster/lib/platform/live-query'
import { writeCollectionTarget } from '../../../layers/sme-roster/lib/platform/collection-target-command'

// Seed the legacy source once, then run the complete chain once (no discarded prefix).
async function historicalFixture(extra?: (source: Database.Database) => void) {
  const root = mkdtempSync(join(tmpdir(), 'recognized-http-'))
  const legacySource = join(root, 'legacy.sqlite')
  const source = new Database(legacySource)
  try {
    migrate(drizzle(source), { migrationsFolder: 'db/migrations' })
    source.exec("INSERT INTO title(code,name_zh,level,rank) VALUES('innovative_sme','创新型中小企业','municipal',1),('specialized_sme','专精特新中小企业','municipal',2),('little_giant','小巨人','national',3)")
    seedRecognizedDirectory(source, extra)
  } finally { source.close() }
  return { root, legacySource, close() {} }
}
const responses: unknown[] = []
let postgres: Awaited<ReturnType<typeof postgresRuntimeFixture>> | undefined
async function materializePostgres() {
  await closePostgresDirectoryDb()
  postgres?.close()
  postgres = await postgresRuntimeFixture({ dir: fixture.root, sourcePath: fixture.target })
  for (const [name, value] of Object.entries(postgres.env)) vi.stubEnv(name, value)
  vi.stubEnv('NUXT_DB_READONLY', '1')
}
const statements: { sql: string; params: unknown[] }[] = []
let fixture: ReturnType<typeof finalEvidenceFixture<Awaited<ReturnType<typeof historicalFixture>>>>
let request: ReturnType<typeof toWebHandler>
let listTool: typeof import('../../../layers/sme-roster/server/mcp/tools/list_platform_recognized_directory')['default']
let detailTool: typeof import('../../../layers/sme-roster/server/mcp/tools/get_platform_recognized_record')['default']
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
  fixture = finalEvidenceFixture(await historicalFixture(source => {
    const db = drizzle(source, { schema: legacySchema })
    for (let i = 0; i < 5; i++) {
      const r = db.insert(legacySchema.platformRelation).values({ queryId: 1, sequenceNo: i + 2, nameRaw: ' Cells ', rawFields: { rdjb: false } }).returning().get()
      ensurePlatformObservation(db, r.id)
      source.prepare('UPDATE platform_relation SET title_raw=? WHERE id=?').run([null, '0', '', '  ', Buffer.from('3200ff', 'hex')][i], r.id)
    }
    for (let i = 0; i < 406; i++) {
      const key = i < 201 ? 'Limit' : `EXTRA-${i}`
      const raw = { id: key, rdjb: '2', whpcyear: i < 201 ? 2026 : 2090, whpc: i < 201 ? `L${i % 101}` : i === 405 ? 'outside-page' : 'common' }
      const r = db.insert(legacySchema.platformRelation).values({ queryId: 1, sequenceNo: i + 7, relationKey: key, rawFields: raw }).returning().get()
      ensurePlatformObservation(db, r.id)
    }
  }))
  expect(fixture.t.pragma('foreign_key_check')).toEqual([])
  expect(fixture.t.pragma('integrity_check', { simple: true })).toBe('ok')
  expect(fixture.t.pragma('user_version', { simple: true })).toBe(71613)
  expect(() => assertExpandRuntime(fixture.t)).toThrow(/historical|finalized|phase|runtime/i)
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
    .get('/api/platform/recognized-directory', (await import('../../../layers/sme-roster/server/api/platform/recognized-directory.get')).default)
    .get('/api/platform/recognized-directory/:recordId', (await import('../../../layers/sme-roster/server/api/platform/recognized-directory/[recordId].get')).default)
    .get('/api/platform/filter-options', (await import('../../../layers/sme-roster/server/api/platform/filter-options.get')).default)
  request = toWebHandler(createApp().use(router))
  listTool = (await import('../../../layers/sme-roster/server/mcp/tools/list_platform_recognized_directory')).default
  detailTool = (await import('../../../layers/sme-roster/server/mcp/tools/get_platform_recognized_record')).default
}, 300_000)
afterAll(async () => {
  await closePostgresDirectoryDb()
  postgres?.close()
  vi.unstubAllEnvs()
  if (process.env.RECOGNIZED_HANDLER_EVIDENCE_DIR) writeFileSync(join(process.env.RECOGNIZED_HANDLER_EVIDENCE_DIR, 'HTTP-MCP-SQL.json'), JSON.stringify(statements, null, 2))
  if (process.env.RECOGNIZED_HANDLER_EVIDENCE_DIR) writeFileSync(join(process.env.RECOGNIZED_HANDLER_EVIDENCE_DIR, 'HTTP-RESPONSES.json'), JSON.stringify(responses, null, 2))
  fixture?.close()
  if (fixture) rmSync(fixture.root, { recursive: true, force: true })
  vi.doUnmock('../../../db/postgresql/client'); vi.doUnmock('@nuxtjs/mcp-toolkit/server'); vi.unstubAllGlobals()
})
it('real HTTP and MCP preserve independent legacy records isolated filters pages details and no-store', async () => {
  for (const input of [{}, { view: 'isolated' }, { view: 'isolated', titleRaw: '3' }, { titleRaw: '2' }, { titleRaw: '1', whpcyear: 2026 }, { rddqrq: '2028' }, { whpcyear: 2026 }, { whpc: '2026-2' }, { szq: 'D' }, { rdjb: '2' }, { rdjb: '3' }, { q: 'U2' }, { platformKey: 'A' }, { enterpriseId: 1 }, { q: 'Alpha' }, { pageSize: 1, page: 2 }, { page: 999 }]) {
    const query = new URLSearchParams(Object.entries(input).map(([k, v]) => [k, String(v)]))
    const { response, body } = await get(`recognized-directory?${query}`)
    expect(response.status, query.toString()).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(body).toEqual(json(listPlatformRecognizedDirectory(input, fixture.old)))
    expect(await mcp(input)).toEqual(body)
  }
  expect(listTool.name).toBe('list_platform_recognized_directory')
  expect(detailTool.name).toBe('get_platform_recognized_record')
  const literal = await mcp({ titleRaw: '2', platformKey: 'A' })
  expect(literal.rows[0]).toMatchObject({ record: { platformKey: 'A' }, matchedVersionCount: 1, versionCount: 2, observationCount: 3, enterpriseIds: [1, 2], conflicts: ['title_conflict', 'enterprise_assignment_conflict'] })
  for (const row of listPlatformRecognizedDirectory({}, fixture.old).rows) {
    if (row.kind !== 'record') throw new Error('expected record')
    const { response, body } = await get(`recognized-directory/${row.record.id}`)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(body).toEqual(json(getPlatformRecognizedRecord(fixture.old, row.record.id)))
    expect(await mcp({ recordId: row.record.id }, true)).toEqual(body)
    expect(JSON.stringify(body)).not.toMatch(/canonicalRawJson|rawFields|rawResponse/)
  }
})
it('recognized HTTP options preserve global values and independent isolated originals', async () => {
  for (const view of ['records', 'isolated']) {
    const { response, body } = await get(`filter-options?source=recognized-directory&view=${view}`)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(body).toEqual(json(readPlatformFilterOptions({ source: 'recognized-directory', view }, fixture.old)))
    if (view === 'isolated') expect(body.titles).toEqual(['0', '3', { type: 'Buffer', data: [50, 0, 255] }])
  }
})
it('HTTP and MCP preserve invalid input and missing detail errors', async () => {
  for (const path of ['recognized-directory?unknown=1', 'recognized-directory?rdjb=9', 'recognized-directory?enterpriseId=0', 'filter-options?source=recognized-directory&source=recognized-directory', 'recognized-directory?whpcyear=bad', 'recognized-directory?view=bad', 'recognized-directory?pageSize=201', 'recognized-directory?page=0', 'recognized-directory?titleRaw=', 'recognized-directory?titleRaw=1&titleRaw=2', 'recognized-directory/0', 'filter-options', 'filter-options?source=recognized-directory&view=records&view=isolated', 'filter-options?source=recognized-directory&page=2']) {
    const { response } = await get(path)
    expect(response.status, path).toBe(400)
    expect(response.headers.get('cache-control')).toBe('no-store')
  }
  const missing = await get('recognized-directory/99999')
  expect(missing.response.status).toBe(404)
  expect(missing.body.statusMessage).toBe('Recognized directory record not found')
  expect((await get('recognized-directory?whpcyear=bad')).body.statusMessage).toBe('whpcyear must be a positive integer')
  expect((await get('recognized-directory?view=bad')).body.statusMessage).toBe('Invalid recognized directory query parameters')
  expect((await get('recognized-directory/0')).body.statusMessage).toBe('recordId must be a positive safe integer')
  await expect(mcp({ page: 0 })).rejects.toMatchObject({ statusCode: 400, code: 'invalid_recognized_directory_filter' })
  await expect(mcp({ recordId: 0 }, true)).rejects.toMatchObject({ statusCode: 400, code: 'invalid_recognized_record_id' })
  await expect(mcp({ recordId: 99999 }, true)).rejects.toMatchObject({ statusCode: 404, code: 'recognized_record_not_found' })
})
it('new W ordinary and reference replay are publicly readable with old namespace aliases distinct from target IDs', async () => {
  fixture.t.exec("UPDATE platform_legacy_alias_sequence SET high_water=1000 WHERE namespace='relation'; UPDATE platform_legacy_alias_sequence SET high_water=2000 WHERE namespace='query'")
  const row = { id: 'NEW', rdjb: ' 2 ', whpcyear: '2024', whpc: 'W-new' }
  const evidence: PlatformLiveQueryResult = { source: 'queryBusList', status: 'success', effectiveConditions: { name: 'Example', combination: 'and' }, titleScope: { mode: 'selected', rdjb: ['2'] }, queriedAt: '2026-11-12T00:00:00Z', completedAt: '2026-11-12T00:01:00Z', rows: [row], dataRows: [row], pages: [{ source: 'queryBusList', rdjb: '2', page: 1, maxPage: 1, status: 'success', fetchedCount: 1, declaredTotal: 1, error: null }], fetchedCount: 1, declaredTotal: 1, completeness: 'complete', fullRange: true, unfinished: [], error: null, limits: { maxRequests: 100, maxRows: 5000, maxDurationMs: 60000, pageSize: 50 } }
  const command = { queryText: JSON.stringify(platformResultToImport(evidence)), evidenceText: JSON.stringify(evidence), createdAt: 'creation', assignments: [{ matchBasis: 'none' as const, verificationStatus: 'pending' as const, origin: 'command' as const, actor: { type: 'agent' as const, id: 'R3b' }, basis: 'explicit' }] }
  const written = writeCollectionTarget(fixture.db, command)
  expect(writeCollectionTarget(fixture.db, command).reused).toBe(true)
  const ref = JSON.parse(command.queryText)
  ref.reuseExisting = true; delete ref.rawResponse; delete ref.status; delete ref.collectionEvidence; ref.relations = [{ sequenceNo: 1 }]
  expect(writeCollectionTarget(fixture.db, { ...command, queryText: JSON.stringify(ref), evidenceText: null, assignments: [] }).reused).toBe(true)
  await materializePostgres()
  const body = (await get('recognized-directory?platformKey=NEW')).body
  expect(await mcp({ platformKey: 'NEW' })).toEqual(body)
  expect(body.rows[0]).toMatchObject({ matchedVersion: { titleRaw: '2', maintenanceYear: 2024 }, observationCount: 1, versionCount: 1 })
  const observation = written.observations[0]!
  expect(observation.relationAlias).toBe(1001)
  expect(observation.observationId).not.toBe(1001)
  const detail = (await get(`recognized-directory/${observation.recordId}`)).body
  expect(detail.observations[0]).toMatchObject({ relationId: 1001, queryId: 2001 })
  expect(await mcp({ recordId: observation.recordId }, true)).toEqual(detail)
  expect((await get('filter-options?source=recognized-directory')).body.batches).toContain('W-new')
}, 60_000)
it('HTTP and MCP preserve migrated NULL false blank whitespace and BLOB title serialization', async () => {
  const body = (await get('recognized-directory?view=isolated')).body
  expect(body).toEqual(json(listPlatformRecognizedDirectory({ view: 'isolated' }, fixture.old)))
  expect(await mcp({ view: 'isolated' })).toEqual(body)
  const cells = fixture.legacy.prepare('SELECT id,title_raw AS value FROM platform_relation WHERE id>=7 AND id<=11 ORDER BY id').all() as { id: number; value: unknown }[]
  expect(cells.map(c => c.value)).toEqual([null, '0', '', '  ', Buffer.from('3200ff', 'hex')])
  for (const cell of cells) expect(body.rows.find((r: { relationId: number }) => r.relationId === cell.id).titleRaw).toEqual(json(cell.value))
  const raw = await Reflect.apply(listTool.handler!, undefined, [{ view: 'isolated' }])
  expect(raw.structuredContent.rows.find((r: { relationId: number }) => r.relationId === 11).titleRaw).toEqual(Buffer.from('3200ff', 'hex'))
  expect((await get('filter-options?source=recognized-directory&view=isolated')).body.titles).toEqual(['0', '3', { type: 'Buffer', data: [50, 0, 255] }])
})
it('public pagination counts and global options survive detail truncation and stable ties', async () => {
  const first = (await get('recognized-directory?whpcyear=2090&pageSize=200')).body
  expect(first.total).toBe(205); expect(first.rows).toHaveLength(200)
  const second = (await get('recognized-directory?whpcyear=2090&pageSize=200&page=2')).body
  expect(second.rows).toHaveLength(5)
  expect(await mcp({ whpcyear: 2090, pageSize: 200, page: 2 })).toEqual(second)
  const many = (await get('recognized-directory?platformKey=Limit')).body.rows[0]
  const detail = (await get(`recognized-directory/${many.record.id}`)).body
  expect(detail.counts).toEqual({ versions: 101, observations: 201, versionsTruncated: true, observationsTruncated: true })
  expect(detail.versions).toHaveLength(100); expect(detail.observations).toHaveLength(200)
  expect(detail).toEqual(json(getPlatformRecognizedRecord(fixture.old, many.record.id)))
  expect(await mcp({ recordId: many.record.id }, true)).toEqual(detail)
  expect((await get('filter-options?source=recognized-directory')).body.batches).toContain('outside-page')
})
it('public requests see current assignment corrections while preserving original isolated names', async () => {
  expect((await get('recognized-directory?enterpriseId=2')).body.total).toBe(1)
  postgres!.psql(['-c', "INSERT INTO business.platform_observation_assignment(observation_id,revision,enterprise_id,match_basis,verification_status,origin) VALUES(2,2,1,'manual','pending','command'),(5,2,2,'manual','pending','command')"])
  expect((await get('recognized-directory?enterpriseId=2')).body.total).toBe(0)
  const body = (await get('recognized-directory?view=isolated&enterpriseId=2')).body
  expect(body).toMatchObject({ total: 1, rows: [{ relationId: 5, enterpriseId: 2, enterpriseName: 'Beta', nameRaw: ' Original ', usccRaw: ' U ' }] })
  expect(await mcp({ view: 'isolated', enterpriseId: 2 })).toEqual(body)
})
it('public SQL avoids legacy and archive business reads and capture rejection preserves global guard', async () => {
  expect(statements.length).toBeGreaterThan(0)
  expect(statements.map(row => row.sql).join('\n')).not.toMatch(/\b(?:platform_query|platform_relation|platform_archive_value|raw_fields|raw_response|canonical_raw_json)\b|\bjsonb?_extract\w*\s*\(/i)
  expect(fixture.t.pragma('foreign_key_check')).toEqual([])
  expect(fixture.t.pragma('integrity_check', { simple: true })).toBe('ok')
  function setCaptureState(state: 'captured' | 'uncaptured') {
    // Simulate incomplete migration in this isolated fixture without changing its installed triggers.
    postgres!.psql(['-c', `BEGIN; SET LOCAL session_replication_role = replica;
      UPDATE business.platform_recognized_projection SET exact_title_state='${state}' WHERE observation_id=5; COMMIT`])
  }
  setCaptureState('uncaptured')
  try {
    expect((await get('recognized-directory?platformKey=absent')).response.status).toBe(409)
    expect((await get('filter-options?source=recognized-directory')).response.status).toBe(409)
    expect((await get('recognized-directory/1')).response.status).toBe(409)
    await expect(mcp({ platformKey: 'absent' })).rejects.toMatchObject({ statusCode: 409, code: 'recognized_target_uncaptured' })
  } finally {
    setCaptureState('captured')
  }
})
