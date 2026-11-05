import { initializeDb } from '../db/client'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { schema, useDb } from '../db'
import { matrix408 } from './helpers/current-qualified-408'
import { preflightRecordCorrespondences, commitRecordCorrespondences } from '../server/utils/record-correspondence'
import { ensurePlatformObservation } from '../server/utils/platform-business-record'
import { listCurrentQualified, type CurrentQualifiedFilter, type CurrentQualifiedResult } from '../lib/roster/current-qualified-query'
import { writeCurrentWorkbook } from '../lib/roster/current-workbook'
import { readExportWorkbook } from './helpers/read-export-workbook'
import { TITLE_RDJB_CODES } from '../lib/platform/recognized-evidence'
import type { CurrentTitle } from '../lib/roster/current-titles'
import type { RecognizedFactSource } from '../lib/roster/recognized-filter-source'

vi.mock('@nuxtjs/mcp-toolkit/server', () => ({ defineMcpTool: (tool: unknown) => tool }))

const dirs: string[] = []
afterAll(() => dirs.forEach(dir => rmSync(dir, { recursive: true, force: true })))

type Db = ReturnType<typeof useDb>
type Formal = ReturnType<ReturnType<typeof matrix408>['formal']>

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'current-typed-468-'))
  dirs.push(dir)
  const dbPath = join(dir, 'typed.sqlite')
  vi.stubEnv('NUXT_DB_PATH', dbPath)
  const db = initializeDb({ create: true, dbPath })
  return { dir, dbPath, db, matrix: matrix408(db.$client) }
}

let stamp = 0
function seedRecognized(db: Db, formal: Formal, eventId: number, raw: Record<string, unknown>, conditions: Record<string, unknown> = {}, project = false) {
  const enterprise = formal.enterprise
  const titleCode = formal.record.titleCode as CurrentTitle
  const rdjb = TITLE_RDJB_CODES[titleCode]!
  const queriedAt = new Date(Date.UTC(2026, 4, 1, 0, stamp++)).toISOString()
  const query = db.insert(schema.platformQuery).values({
    interface: 'recognized_list', queryKey: enterprise.usccNorm ?? ('name:' + enterprise.name), titleCode, rdjb, queriedAt, status: 'success',
    collectionEvidence: {
      source: 'queryBusList', status: 'success', effectiveConditions: { combination: 'and', ...conditions },
      titleScope: { mode: 'selected', rdjb: [rdjb] }, queriedAt, completedAt: queriedAt, rows: [raw as never],
      pages: [{ source: 'queryBusList', rdjb, page: 1, status: 'success', fetchedCount: 1, declaredTotal: 1, maxPage: 1, error: null }],
      fetchedCount: 1, declaredTotal: 1, completeness: 'complete', fullRange: true, unfinished: [], error: null,
      limits: { maxRequests: 1, maxRows: 50, maxDurationMs: 1000, pageSize: 50 },
    },
  }).returning().get()
  const relation = db.insert(schema.platformRelation).values({
    queryId: query.id, enterpriseId: enterprise.id, sequenceNo: 1, relationKey: String(raw.id ?? ''),
    nameRaw: enterprise.name, usccRaw: enterprise.usccNorm, rawFields: raw, verificationStatus: 'confirmed', matchBasis: 'manual',
  }).returning().get()
  const request = {
    idempotencyKey: 'typed-468-' + relation.id, sourceIdentity: 'typed-468/' + relation.id,
    actor: { type: 'agent' as const, id: 'typed-468' }, basis: 'synthetic_typed_468', ruleId: 'manual', ruleVersion: '1',
    operations: [{ action: 'create' as const, status: 'confirmed' as const, edge: { type: 'event_recognized' as const, eventId, relationId: relation.id, role: 'recognized_corrob' as const } }],
  }
  const plan = preflightRecordCorrespondences(db, request)
  commitRecordCorrespondences(db, request, plan.planHash)
  const projection = project ? ensurePlatformObservation(db, relation.id) : null
  return { query, relation, projection }
}

function list(db: Db, filter: CurrentQualifiedFilter, source: RecognizedFactSource) {
  return listCurrentQualified(db.$client, filter, { recognizedFactSource: source })
}

const VOLATILE = new Set(['asOf', 'snapshotId', 'snapshotStartedAt'])
function strip(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(strip)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !VOLATILE.has(key))
      .map(([key, item]) => [key, strip(item)]))
  }
  return value
}

