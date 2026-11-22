import { closePostgresDirectoryDb, usePostgresDirectoryDb } from '../../../db/postgresql/client'
import { postgresRuntimeFixture } from '../../support/postgres-fixture.mjs'
import { createApp, createRouter, toWebHandler, defineEventHandler, createError } from 'h3'
import { afterAll, assert, beforeAll, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { platformResultToImport } from '../../../layers/sme-roster/lib/platform/recognized-evidence'
import type { PlatformLiveQueryResult } from '../../../layers/sme-roster/lib/platform/live-query'
import type { RosterImportPlatformQuery } from '../../../layers/sme-roster/lib/roster-import-client'
import { commitPostgresPlatformCollection } from '../../../layers/sme-roster/server/utils/collection-import-postgres'

let root: string
let postgres: Awaited<ReturnType<typeof postgresRuntimeFixture>>
async function commit(key: string, queries: RosterImportPlatformQuery[]) {
  const result = await commitPostgresPlatformCollection(usePostgresDirectoryDb(), {
    idempotencyKey: key, sourceKind: 'platform_archive', sourceIdentity: 'recognized-directory-test',
    payload: { platformQueries: queries },
  }, async () => {})
  expect(result.status, 'items' in result ? JSON.stringify(result.items?.filter(item => !item.ok)) : undefined).toBe('committed')
  assert('items' in result)
  return result
}
const statements: { sql: string; params: unknown[] }[] = []
let request: ReturnType<typeof toWebHandler>
let listTool: typeof import('../../../layers/sme-roster/server/mcp/tools/list_platform_recognized_directory')['default']
let detailTool: typeof import('../../../layers/sme-roster/server/mcp/tools/get_platform_recognized_record')['default']
const json = (value: unknown) => JSON.parse(JSON.stringify(value))
async function get(path = '') {
  const response = await request(new Request(`http://localhost/api/platform/${path}`))
  const body = await response.json()
  return { response, body }
}
async function mcp(input: unknown, detail = false) {
  const tool = detail ? detailTool : listTool
  const result = await Reflect.apply(tool.handler!, undefined, [input])
  expect(JSON.parse(result.content[0].text)).toEqual(json(result.structuredContent))
  return json(result.structuredContent)
}
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'recognized-http-'))
  postgres = await postgresRuntimeFixture({ dir: root })
  vi.stubEnv('NUXT_POSTGRES_DIRECTORY_URL', postgres.url)
  vi.stubEnv('NUXT_DB_READONLY', '0')
  postgres.psql(['-c', "INSERT INTO business.enterprise(id,name,name_norm,uscc_norm) VALUES (1,'Alpha','Alpha','U1'),(2,'Beta','Beta','U2')"])

  const query = (queryKey: string, titleScope: string, dataRows: NonNullable<PlatformLiveQueryResult['dataRows']>): RosterImportPlatformQuery => {
    const rdjb = titleScope.split(',')
    const rows = dataRows.map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, String(value)])))
    const evidence: PlatformLiveQueryResult = {
      source: 'queryBusList', status: 'success', effectiveConditions: { name: queryKey, combination: 'and' },
      titleScope: { mode: 'selected', rdjb }, queriedAt: '2026-11-11T00:00:00Z', completedAt: '2026-11-11T00:01:00Z',
      rows, dataRows, pages: rdjb.flatMap((title, index) => {
        const declaredTotal = index === 0 ? rows.length : 0
        const maxPage = Math.max(1, Math.ceil(declaredTotal / 50))
        return Array.from({ length: maxPage }, (_, page) => ({
          source: 'queryBusList' as const, rdjb: title, page: page + 1, maxPage, status: 'success' as const,
          fetchedCount: Math.min(50, declaredTotal - page * 50), declaredTotal, error: null,
        }))
      }),
      fetchedCount: rows.length, declaredTotal: rows.length, completeness: 'complete', fullRange: true, unfinished: [], error: null,
      limits: { maxRequests: 100, maxRows: 5000, maxDurationMs: 60000, pageSize: 50 },
    }
    const input = platformResultToImport(evidence)
    return { ...input, relations: input.relations?.map(row => ({ ...row, enterpriseId: null })) }
  }
  const specialized = { id: 'A', rdjb: '2', rddqrq: ' 2028 ', whpcyear: '2026', whpc: ' 2026-2 ', szq: ' D ', rdxx: ' Note ', qymc: ' Source ', tyshxydm: ' U1 ' }
  await commit('seed', [
    query('q0', '2,3', [specialized]),
    query('q1', '3', [specialized]),
    query('q2', '1,2', [{ id: 'A', rdjb: '1', rddqrq: '2029', whpcyear: false, whpc: 'B', szq: 'E' }]),
    query('q3', '3', [{ id: 'B', rdjb: '3' }]),
    query('q4', '2,3', [{ rdjb: '1' }]),
    query('q5', '1,2', [{ rdjb: 2 }]),
    query('cells', '2,3', Array.from({ length: 5 }, () => ({ qymc: 'Cells', rdjb: false }))),
    query('bounds', '2', Array.from({ length: 406 }, (_, i) => ({
      id: i < 201 ? 'Limit' : 'EXTRA-' + i, rdjb: '2',
      whpcyear: i < 201 ? 2026 : 2090, whpc: i < 201 ? 'L' + (i % 101) : i === 405 ? 'outside-page' : 'common',
    }))),
  ])
  // These retained exact cells and original assignment strings are historical inputs.
  postgres.psql(['-c', `BEGIN; SET LOCAL session_replication_role = replica;
    UPDATE business.platform_observation_assignment
      SET enterprise_id=CASE WHEN observation_id=2 THEN 2 ELSE 1 END,
          match_basis='manual', name_raw=' Original ', uscc_raw=' U '
      WHERE observation_id IN (1,2,3,5);
    UPDATE business.platform_recognized_projection p
    SET exact_title_raw=decode(v.hex,'hex'), exact_title_raw_sqlite_storage=v.storage
    FROM (VALUES (5,'33','text'),(7,NULL,'null'),(8,'30','text'),(9,'','text'),(10,'2020','text'),(11,'3200ff','blob'))
      v(id,hex,storage) WHERE p.observation_id=v.id;
    COMMIT`])
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
}, 60_000)
afterAll(async () => {
  await closePostgresDirectoryDb()
  postgres?.close()
  if (root) rmSync(root, { recursive: true, force: true })
  vi.unstubAllEnvs()
  vi.doUnmock('../../../db/postgresql/client')
  vi.doUnmock('@nuxtjs/mcp-toolkit/server')
  vi.unstubAllGlobals()
})
it('serves recognized records and isolated filters through HTTP and MCP', async () => {
  const cases = [
    [{ view: 'isolated', titleRaw: '3' }, 1],
    [{ titleRaw: '2' }, 207],
    [{ titleRaw: '1', whpcyear: 2026 }, 0],
    [{ rddqrq: '2028' }, 1],
    [{ whpcyear: 2026 }, 2],
    [{ whpc: '2026-2' }, 1],
    [{ szq: 'D' }, 1],
    [{ rdjb: '2', platformKey: 'A' }, 1],
    [{ rdjb: '3', platformKey: 'A' }, 1],
    [{ platformKey: 'A' }, 1],
    [{ enterpriseId: 1 }, 1],
    [{ q: 'Alpha' }, 1],
    [{ page: 999 }, 208],
  ] as const
  for (const [input, total] of cases) {
    const query = new URLSearchParams(Object.entries(input).map(([key, value]) => [key, String(value)]))
    const { response, body } = await get(`recognized-directory?${query}`)
    expect(response.status, query.toString()).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(body.total, query.toString()).toBe(total)
    expect(await mcp(input)).toEqual(body)
  }
  expect(listTool.name).toBe('list_platform_recognized_directory')
  expect(detailTool.name).toBe('get_platform_recognized_record')
  const literal = await mcp({ titleRaw: '2', platformKey: 'A' })
  expect(literal.rows[0]).toMatchObject({ record: { platformKey: 'A' }, matchedVersionCount: 1, versionCount: 2, observationCount: 3, enterpriseIds: [1, 2], conflicts: ['title_conflict', 'enterprise_assignment_conflict'] })
  const recordId = literal.rows[0].record.id
  const { response, body } = await get(`recognized-directory/${recordId}`)
  expect(response.status).toBe(200)
  expect(response.headers.get('cache-control')).toBe('no-store')
  expect(body).toMatchObject({ record: { id: recordId, platformKey: 'A' }, counts: { versions: 2, observations: 3 } })
  expect(await mcp({ recordId }, true)).toEqual(body)
  expect(JSON.stringify(body)).not.toMatch(/canonicalRawJson|rawFields|rawResponse/)
})
it('recognized HTTP options preserve global values and independent isolated originals', async () => {
  for (const view of ['records', 'isolated']) {
    const { response, body } = await get(`filter-options?source=recognized-directory&view=${view}`)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
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
it('reads a new recognized record after commit and coordinate-only reference replay', async () => {
  postgres.psql(['-c', 'ALTER SEQUENCE business.platform_collection_public_id_seq RESTART WITH 2001; ALTER SEQUENCE business.platform_business_observation_public_id_seq RESTART WITH 1001'])
  const row = { id: 'NEW', rdjb: ' 2 ', whpcyear: '2024', whpc: 'W-new' }
  const evidence: PlatformLiveQueryResult = { source: 'queryBusList', status: 'success', effectiveConditions: { name: 'Example', combination: 'and' }, titleScope: { mode: 'selected', rdjb: ['2'] }, queriedAt: '2026-11-12T00:00:00Z', completedAt: '2026-11-12T00:01:00Z', rows: [row], dataRows: [row], pages: [{ source: 'queryBusList', rdjb: '2', page: 1, maxPage: 1, status: 'success', fetchedCount: 1, declaredTotal: 1, error: null }], fetchedCount: 1, declaredTotal: 1, completeness: 'complete', fullRange: true, unfinished: [], error: null, limits: { maxRequests: 100, maxRows: 5000, maxDurationMs: 60000, pageSize: 50 } }
  const query = platformResultToImport(evidence)
  const receipt = await commit('new', [query])
  expect(await commit('new', [query])).toMatchObject({ batchId: receipt.batchId })
  const { interface: source, queryKey, rdjb, queriedAt } = query
  const reference = await commit('new-reference', [{ interface: source, queryKey, rdjb, queriedAt, reuseExisting: true, relations: [{ sequenceNo: 1 }] }])
  expect(reference.items).toMatchObject([{ ref: 'query:2001', detail: { reuseExisting: true, rowsWritten: 0 } }])
  const body = (await get('recognized-directory?platformKey=NEW')).body
  expect(await mcp({ platformKey: 'NEW' })).toEqual(body)
  expect(body.rows[0]).toMatchObject({ matchedVersion: { titleRaw: '2', maintenanceYear: 2024 }, observationCount: 1, versionCount: 1 })
  const recordId = body.rows[0].record.id
  const detail = (await get(`recognized-directory/${recordId}`)).body
  expect(detail.observations[0]).toMatchObject({ relationId: 1001, queryId: 2001 })
  expect(await mcp({ recordId }, true)).toEqual(detail)
  expect((await get('filter-options?source=recognized-directory')).body.batches).toContain('W-new')
})
it('HTTP and MCP preserve migrated NULL false blank whitespace and BLOB title serialization', async () => {
  const body = (await get('recognized-directory?view=isolated')).body
  expect(await mcp({ view: 'isolated' })).toEqual(body)
  const cells = [null, '0', '', '  ', { type: 'Buffer', data: [50, 0, 255] }]
  for (const [index, value] of cells.entries()) {
    expect(body.rows.find((row: { relationId: number }) => row.relationId === index + 7).titleRaw).toEqual(value)
  }
  const raw = await Reflect.apply(listTool.handler!, undefined, [{ view: 'isolated' }])
  expect(raw.structuredContent.rows.find((r: { relationId: number }) => r.relationId === 11).titleRaw).toEqual(Buffer.from('3200ff', 'hex'))
  expect((await get('filter-options?source=recognized-directory&view=isolated')).body.titles).toEqual(['0', '3', { type: 'Buffer', data: [50, 0, 255] }])
})
it('public pagination counts and global options survive detail truncation and stable ties', async () => {
  const first = (await get('recognized-directory?whpcyear=2090&pageSize=200')).body
  expect(first.total).toBe(205); expect(first.rows).toHaveLength(200)
  const second = (await get('recognized-directory?whpcyear=2090&pageSize=200&page=2')).body
  expect(second.rows).toHaveLength(5)
  expect(new Set([...first.rows, ...second.rows].map(row => row.record.platformKey)).size).toBe(205)
  expect(await mcp({ whpcyear: 2090, pageSize: 200, page: 2 })).toEqual(second)
  const many = (await get('recognized-directory?platformKey=Limit')).body.rows[0]
  const detail = (await get(`recognized-directory/${many.record.id}`)).body
  expect(detail.counts).toEqual({ versions: 101, observations: 201, versionsTruncated: true, observationsTruncated: true })
  expect(detail.versions).toHaveLength(100); expect(detail.observations).toHaveLength(200)
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
  expect((await get('recognized-directory')).response.status).toBe(200)
  expect(statements.length).toBeGreaterThan(0)
  expect(statements.map(row => row.sql).join('\n')).not.toMatch(/\b(?:platform_query|platform_relation|platform_archive_value|raw_fields|raw_response|canonical_raw_json)\b|\bjsonb?_extract\w*\s*\(/i)
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
