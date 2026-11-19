import { createReviewedFixtureImportClient } from '../imports/fixtures/reviewed-announcement'
import { initializeDb } from '../../../db/client'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp, createRouter, createError, defineEventHandler, getQuery, toNodeListener } from 'h3'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { getComparison, type ComparisonRow } from '../../../layers/sme-roster/lib/comparison'
import { type RosterImportRecord } from '../../../layers/sme-roster/lib/roster-import-client'
import { startRosterApi, executeNativeImport } from '../imports/fixtures/import-server'

const dir = mkdtempSync(join(tmpdir(), 'comparison-source-selection-'))
const db = initializeDb({ create: true, dbPath: join(dir, 'fixture.db') })
let imports: Awaited<ReturnType<typeof startRosterApi>>
let server: Server
let base: string
let batch = 0

function syntheticUscc(n: number) {
  const alphabet = '0123456789ABCDEFGHJKLMNPQRTUWXY'
  const weights = [1, 3, 9, 27, 19, 26, 16, 17, 20, 29, 25, 13, 8, 24, 10, 30, 28]
  const body = `91330211${String(n).padStart(9, '0')}`
  const sum = [...body].reduce((total, char, index) => total + alphabet.indexOf(char) * weights[index]!, 0)
  return body + alphabet[(31 - sum % 31) % 31]
}

async function seed(records: RosterImportRecord[]) {
  const result = await createReviewedFixtureImportClient({ baseUrl: imports.baseUrl, token: 'synthetic-source-selection' }, db).commit({
    idempotencyKey: `source-selection-${++batch}`, sourceKind: 'announcement', sourceIdentity: `synthetic/source-selection/${batch}`,
    payload: { announcement: { sourceDocument: { source: 'jxj', title: 'Synthetic source membership' }, records } },
  })
  expect(result, JSON.stringify(result)).toMatchObject({ status: 'committed', summary: { failed: 0 } })
}

// Observe actual driver values (including cursors), never replace results. The
// domain read isolates source-set work from unrelated platform hydration queries.
function measureComparison() {
  let rows = 0, bytes = 0
  const queries: Array<{ sql: string; plan: unknown[] }> = []
  const prepare = db.$client.prepare.bind(db.$client)
  db.$client.prepare = ((...args: Parameters<typeof prepare>) => {
    const statement = prepare(...args)
    const count = (row: unknown) => { rows++; bytes += Buffer.byteLength(JSON.stringify(row) ?? '') }
    const plan = (params: unknown[]) => queries.push({ sql: args[0], plan: prepare(`EXPLAIN QUERY PLAN ${args[0]}`).all(...params) })
    for (const method of ['all', 'get'] as const) {
      const run = statement[method].bind(statement)
      Object.assign(statement, { [method]: (...params: unknown[]) => {
        plan(params)
        const value = run(...params)
        if (method === 'all') for (const row of value as unknown[]) count(row)
        else if (value != null) count(value)
        return value
      } })
    }
    const iterate = statement.iterate.bind(statement)
    Object.assign(statement, { iterate: function* (...params: unknown[]) {
      plan(params)
      for (const row of iterate(...params)) { count(row); yield row }
    } })
    return statement
  }) as typeof prepare
  try { return { result: getComparison(db), metrics: () => ({ rows, bytes, queries }) } }
  finally { db.$client.prepare = prepare }
}