function witnessOf(result: CurrentQualifiedResult, enterpriseId: number) {
  const row = result.rows.find(item => item.enterpriseId === enterpriseId)!
  return { matchedValidYears: row.matchedValidYears, matchedMaintenance: row.matchedMaintenance, witnesses: row.qualificationWitnesses, references: row.references }
}

function seedShadow(db: Db, matrix: ReturnType<typeof matrix408>) {
  const a = matrix.formal('影子甲', [{ eventType: 'award', year: 2026, decidedYear: 2026, batchSeq: 1 }], { uscc: '91330211TYPED4681' })
  const b = matrix.formal('影子乙', [{ eventType: 'award', year: 2025, decidedYear: 2025, batchSeq: 1 }], { uscc: '91330211TYPED4682' })
  const c = matrix.formal('影子丙', [{ eventType: 'award', year: 2024, decidedYear: 2024, batchSeq: 1 }], { uscc: '91330211TYPED4683' })
  const aSeed = seedRecognized(db, a, a.events[0]!.id, { id: 'TYPED-468-A', qymc: a.enterprise.name, tyshxydm: a.enterprise.usccNorm, rdjb: '1', rddqrq: '2028-11-20', whpcyear: '', whpc: '2023-2' }, { rddqrq: '2028', whpcyear: '2023' }, true)
  const bSeed = seedRecognized(db, b, b.events[0]!.id, { id: 'TYPED-468-B', qymc: b.enterprise.name, tyshxydm: b.enterprise.usccNorm, rdjb: '1', rddqrq: '2029-12-31', whpcyear: '2024', whpc: '2024-2' }, { rddqrq: '2029', whpcyear: '2024' }, true)
  const cSeed = seedRecognized(db, c, c.events[0]!.id, { id: 'TYPED-468-C', qymc: c.enterprise.name, tyshxydm: c.enterprise.usccNorm, rdjb: '1', rddqrq: '2030-01-01', whpcyear: '', whpc: '2025-1' }, { rddqrq: '2030', whpcyear: '2025' }, true)
  return { a, b, c, aSeed, bSeed, cSeed }
}

const SHADOW_FILTERS: Array<Omit<CurrentQualifiedFilter, 'titleCode'>> = [
  {},
  { q: '影子甲' },
  { district: '鄞州区' },
  { recognitionFrom: '2025-01-01', recognitionTo: '2025-12-31' },
  { recognitionFrom: '2025-06-01', recognitionTo: '2025-12-31' },
  { validYear: 2028 },
  { validYear: 2030 },
  { maintenanceYear: 2023 },
  { maintenanceYear: 2025 },
  { maintenanceYear: 2025, maintenanceBatch: 1 },
  { validYear: 2028, maintenanceYear: 2023 },
  { page: 2, pageSize: 1 },
  { sort: 'name_desc' },
]

it('typed and legacy readers are identical on the same projected input across counts, pages, filters and assessment evidence', () => {
  const { db, matrix } = setup()
  const seeded = seedShadow(db, matrix)
  for (const filter of SHADOW_FILTERS) {
    const input: CurrentQualifiedFilter = { ...filter, titleCode: 'innovative_sme' }
    const typed = list(db, input, 'typed')
    const legacy = list(db, input, 'legacy')
    expect(strip(typed), JSON.stringify(filter)).toEqual(strip(legacy))
  }
  const typed = list(db, { titleCode: 'innovative_sme' }, 'typed')
  const legacy = list(db, { titleCode: 'innovative_sme' }, 'legacy')
  expect(witnessOf(typed, seeded.c.enterprise.id)).toEqual(witnessOf(legacy, seeded.c.enterprise.id))
  expect(witnessOf(typed, seeded.c.enterprise.id).matchedValidYears).toEqual([2030])
  expect(witnessOf(typed, seeded.c.enterprise.id).matchedMaintenance).toEqual([{ year: 2025, batch: null }])
  expect(witnessOf(typed, seeded.a.enterprise.id)).toEqual(witnessOf(legacy, seeded.a.enterprise.id))
  expect(witnessOf(typed, seeded.b.enterprise.id)).toEqual(witnessOf(legacy, seeded.b.enterprise.id))
})

it('the operational env rollback selects the legacy reader without a code option', () => {
  const { db, matrix } = setup()
  seedShadow(db, matrix)
  vi.stubEnv('ROSTER_RECOGNIZED_FILTER_SOURCE', 'legacy')
  try {
    const viaEnv = listCurrentQualified(db.$client, { titleCode: 'innovative_sme', validYear: 2028 })
    const explicit = list(db, { titleCode: 'innovative_sme', validYear: 2028 }, 'legacy')
    expect(strip(viaEnv)).toEqual(strip(explicit))
  } finally { vi.unstubAllEnvs() }
})

