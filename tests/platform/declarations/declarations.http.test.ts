import { closePostgresDirectoryDb, usePostgresDirectoryDb } from '../../../db/postgresql/client'
import { postgresRuntimeFixture } from '../../support/postgres-fixture.mjs'
import { createApp, createRouter, toWebHandler, defineEventHandler, createError } from 'h3'
import { afterAll, assert, beforeAll, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RosterImportPlatformQuery } from '../../../layers/sme-roster/lib/roster-import-client'
import { commitPostgresPlatformCollection } from '../../../layers/sme-roster/server/utils/collection-import-postgres'

let root: string
let postgres: Awaited<ReturnType<typeof postgresRuntimeFixture>>
async function commit(key: string, queries: RosterImportPlatformQuery[]) {
  const result = await commitPostgresPlatformCollection(usePostgresDirectoryDb(), {
    idempotencyKey: key, sourceKind: 'platform_archive', sourceIdentity: 'declaration-test',
    payload: { platformQueries: queries },
  }, async () => {})
  expect(result.status, 'items' in result ? JSON.stringify(result.items?.filter(item => !item.ok)) : undefined).toBe('committed')
  assert('items' in result)
  return result
}
function alterSyntheticCapture(update: string) {
  postgres!.psql(['-c', 'BEGIN; SET LOCAL session_replication_role = replica; ' + update + '; COMMIT'])
}
const statements: { sql: string; params: unknown[] }[] = []
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
  root = mkdtempSync(join(tmpdir(), 'declarations-http-'))
  postgres = await postgresRuntimeFixture({ dir: root })
  vi.stubEnv('NUXT_POSTGRES_DIRECTORY_URL', postgres.url)
  vi.stubEnv('NUXT_DB_READONLY', '0')
  postgres.psql(['-c', "INSERT INTO business.enterprise(id,name,name_norm,uscc_norm) VALUES (1,'Alpha','Alpha','UA'),(2,'Beta','Beta','UB')"])

  const query = (queryKey: string, relations: NonNullable<RosterImportPlatformQuery['relations']>): RosterImportPlatformQuery => ({
    interface: 'apply_list', queryKey, rdjb: '2', queriedAt: '2026-11-11T00:00:00Z', status: 'success', rawResponse: '{}', relations,
  })
  const records = ([[0, 'A', 'pending', 1, '2024-01'], [1, 'A', 'passed', 2, '2025-01'], [2, 'A', 'passed', 1, '2025-01'], [3, 'B', 'pending', null, null]] as const)
    .map(([index, id, cszt, enterpriseId, sqsj]) => query('q' + index, [{
      sequenceNo: 1, relationKey: id, enterpriseId, nameRaw: 'Original',
      rawFields: { id, rdjb: '2', cszt, sblx: '申请', year: '2024', sqsj },
    }]))
  await commit('seed', [
    query('isolated', [1, 2].map(sequenceNo => ({ sequenceNo, rawFields: { rdjb: '3', cszt: 'pending' } }))),
    ...records,
    query('bounds', [
      ...Array.from({ length: 201 }, (_, i) => ({
        sequenceNo: i + 1, relationKey: 'MANY', rawFields: { id: 'MANY', rdjb: '2', cszt: 'history-' + (i % 101) },
      })),
      ...Array.from({ length: 205 }, (_, i) => ({
        sequenceNo: i + 202, relationKey: 'EXTRA-' + i,
        rawFields: { id: 'EXTRA-' + i, rdjb: '2', year: '2090', cszt: i === 204 ? 'outside-page' : 'common' },
      })),
    ]),
  ])
  // Preserve exact-cell inputs that can only come from historical data.
  alterSyntheticCapture(`
    UPDATE business.platform_business_observation
    SET source_values=source_values || jsonb_build_object(
      'titleRaw', 'X', 'status', CASE WHEN id=1 THEN ' pending ' ELSE 'pending' END
    )
    WHERE id IN (1,2)
  `)
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
it('serves declaration records and isolated filters through HTTP and MCP', async () => {
  const cases = [
    [{ view: 'isolated', status: 'pending' }, 1],
    [{ view: 'isolated', titleRaw: 'X' }, 2],
    [{ titleRaw: '2' }, 208],
    [{ titleRaw: '3' }, 0],
    [{ declareKind: '申请' }, 2],
    [{ year: 2024 }, 2],
    [{ status: 'passed' }, 1],
    [{ platformKey: 'A' }, 1],
    [{ enterpriseId: 1 }, 1],
    [{ q: 'Alpha' }, 1],
  ] as const
  for (const [input, total] of cases) {
    const query = new URLSearchParams(Object.entries(input).map(([key, value]) => [key, String(value)]))
    const { response, body } = await get(`declarations?${query}`)
    expect(response.status, query.toString()).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(body.total, query.toString()).toBe(total)
    expect(await mcp(input)).toEqual(body)
  }
  expect((await mcp({ status: 'pending', platformKey: 'A' })).rows).toEqual([])
  const literal = await mcp({ status: 'passed', platformKey: 'A' })
  expect(literal.rows[0]).toMatchObject({ record: { platformKey: 'A' }, matchedVersionCount: 1, versionCount: 1, observationCount: 2, enterpriseIds: [1], conflicts: [] })
  const recordId = literal.rows[0].record.id
  const { response, body } = await get(`declarations/${recordId}`)
  expect(response.status).toBe(200)
  expect(body).toMatchObject({ record: { id: recordId, platformKey: 'A' }, current: { status: 'passed' }, counts: { versions: 1, observations: 1 } })
  expect(await mcp({ recordId }, true)).toEqual(body)
  expect(JSON.stringify(body)).not.toMatch(/canonicalRawJson|rawFields|rawResponse/)
})
it('paginates current declarations and returns only the latest capture in details', async () => {
  const page = await get('declarations?year=2090&pageSize=200')
  expect(page.body.total).toBe(205); expect(page.body.rows).toHaveLength(200)
  const second = await get('declarations?year=2090&pageSize=200&page=2')
  expect(second.body.rows).toHaveLength(5)
  expect(new Set([...page.body.rows, ...second.body.rows].map(row => row.record.platformKey)).size).toBe(205)
  expect(await mcp({ year: 2090, pageSize: 200, page: 2 })).toEqual(second.body)
  const many = (await get('declarations?platformKey=MANY')).body.rows[0]
  const detail = (await get(`declarations/${many.record.id}`)).body
  expect(detail.counts).toEqual({ versions: 1, observations: 200, versionsTruncated: false, observationsTruncated: true })
  expect(detail.versions).toHaveLength(1); expect(detail.observations).toHaveLength(200)
  expect(await mcp({ recordId: many.record.id }, true)).toEqual(detail)
  expect((await get('filter-options?source=declarations')).body.statuses).toContain('outside-page')
})
it('declarations HTTP options retain blank status duplicate JSON title facts and global candidates', async () => {
  for (const view of ['records', 'isolated']) {
    const { response, body } = await get(`filter-options?source=declarations&view=${view}`)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
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
it('reads a new declaration after commit and coordinate-only reference replay', async () => {
  postgres.psql(['-c', 'ALTER SEQUENCE business.platform_collection_public_id_seq RESTART WITH 2001; ALTER SEQUENCE business.platform_business_observation_public_id_seq RESTART WITH 1001'])
  const query: RosterImportPlatformQuery = {
    interface: 'apply_list', queryKey: 'new', rdjb: '2', queriedAt: '2026-11-12T00:00:00Z', status: 'success', rawResponse: '{}',
    relations: [{ sequenceNo: 1, status: ' pending ', declareKind: '申请', rawFields: { id: 'NEW', rdjb: ' 2 ', cszt: 'pending', year: '2024' } }],
  }
  const receipt = await commit('new', [query])
  expect(await commit('new', [query])).toMatchObject({ batchId: receipt.batchId })
  const { interface: source, queryKey, rdjb, queriedAt } = query
  const reference = await commit('new-reference', [{ interface: source, queryKey, rdjb, queriedAt, reuseExisting: true, relations: [{ sequenceNo: 1 }] }])
  expect(reference.items).toMatchObject([{ ref: 'query:2001', detail: { reuseExisting: true, rowsWritten: 0 } }])
  const body = (await get('declarations?platformKey=NEW')).body
  expect(await mcp({ platformKey: 'NEW' })).toEqual(body)
  expect(body.rows[0]).toMatchObject({ matchedVersion: { status: 'pending', declarationYear: 2024 }, observationCount: 1, versionCount: 1 })
  const recordId = body.rows[0].record.id
  const detail = (await get(`declarations/${recordId}`)).body
  expect(detail.observations[0]).toMatchObject({ relationId: 1001, queryId: 2001 })
  expect(await mcp({ recordId }, true)).toEqual(detail)
})
it('serializes exact real, text, BLOB and NULL declaration cells', async () => {
  const columns = [
    ['year', 'declarationYear'], ['status', 'status'], ['titleRaw', 'titleRaw'],
    ['declareKind', 'declareKind'], ['appliedAt', 'appliedAt'],
  ] as const
  const cases = [
    [2024.5, 2024.5], ['  unknown  ', '  unknown  '],
    [{ base64: 'MjAyNA==' }, { type: 'Buffer', data: [50, 48, 50, 52] }], [null, null],
  ] as const
  for (const [key, field] of columns) {
    for (const [value, expected] of cases) {
      alterSyntheticCapture(`UPDATE business.platform_business_observation
        SET source_values=source_values || $cell$${JSON.stringify({ [key]: value })}$cell$::jsonb WHERE id=1`)
      const body = (await get('declarations?view=isolated')).body
      expect(await mcp({ view: 'isolated' })).toEqual(body)
      expect(body.rows.find((row: { relationId: number }) => row.relationId === 1)[field]).toEqual(expected)
    }
  }
})
it('declaration readiness, count and page use one snapshot during a concurrent collection update', async () => {
  const path = 'declarations?platformKey=A'
  const before = await get(path)
  expect(before.response.status).toBe(200)
  expect(before.body.rows[0].latestObservationAt).toBe('2026-11-11T00:00:00Z')

  const client = await usePostgresDirectoryDb().$client.connect()
  let inFlight: ReturnType<typeof get> | undefined
  try {
    await client.query('BEGIN')
    await client.query('LOCK TABLE business.platform_business_record_version IN ACCESS EXCLUSIVE MODE')
    inFlight = get(path)
    await expect.poll(async () => {
      const { rows } = await client.query(`
        SELECT 1 FROM pg_locks
        WHERE relation = 'business.platform_business_record_version'::regclass AND NOT granted
      `)
      return rows.length
    }).toBe(1)
    await client.query(`
      UPDATE business.platform_collection SET last_collected_at = '2026-12-01'
      WHERE query_key = 'q2'
    `)
    await client.query('COMMIT')
    expect((await inFlight).body).toEqual(before.body)
    expect((await get(path)).body.rows[0].latestObservationAt).toBe('2026-12-01')
  } finally {
    await client.query('ROLLBACK')
    client.release()
    await inFlight
  }
})

it('public target SQL never reads legacy entities or business JSON and rejects uncaptured before empty filtering', async () => {
  expect((await get('declarations')).response.status).toBe(200)
  expect(statements.length).toBeGreaterThan(0)
  expect(statements.map(row => row.sql).join('\n')).not.toMatch(/\b(?:platform_query|platform_relation|platform_archive_value|raw_fields|raw_response|canonical_raw_json)\b|\bjsonb?_extract\w*\s*\(/i)
  alterSyntheticCapture(`
    UPDATE business.platform_business_observation
    SET source_values=NULL WHERE id=1
  `)
  expect((await get('declarations?platformKey=absent&page=999')).response.status).toBe(409)
  expect((await get('filter-options?source=declarations')).response.status).toBe(409)
  await expect(mcp({ platformKey: 'absent' })).rejects.toMatchObject({ statusCode: 409, code: 'apply_stored_uncaptured' })
})