beforeAll(async () => {
  vi.stubGlobal('defineEventHandler', defineEventHandler)
  vi.stubGlobal('getQuery', getQuery)
  vi.stubGlobal('createError', createError)
  vi.stubGlobal('useRuntimeConfig', () => ({ curatedPath: join(dir, 'curated.json'), reconcilePath: join(dir, 'reconcile.json') }))
  vi.doMock('@db', () => ({ useDb: () => db }))
  imports = await startRosterApi({ db, apiToken: 'synthetic-source-selection', executeImport: executeNativeImport })
  const handler = (await import('../../../layers/sme-roster/server/api/comparison.get')).default
  server = createServer(toNodeListener(createApp().use(createRouter().get('/api/comparison', handler))))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/comparison`
  await seed([
    { enterprise: { name: 'Alpha复核', uscc: '91330211255994457P', district: '镇海区' }, titleCode: 'specialized_sme', events: [{ eventType: 'review', year: 2021, reviewOutcome: 'failed' }] },
    { enterprise: { name: 'Null双侧', district: '余姚市' }, titleCode: 'innovative_sme', source: 'miit', events: [] },
    { enterprise: { name: 'Null双侧', district: '鄞州区' }, titleCode: 'innovative_sme', source: 'jxj', events: [{ eventType: 'nurture', year: 2021 }] },
    { enterprise: { name: 'Beta无事件' }, titleCode: 'little_giant', events: [] },
    { enterprise: { name: 'Zeta平台', uscc: '91330201753252106U' }, titleCode: 'little_giant', source: 'miit', events: [] },
    { enterprise: { name: 'MATCHED初始', uscc: syntheticUscc(1) }, titleCode: 'specialized_sme', events: [] },
    { enterprise: { name: 'MATCHED初始', uscc: syntheticUscc(1) }, titleCode: 'specialized_sme', source: 'miit', events: [] },
  ])
}, 30000)

afterAll(async () => {
  if (server) await new Promise<void>(resolve => server.close(() => resolve()))
  await imports?.close()
  vi.unstubAllGlobals(); vi.doUnmock('@db')
  db.$client.close(); rmSync(dir, { recursive: true, force: true })
})

async function read(query = '') {
  const response = await fetch(base + query)
  expect(response.status).toBe(200)
  return response.json()
}
const coordinates = (rows: ComparisonRow[]) => rows.map(row => [row.name, row.titleCode, row.direction, row.district])
const expectedCoordinates = [
  ['Beta无事件', 'little_giant', 'missing_in_miit', null],
  ['Zeta平台', 'little_giant', 'extra_in_miit', null],
  ['Alpha复核', 'specialized_sme', 'missing_in_miit', '镇海区'],
  ['Null双侧', 'innovative_sme', 'extra_in_miit', '余姚市'],
  ['Null双侧', 'innovative_sme', 'missing_in_miit', '鄞州区'],
]

it('keeps source differences and driver materialization fixed as matched records grow', async () => {
  const initial = measureComparison()
  expect(coordinates(initial.result.rows)).toEqual(expectedCoordinates)
  const observations = [{ matchedEnterprises: 1, ...initial.metrics() }]
  for (const count of [4, 20]) {
    await seed(Array.from({ length: count }, (_, n): RosterImportRecord[] => {
      const enterprise = { name: `MATCHED合成${count}-${n}`, uscc: syntheticUscc(count * 100 + n) }
      return [
        { enterprise, titleCode: 'specialized_sme', source: 'jxj', events: [{ eventType: 'nurture', year: 2021 }] },
        { enterprise, titleCode: 'specialized_sme', source: 'miit', events: [] },
      ]
    }).flat())
    const after = measureComparison()
    expect(after.result).toEqual(initial.result)
    observations.push({ matchedEnterprises: count === 4 ? 5 : 25, ...after.metrics() })
  }

  // Only the five differences may cross the driver boundary, never matched
  // source rows or originals. This fails even on the small legacy fixture.
  expect(observations.map(sample => sample.rows)).toEqual([5, 5, 5])
  expect(observations.map(sample => sample.bytes)).toEqual([initial.metrics().bytes, initial.metrics().bytes, initial.metrics().bytes])
})

it('preserves full and summary HTTP membership, representatives, global counts, filters and pages', async () => {
  const counts = {
    little_giant: { missing_in_miit: 1, extra_in_miit: 1 },
    specialized_sme: { missing_in_miit: 1, extra_in_miit: 0 },
    innovative_sme: { missing_in_miit: 1, extra_in_miit: 1 },
  }
  const full = await read('?pageSize=50')
  expect(coordinates(full.rows)).toEqual(expectedCoordinates)
  expect(full.counts).toEqual(counts)
  const filtered = getComparison(db, { title: ['innovative_sme'], direction: 'missing_in_miit' })
  expect(coordinates(filtered.rows)).toEqual([expectedCoordinates[4]])
  expect(filtered.counts).toEqual(counts)
  expect(getComparison(db, { title: ['unknown'] })).toEqual({ rows: [], counts })
  expect(full.rows.find((row: ComparisonRow) => row.name === 'Alpha复核')).toMatchObject({
    uscc: '91330211255994457P', curated: false,
    evidence: { matchedBy: 'uscc', otherSideUscc: null, currentCity: null, regStatus: null },
  })
  expect(full.rows.filter((row: ComparisonRow) => row.name === 'Null双侧').map((row: ComparisonRow) => row.uscc)).toEqual([null, null])
  for (const view of ['full', 'summary']) {
    const all = await read(`?view=${view}&pageSize=50`)
    expect(coordinates(all.rows)).toEqual(expectedCoordinates)
    expect(all).toMatchObject({ total: 5, counts })
    const selected = await read(`?view=${view}&title=innovative_sme&direction=missing_in_miit&district=鄞州区`)
    expect(coordinates(selected.rows)).toEqual([expectedCoordinates[4]])
    expect(selected).toMatchObject({ total: 1, counts })
    expect(coordinates((await read(`?view=${view}&page=2&pageSize=2`)).rows)).toEqual(expectedCoordinates.slice(2, 4))
    expect(await read(`?view=${view}&page=99&pageSize=2`)).toMatchObject({ total: 5, rows: [], counts })
  }
})

it('keeps distinct stored USCC identities and title scopes separate while retaining the first source district', async () => {
  await seed([
    { enterprise: { name: 'Same名称', uscc: syntheticUscc(200), district: '宁海县' }, titleCode: 'specialized_sme', source: 'jxj', events: [] },
    { enterprise: { name: 'Same名称', uscc: syntheticUscc(201), district: '北仑区' }, titleCode: 'specialized_sme', source: 'miit', events: [] },
    // Opposite source exists for this USCC, but only under specialized_sme.
    { enterprise: { name: 'Alpha复核', uscc: '91330211255994457P', district: '慈溪市' }, titleCode: 'innovative_sme', source: 'miit', events: [] },
    { enterprise: { name: 'Alpha复核', uscc: '91330211255994457P', district: '宁海县' }, titleCode: 'specialized_sme', source: 'jxj', events: [] },
  ])
  const expected = [
    ['Alpha复核', 'specialized_sme', 'missing_in_miit', '镇海区'],
    ['Same名称', 'specialized_sme', 'missing_in_miit', '宁海县'],
    ['Same名称', 'specialized_sme', 'extra_in_miit', '北仑区'],
    ['Alpha复核', 'innovative_sme', 'extra_in_miit', '慈溪市'],
    ['Null双侧', 'innovative_sme', 'extra_in_miit', '余姚市'],
    ['Null双侧', 'innovative_sme', 'missing_in_miit', '鄞州区'],
  ]
  expect(coordinates(getComparison(db, { title: ['specialized_sme', 'innovative_sme'] }).rows)).toEqual(expected)
  for (const view of ['full', 'summary']) {
    const response = await read(`?view=${view}&title=specialized_sme,innovative_sme&pageSize=50`)
    expect(coordinates(response.rows)).toEqual(expected)
    expect(response).toMatchObject({ total: 6, counts: {
      little_giant: { missing_in_miit: 1, extra_in_miit: 1 },
      specialized_sme: { missing_in_miit: 2, extra_in_miit: 1 },
      innovative_sme: { missing_in_miit: 1, extra_in_miit: 2 },
    } })
    const twins = response.rows.filter((row: ComparisonRow) => row.name === 'Same名称')
    expect(twins.map((row: ComparisonRow) => row.uscc)).toEqual([syntheticUscc(200), syntheticUscc(201)])
    expect(twins[0].enterpriseId).toBeLessThan(twins[1].enterpriseId)
  }
})

it('returns all zero title buckets for an empty source set', () => {
  const empty = initializeDb({ create: true, dbPath: join(dir, 'empty.db') })
  try {
    expect(getComparison(empty)).toEqual({ rows: [], counts: {
      little_giant: { missing_in_miit: 0, extra_in_miit: 0 },
      specialized_sme: { missing_in_miit: 0, extra_in_miit: 0 },
      innovative_sme: { missing_in_miit: 0, extra_in_miit: 0 },
    } })
  } finally { empty.$client.close() }
})