it('a present typed projection is authoritative when its source field is null; it never falls back to raw', () => {
  const { db, matrix } = setup()
  const enterprise = matrix.formal('空投影字段', [{ eventType: 'award', year: 2026, decidedYear: 2026, batchSeq: 1 }], { uscc: '91330211TYPED4684' })
  const seeded = seedRecognized(db, enterprise, enterprise.events[0]!.id, { id: 'TYPED-468-NULL', qymc: enterprise.enterprise.name, tyshxydm: enterprise.enterprise.usccNorm, rdjb: '1', rddqrq: '2031-05-05', whpcyear: '', whpc: '2026-2' }, { rddqrq: '2031', whpcyear: '2026' }, true)
  db.update(schema.platformRecognizedProjection).set({ sourceValidityDate: null, sourceMaintenanceBatch: null })
    .where(eq(schema.platformRecognizedProjection.versionId, seeded.projection!.versionId!)).run()

  const typed = list(db, { titleCode: 'innovative_sme' }, 'typed')
  const legacy = list(db, { titleCode: 'innovative_sme' }, 'legacy')
  expect(witnessOf(typed, enterprise.enterprise.id).matchedValidYears).toEqual([])
  expect(witnessOf(typed, enterprise.enterprise.id).matchedMaintenance).toEqual([])
  expect(witnessOf(legacy, enterprise.enterprise.id).matchedValidYears).toEqual([2031])
  expect(witnessOf(legacy, enterprise.enterprise.id).matchedMaintenance).toEqual([{ year: 2026, batch: null }])
  expect(list(db, { titleCode: 'innovative_sme', validYear: 2031 }, 'typed').total).toBe(0)
  expect(list(db, { titleCode: 'innovative_sme', validYear: 2031 }, 'legacy').total).toBe(1)
})

it('an observation without a typed projection stays unavailable until explicit completion', () => {
  const { db, matrix } = setup()
  const enterprise = matrix.formal('观察无投影', [{ eventType: 'award', year: 2026, decidedYear: 2026, batchSeq: 1 }], { uscc: '91330211TYPED4685' })
  const seeded = seedRecognized(db, enterprise, enterprise.events[0]!.id, { id: 'TYPED-468-NOPROJ', qymc: enterprise.enterprise.name, tyshxydm: enterprise.enterprise.usccNorm, rdjb: '1', rddqrq: '2032-06-06', whpcyear: '', whpc: '2027-3' }, { rddqrq: '2032', whpcyear: '2027' }, true)
  db.delete(schema.platformRecognizedProjection).where(eq(schema.platformRecognizedProjection.versionId, seeded.projection!.versionId!)).run()

  const typed = list(db, { titleCode: 'innovative_sme' }, 'typed')
  const legacy = list(db, { titleCode: 'innovative_sme' }, 'legacy')
  expect(witnessOf(typed, enterprise.enterprise.id).matchedValidYears).toEqual([])
  expect(witnessOf(typed, enterprise.enterprise.id).matchedMaintenance).toEqual([])
  expect(witnessOf(legacy, enterprise.enterprise.id).matchedValidYears).toEqual([2032])
  expect(witnessOf(legacy, enterprise.enterprise.id).matchedMaintenance).toEqual([{ year: 2027, batch: null }])
})

