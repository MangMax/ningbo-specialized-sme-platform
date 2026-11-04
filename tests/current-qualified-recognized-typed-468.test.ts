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
  const db = useDb({ dbPath })
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
  const cSeed = seedRecognized(db, c, c.events[0]!.id, { id: 'TYPED-468-C', qymc: c.enterprise.name, tyshxydm: c.enterprise.usccNorm, rdjb: '1', rddqrq: '2030-01-01', whpcyear: '', whpc: '2025-1' }, { rddqrq: '2030', whpcyear: '2025' }, false)
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

it('a present typed projection is authoritative when its source field is null; it never falls back to raw', () => {
  const { db, matrix } = setup()
  const enterprise = matrix.formal('空投影字段', [{ eventType: 'award', year: 2026, decidedYear: 2026, batchSeq: 1 }], { uscc: '91330211TYPED4684' })
  const seeded = seedRecognized(db, enterprise, enterprise.events[0]!.id, { id: 'TYPED-468-NULL', qymc: enterprise.enterprise.name, tyshxydm: enterprise.enterprise.usccNorm, rdjb: '1', rddqrq: '2031-05-05', whpcyear: '', whpc: '2026-2' }, { rddqrq: '2031', whpcyear: '2026' }, true)
  db.update(schema.platformRecognizedProjection).set({ validityDateRaw: null, maintenanceYear: null, maintenanceBatch: null })
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

it('an observation without a typed projection still falls back to the original raw fields', () => {
  const { db, matrix } = setup()
  const enterprise = matrix.formal('观察无投影', [{ eventType: 'award', year: 2026, decidedYear: 2026, batchSeq: 1 }], { uscc: '91330211TYPED4685' })
  const seeded = seedRecognized(db, enterprise, enterprise.events[0]!.id, { id: 'TYPED-468-NOPROJ', qymc: enterprise.enterprise.name, tyshxydm: enterprise.enterprise.usccNorm, rdjb: '1', rddqrq: '2032-06-06', whpcyear: '', whpc: '2027-3' }, { rddqrq: '2032', whpcyear: '2027' }, true)
  db.delete(schema.platformRecognizedProjection).where(eq(schema.platformRecognizedProjection.versionId, seeded.projection!.versionId!)).run()

  const typed = list(db, { titleCode: 'innovative_sme' }, 'typed')
  const legacy = list(db, { titleCode: 'innovative_sme' }, 'legacy')
  expect(witnessOf(typed, enterprise.enterprise.id)).toEqual(witnessOf(legacy, enterprise.enterprise.id))
  expect(witnessOf(typed, enterprise.enterprise.id).matchedValidYears).toEqual([2032])
  expect(witnessOf(typed, enterprise.enterprise.id).matchedMaintenance).toEqual([{ year: 2027, batch: null }])
})

it('records the approved trim-only difference: whitespace-padded source values become known only through the typed projection', () => {
  const { db, matrix } = setup()
  const paddedDate = matrix.formal('空白日期原值', [{ eventType: 'award', year: 2026, decidedYear: 2026, batchSeq: 1 }], { uscc: '91330211TYPED4686' })
  seedRecognized(db, paddedDate, paddedDate.events[0]!.id, { id: 'TYPED-468-PAD', qymc: paddedDate.enterprise.name, tyshxydm: paddedDate.enterprise.usccNorm, rdjb: '1', rddqrq: ' 2028-11-20 ', whpcyear: '', whpc: ' 2023-2 ' }, { rddqrq: '2028', whpcyear: '2023' }, true)
  const paddedYear = matrix.formal('空白维护年', [{ eventType: 'award', year: 2026, decidedYear: 2026, batchSeq: 1 }], { uscc: '91330211TYPED4687' })
  seedRecognized(db, paddedYear, paddedYear.events[0]!.id, { id: 'TYPED-468-PADYEAR', qymc: paddedYear.enterprise.name, tyshxydm: paddedYear.enterprise.usccNorm, rdjb: '1', rddqrq: '', whpcyear: ' 2024 ', whpc: '2023-2' }, { whpcyear: '2023' }, true)

  const typed = list(db, { titleCode: 'innovative_sme' }, 'typed')
  const legacy = list(db, { titleCode: 'innovative_sme' }, 'legacy')
  expect(witnessOf(typed, paddedDate.enterprise.id).matchedValidYears).toEqual([2028])
  expect(witnessOf(typed, paddedDate.enterprise.id).matchedMaintenance).toEqual([{ year: 2023, batch: null }])
  expect(witnessOf(legacy, paddedDate.enterprise.id).matchedValidYears).toEqual([])
  expect(witnessOf(legacy, paddedDate.enterprise.id).matchedMaintenance).toEqual([])
  expect(witnessOf(typed, paddedYear.enterprise.id).matchedMaintenance).toEqual([{ year: 2023, batch: null }])
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
    expect(await query('validYear=2028&maintenanceYear=2023')).toMatchObject({ total: 1, rows: [{ enterpriseId: enterprise.enterprise.id, matchedValidYears: [2028] }] })
    expect(await mcp()).toMatchObject({ total: 1 })
    const workbookBefore = await readWorkbook(db, dir)
    expect(workbookBefore.counts.eligible).toBe(1)

    const projection = ensurePlatformObservation(db, seeded.relation.id)
    expect(await query('validYear=2028&maintenanceYear=2023')).toMatchObject({ total: 1 })
    expect(await mcp()).toMatchObject({ total: 1 })
    expect(await readWorkbook(db, dir)).toEqual(workbookBefore)

    db.update(schema.platformRecognizedProjection).set({ validityDateRaw: '2031-01-01', maintenanceYear: null, maintenanceBatch: '2031-9' })
      .where(eq(schema.platformRecognizedProjection.versionId, projection.versionId!)).run()
    expect(await query('validYear=2028&maintenanceYear=2023')).toMatchObject({ total: 0, rows: [] })
    expect(await mcp()).toMatchObject({ total: 0, rows: [] })
    expect(await readWorkbook(db, dir)).toEqual(workbookBefore)
    expect(list(db, { titleCode: 'innovative_sme', validYear: 2028, maintenanceYear: 2023 }, 'legacy')).toMatchObject({ total: 1 })
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
}, 120_000)