it('preserves legacy rejection of padded dates, batches and invalid nonempty years', () => {
  const { db, matrix } = setup()
  const paddedDate = matrix.formal('空白日期原值', [{ eventType: 'award', year: 2026, decidedYear: 2026, batchSeq: 1 }], { uscc: '91330211TYPED4686' })
  seedRecognized(db, paddedDate, paddedDate.events[0]!.id, { id: 'TYPED-468-PAD', qymc: paddedDate.enterprise.name, tyshxydm: paddedDate.enterprise.usccNorm, rdjb: '1', rddqrq: ' 2028-11-20 ', whpcyear: '', whpc: ' 2023-2 ' }, { rddqrq: '2028', whpcyear: '2023' }, true)
  const paddedYear = matrix.formal('空白维护年', [{ eventType: 'award', year: 2026, decidedYear: 2026, batchSeq: 1 }], { uscc: '91330211TYPED4687' })
  seedRecognized(db, paddedYear, paddedYear.events[0]!.id, { id: 'TYPED-468-PADYEAR', qymc: paddedYear.enterprise.name, tyshxydm: paddedYear.enterprise.usccNorm, rdjb: '1', rddqrq: '', whpcyear: ' 2024 ', whpc: '2023-2' }, { whpcyear: '2023' }, true)

  const typed = list(db, { titleCode: 'innovative_sme' }, 'typed')
  const legacy = list(db, { titleCode: 'innovative_sme' }, 'legacy')
  expect(witnessOf(typed, paddedDate.enterprise.id).matchedValidYears).toEqual([])
  expect(witnessOf(typed, paddedDate.enterprise.id).matchedMaintenance).toEqual([])
  expect(witnessOf(legacy, paddedDate.enterprise.id).matchedValidYears).toEqual([])
  expect(witnessOf(legacy, paddedDate.enterprise.id).matchedMaintenance).toEqual([])
  expect(witnessOf(typed, paddedYear.enterprise.id).matchedMaintenance).toEqual([])
  expect(witnessOf(legacy, paddedYear.enterprise.id).matchedMaintenance).toEqual([])
})

async function startCurrentServer() {
  const h3 = await import('h3')
  vi.stubGlobal('defineEventHandler', h3.defineEventHandler)
  const { default: handler } = await import('../server/api/roster/current-enterprises.get')
  const router = h3.createRouter().get('/api/roster/current-enterprises', handler)
  const server = createServer(h3.toNodeListener(h3.createApp().use(router)))
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address() as AddressInfo
  return { server, base: 'http://127.0.0.1:' + address.port }
}

let workbookCounter = 0
async function readWorkbook(db: Db, dir: string) {
  const file = join(dir, 'typed-468-' + workbookCounter++ + '.xlsx')
  const summary = await writeCurrentWorkbook(db.$client, 'innovative_sme', file, () => {})
  const workbook = await readExportWorkbook(readFileSync(file))
  const sheets = workbook.worksheets.map(sheet => ({
    name: sheet.name,
    rows: (sheet.getRows(2, Math.max(0, sheet.rowCount - 1)) ?? []).map(row => (row.values as unknown[]).slice(1)),
  }))
  for (const sheet of sheets) if (sheet.name === '口径说明') sheet.rows = sheet.rows.filter(row => row[0] !== '生成时间')
  return { sheets, counts: summary.counts, total: summary.total }
}

it('HTTP, MCP and the three-title workbook share the typed reader; the workbook decision surface does not move', async () => {
  const { dir, db, matrix } = setup()
  const enterprise = matrix.formal('四消费者企业', [{ eventType: 'award', year: 2026, decidedYear: 2026, batchSeq: 1 }], { uscc: '91330211TYPED4688' })
  const seeded = seedRecognized(db, enterprise, enterprise.events[0]!.id, { id: 'TYPED-468-H', qymc: enterprise.enterprise.name, tyshxydm: enterprise.enterprise.usccNorm, rdjb: '1', rddqrq: '2028-11-20', whpcyear: '', whpc: '2023-2' }, { rddqrq: '2028', whpcyear: '2023' }, false)
  const { server, base } = await startCurrentServer()
  const query = async (params: string) => {
    const response = await fetch(base + '/api/roster/current-enterprises?titleCode=innovative_sme&' + params)
    expect(response.status).toBe(200)
    return await response.json() as CurrentQualifiedResult
  }
  const mcp = async () => {
    const { default: tool } = await import('../server/mcp/tools/list_current_qualified_enterprises')
    return JSON.parse(await (tool as any).handler({ titleCode: 'innovative_sme', validYear: 2028, maintenanceYear: 2023 }, {})) as CurrentQualifiedResult
  }
  try {
    expect(await query('validYear=2028&maintenanceYear=2023')).toMatchObject({ total: 0, rows: [] })
    expect(await mcp()).toMatchObject({ total: 0 })
    const workbookBefore = await readWorkbook(db, dir)
    expect(workbookBefore.counts.eligible).toBe(1)

    const projection = ensurePlatformObservation(db, seeded.relation.id)
    expect(await query('validYear=2028&maintenanceYear=2023')).toMatchObject({ total: 1 })
    expect(await mcp()).toMatchObject({ total: 1 })
    expect(await readWorkbook(db, dir)).toEqual(workbookBefore)

    db.update(schema.platformRecognizedProjection).set({ sourceValidityDate: '2031-01-01', sourceMaintenanceBatch: '2031-9' })
      .where(eq(schema.platformRecognizedProjection.versionId, projection.versionId!)).run()
    expect(await query('validYear=2028&maintenanceYear=2023')).toMatchObject({ total: 0, rows: [] })
    expect(await mcp()).toMatchObject({ total: 0, rows: [] })
    expect(await readWorkbook(db, dir)).toEqual(workbookBefore)
    expect(list(db, { titleCode: 'innovative_sme', validYear: 2028, maintenanceYear: 2023 }, 'legacy')).toMatchObject({ total: 1 })
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
}, 120_000)


it('HTTP and MCP preserve legacy malformed, padded, missing, null, empty and valid source partitions', async () => {
  const { db, matrix } = setup()
  const cases: Array<{ label: string; raw: Record<string, unknown>; valid: number[]; maintenance: Array<{year: number; batch: null}> }> = [
    ...['bad', 0, false, ' ', ' 2024 ', '2026', 2026, [], {}].map(value => ({ label: JSON.stringify(value), raw: { whpcyear: value }, valid: [2028], maintenance: [] })),
    ...[{}, { whpcyear: null }, { whpcyear: '' }].map(raw => ({ label: JSON.stringify(raw), raw, valid: [2028], maintenance: [{year: 2026, batch: null}] })),
    { label: 'padded date', raw: { rddqrq: ' 2028-11-20 ', whpcyear: '' }, valid: [], maintenance: [{year: 2026, batch: null}] },
    { label: 'padded batch', raw: { whpc: ' 2026-1 ', whpcyear: '' }, valid: [2028], maintenance: [] },
    { label: 'nonstring date and batch', raw: { rddqrq: 2028, whpc: 2026, whpcyear: '' }, valid: [], maintenance: [] },
    { label: 'invalid calendar date', raw: { rddqrq: '2028-02-30', whpc: '2026-16', whpcyear: '' }, valid: [], maintenance: [] },
  ]
  const seeded = cases.map((item, index) => {
    const formal = matrix.formal('边界' + index, [{eventType: 'award', year: 2026, decidedYear: 2026, batchSeq: 1}], {uscc: '91330211BOUND' + String(index).padStart(6, '0')})
    const source = seedRecognized(db, formal, formal.events[0]!.id, { id: 'BOUND-' + index, qymc: formal.enterprise.name, tyshxydm: formal.enterprise.usccNorm, rddqrq: '2028-11-20', whpc: '2026-1', ...item.raw }, {}, true)
    return { ...item, formal, source }
  })
  const {server, base} = await startCurrentServer()
  try {
    const {default: tool} = await import('../server/mcp/tools/list_current_qualified_enterprises')
    for (const item of seeded) {
      const filter = { titleCode: 'innovative_sme' as const, q: item.formal.enterprise.name }
      const response = await fetch(base + '/api/roster/current-enterprises?' + new URLSearchParams(filter))
      expect(response.status).toBe(200)
      const http = await response.json() as CurrentQualifiedResult
      const mcp = JSON.parse(await (tool as any).handler(filter, {})) as CurrentQualifiedResult
      const legacy = list(db, filter, 'legacy')
      expect(strip(http), item.label).toEqual(strip(legacy))
      expect(strip(mcp), item.label).toEqual(strip(legacy))
      expect(witnessOf(http, item.formal.enterprise.id).matchedValidYears, item.label).toEqual(item.valid)
      expect(witnessOf(http, item.formal.enterprise.id).matchedMaintenance, item.label).toEqual(item.maintenance)
    }
    // A captured row whose supplementary facts are unavailable never borrows raw.
    const first = seeded[0]!
    db.update(schema.platformRecognizedProjection).set({sourceValidityDate: null, sourceMaintenanceBatch: null, sourceMaintenanceYearAbsent: null})
      .where(eq(schema.platformRecognizedProjection.versionId, first.source.projection!.versionId!)).run()
    const response = await fetch(base + '/api/roster/current-enterprises?' + new URLSearchParams({titleCode: 'innovative_sme', q: first.formal.enterprise.name}))
    expect(witnessOf(await response.json() as CurrentQualifiedResult, first.formal.enterprise.id).matchedValidYears).toEqual([])
    expect(witnessOf(list(db, {titleCode: 'innovative_sme', q: first.formal.enterprise.name}, 'legacy'), first.formal.enterprise.id).matchedValidYears).toEqual([2028])
  } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
})
