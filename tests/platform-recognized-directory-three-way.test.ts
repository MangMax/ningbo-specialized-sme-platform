import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp, createRouter, toNodeListener, defineEventHandler, setHeader, getQuery, getRouterParam, createError } from 'h3'
import { afterAll, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { schema, useDb } from '../db'
import { matrix408 } from './helpers/current-qualified-408'
import { preflightRecordCorrespondences, commitRecordCorrespondences } from '../server/utils/record-correspondence'
import { ensurePlatformObservation } from '../server/utils/platform-business-record'
import { enterpriseReads } from '../server/utils/enterprise-read'
import { writeCurrentWorkbook } from '../lib/roster/current-workbook'
import { readExportWorkbook } from './helpers/read-export-workbook'
import type { RecognizedDirectoryListResult } from '../lib/platform/recognized-directory'

// The public reader seam: the same h3 routes the application mounts.
for (const [key, value] of Object.entries({ defineEventHandler, setHeader, getQuery, getRouterParam, createError })) vi.stubGlobal(key, value)
afterAll(async () => { vi.unstubAllGlobals(); await enterpriseReads.close() })

interface FormalSeed {
  enterprise: { id: number; name: string; usccNorm: string | null }
  record: { titleCode: string }
  events: { id: number }[]
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'recognized-three-way-'))
  const dbPath = join(dir, 'three-way.sqlite')
  // The public routes resolve their handle from the same environment variable.
  vi.stubEnv('NUXT_DB_PATH', dbPath)
  const db = useDb({ dbPath })
  return { dir, dbPath, db, matrix: matrix408(db.$client) }
}

/** Private synthetic archive: same archive shape an import would persist, plus an explicit
 * observed validity condition so the existing #155 filter witness can be exercised. */
let stamp = 0
function seedRecognized(db: ReturnType<typeof useDb>, formal: FormalSeed, eventId: number, raw: Record<string, unknown>, conditions: Record<string, unknown> = {}) {
  const enterprise = formal.enterprise
  const titleCode = formal.record.titleCode
  const rdjb = ({ innovative_sme: '1', specialized_sme: '2', little_giant: '3' } as Record<string, string>)[titleCode]!
  const queriedAt = new Date(Date.UTC(2026, 4, 1, 0, stamp++)).toISOString()
  const query = db.insert(schema.platformQuery).values({
    interface: 'recognized_list', queryKey: enterprise.usccNorm ?? `name:${enterprise.name}`, titleCode, rdjb, queriedAt, status: 'success',
    collectionEvidence: {
      source: 'queryBusList', status: 'success', effectiveConditions: { combination: 'and', ...conditions },
      titleScope: { mode: 'selected', rdjb: [rdjb] }, queriedAt, completedAt: queriedAt, rows: [raw as never],
      pages: [{ source: 'queryBusList', rdjb, page: 1, status: 'success', fetchedCount: 1, declaredTotal: 1, maxPage: 1, error: null }],
      fetchedCount: 1, declaredTotal: 1, completeness: 'complete', fullRange: true, unfinished: [], error: null,
      limits: { maxRequests: 1, maxRows: 50, maxDurationMs: 1000, pageSize: 50 },
    },
  }).returning().get()
  const relation = db.insert(schema.platformRelation).values({
    queryId: query.id, enterpriseId: enterprise.id, sequenceNo: 1,
    nameRaw: enterprise.name, usccRaw: enterprise.usccNorm, rawFields: raw, verificationStatus: 'confirmed', matchBasis: 'manual',
  }).returning().get()
  const request = {
    idempotencyKey: `three-way-${relation.id}`, sourceIdentity: `three-way/${relation.id}`,
    actor: { type: 'agent' as const, id: 'three-way' }, basis: 'synthetic_three_way', ruleId: 'manual', ruleVersion: '1',
    operations: [{ action: 'create' as const, status: 'confirmed' as const, edge: { type: 'event_recognized' as const, eventId, relationId: relation.id, role: 'recognized_corrob' as const } }],
  }
  const plan = preflightRecordCorrespondences(db, request)
  commitRecordCorrespondences(db, request, plan.planHash)
  const projection = ensurePlatformObservation(db, relation.id)
  return { query, relation, recordId: projection.recordId! }
}

/** An unconfirmed directory row: archived and projected, but never linked to a formal event. */
function seedUnconfirmed(db: ReturnType<typeof useDb>, enterprise: { id: number; name: string; usccNorm: string | null }, raw: Record<string, unknown>, rdjb = '1') {
  const queriedAt = new Date(Date.UTC(2026, 5, 1, 0, stamp++)).toISOString()
  const query = db.insert(schema.platformQuery).values({ interface: 'recognized_list', queryKey: enterprise.usccNorm ?? `name:${enterprise.name}`, rdjb, titleCode: 'innovative_sme', queriedAt, status: 'success' }).returning().get()
  db.insert(schema.platformQueryTitleScope).values({ queryId: query.id, rdjb }).run()
  const relation = db.insert(schema.platformRelation).values({
    queryId: query.id, enterpriseId: enterprise.id, sequenceNo: 1, nameRaw: enterprise.name, usccRaw: enterprise.usccNorm,
    rawFields: raw, verificationStatus: 'pending', matchBasis: 'uscc',
  }).returning().get()
  const projection = ensurePlatformObservation(db, relation.id)
  return { query, relation, recordId: projection.recordId }
}

function removeDirectoryArchive(db: ReturnType<typeof useDb>, recordId: number, relationId: number, queryId: number) {
  const correspondenceIds = db.select({ id: schema.recordCorrespondence.id }).from(schema.recordCorrespondence).where(eq(schema.recordCorrespondence.relationId, relationId)).all()
  for (const { id } of correspondenceIds) db.delete(schema.recordCorrespondenceAudit).where(eq(schema.recordCorrespondenceAudit.correspondenceId, id)).run()
  db.delete(schema.recordCorrespondence).where(eq(schema.recordCorrespondence.relationId, relationId)).run()
  db.delete(schema.platformBusinessObservation).where(eq(schema.platformBusinessObservation.relationId, relationId)).run()
  db.delete(schema.platformRecognizedProjection).where(eq(schema.platformRecognizedProjection.recordId, recordId)).run()
  db.delete(schema.platformBusinessRecordVersion).where(eq(schema.platformBusinessRecordVersion.recordId, recordId)).run()
  db.delete(schema.platformBusinessRecord).where(eq(schema.platformBusinessRecord.id, recordId)).run()
  db.delete(schema.platformRelation).where(eq(schema.platformRelation.id, relationId)).run()
  db.delete(schema.platformQuery).where(eq(schema.platformQuery.id, queryId)).run()
}

function databaseContent(db: ReturnType<typeof useDb>) {
  const sqlite = db.$client
  const ddl = sqlite.prepare("select type,name,tbl_name,sql from sqlite_master order by type,name").all()
  const tables = sqlite.prepare("select name from sqlite_master where type='table' order by name").all() as { name: string }[]
  const rows = tables.map(({ name }) => {
    const quoted = '"' + name.replaceAll('"', '""') + '"'
    return [name, sqlite.prepare(`select * from ${quoted}`).all().map(row => JSON.stringify(row)).sort()]
  })
  return createHash('sha256').update(JSON.stringify([ddl, rows])).digest('hex')
}

async function startServer() {
  const listRoute = (await import('../server/api/platform/recognized-directory.get')).default
  const detailRoute = (await import('../server/api/platform/recognized-directory/[recordId].get')).default
  const router = createRouter()
    .get('/api/platform/recognized-directory', listRoute)
    .get('/api/platform/recognized-directory/:recordId', detailRoute)
  const server = createServer(toNodeListener(createApp().use(router)))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }
}

async function readA(base: string, query: Record<string, string> = {}) {
  const response = await fetch(base + '/api/platform/recognized-directory?' + new URLSearchParams(query))
  expect(response.status).toBe(200)
  return await response.json() as RecognizedDirectoryListResult
}

/** The exact call the /api/roster/current-enterprises route makes. */
async function readB(dbPath: string, filter: Record<string, unknown> = {}) {
  const result = await enterpriseReads.currentQualifiedJson(dbPath, { titleCode: 'innovative_sme', page: 1, pageSize: 25, ...filter } as never, new AbortController().signal)
  return JSON.parse(result.body.toString('utf8')) as { total: number; uncertainTotal: number; rows: Record<string, unknown>[] }
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

let workbookCounter = 0
/** The real workbook writer the async export job runs; only the generated-at row is volatile. */
async function readC(db: ReturnType<typeof useDb>, dir: string) {
  const file = join(dir, `current-${workbookCounter++}.xlsx`)
  const summary = await writeCurrentWorkbook(db.$client, 'innovative_sme', file, () => {})
  const workbook = await readExportWorkbook(readFileSync(file))
  const sheets = workbook.worksheets.map(sheet => ({
    name: sheet.name,
    rows: (sheet.getRows(2, Math.max(0, sheet.rowCount - 1)) ?? []).map(row => (row.values as unknown[]).slice(1)),
  }))
  for (const sheet of sheets) if (sheet.name === '口径说明') sheet.rows = sheet.rows.filter(row => row[0] !== '生成时间')
  return { sheets, counts: summary.counts, total: summary.total }
}

const eligibleIdentities = (c: Awaited<ReturnType<typeof readC>>) => (c.sheets.find(sheet => sheet.name === '有效企业')?.rows ?? []).map(row => [row[1], row[2]])
/** Formal export surface: sheet names, decision counts and every column except the existing
 * 来源及页码 provenance text, which intentionally cites archived platform observations. */
const exportSnapshot = (c: Awaited<ReturnType<typeof readC>>) => ({
  counts: c.counts,
  total: c.total,
  sheets: c.sheets.map(sheet => ({ name: sheet.name, rows: sheet.name === '口径说明' ? sheet.rows : sheet.rows.map(row => row.slice(0, 11)) })),
})
const citationColumn = (c: Awaited<ReturnType<typeof readC>>) => (c.sheets.find(sheet => sheet.name === '有效企业')?.rows ?? []).map(row => String(row[11] ?? '')).join('\n')
const eligibility = (b: Awaited<ReturnType<typeof readB>>) => ({ total: b.total, rows: b.rows.map(row => [row.enterpriseId, row.name, row.group]) })

it('keeps the qualification read model and the export snapshot identical when directory typed values change or disappear', async () => {
  const { dir, dbPath, db, matrix } = setup()
  const { server, base } = await startServer()
  try {
    const formal = matrix.formal('三路对照企业', [{ eventType: 'award', year: 2025, decidedYear: 2025, batchSeq: 1 }], { uscc: '91330211FFFF000001' })
    const uscc = formal.enterprise.usccNorm
    const raw = { id: 'DIR-TRI-1', qymc: formal.enterprise.name, tyshxydm: uscc, rdjb: '1', rddqrq: '2028-06-01', whpcyear: '2024', whpc: '2024-2', szq: '33020000', rdxx: '原始认定说明' }
    const seeded = seedRecognized(db, formal, formal.events[0]!.id, raw, { rddqrq: '2028' })

    const before = databaseContent(db)
    const A0 = await readA(base, { q: '三路对照企业' })
    const B0 = await readB(dbPath)
    const C0 = await readC(db, dir)
    // Baseline stability: three read-only surfaces never write.
    expect(databaseContent(db)).toBe(before)
    expect(A0.total).toBe(1)
    expect(A0.rows[0]).toMatchObject({ kind: 'record', matchedVersion: { validityDateRaw: '2028-06-01', maintenanceYear: 2024, maintenanceBatch: '2024-2', district: '33020000', titleRaw: '1' }, titleScopes: ['1'] })
    expect(B0.total).toBe(1)
    expect(B0.rows[0]).toMatchObject({ enterpriseId: formal.enterprise.id, group: 'eligible' })
    expect((B0.rows[0] as { matchedValidYears: number[] }).matchedValidYears).toEqual([2028])
    expect(C0.counts.eligible).toBe(1)
    expect(eligibleIdentities(C0)).toEqual([[formal.enterprise.name, uscc]])

    // A typed projection change is visible only in the directory reader.
    db.update(schema.platformRecognizedProjection).set({ validityDateRaw: '2031-12-31', maintenanceYear: 2031, district: '99999999' })
      .where(eq(schema.platformRecognizedProjection.recordId, seeded.recordId)).run()
    const A1 = await readA(base, { q: '三路对照企业' })
    const B1 = await readB(dbPath)
    const C1 = await readC(db, dir)
    expect(A1.total).toBe(1)
    expect(A1.rows[0]).toMatchObject({ matchedVersion: { validityDateRaw: '2031-12-31', maintenanceYear: 2031, district: '99999999' } })
    expect(strip(B1)).toEqual(strip(B0))
    expect(C1).toEqual(C0)

    // Removing only the typed projection empties the typed columns and keeps the record visible.
    db.delete(schema.platformRecognizedProjection).where(eq(schema.platformRecognizedProjection.recordId, seeded.recordId)).run()
    const A2 = await readA(base, { q: '三路对照企业' })
    const B2 = await readB(dbPath)
    const C2 = await readC(db, dir)
    expect(A2.total).toBe(1)
    expect(A2.rows[0]).toMatchObject({ matchedVersion: { validityDateRaw: null, maintenanceYear: null, maintenanceBatch: null, district: null, ruleVersion: null } })
    expect(A2.rows[0]).toMatchObject({ conflicts: [] })
    expect(strip(B2)).toEqual(strip(B0))
    expect(C2).toEqual(C0)
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
    db.$client.close(); rmSync(dir, { recursive: true, force: true }); vi.unstubAllEnvs()
  }
}, 120_000)

it('isolates the directory row when its observation disappears and never lets that remove formal eligibility or export rows', async () => {
  const { dir, dbPath, db, matrix } = setup()
  const { server, base } = await startServer()
  try {
    const formal = matrix.formal('目录消失对照企业', [{ eventType: 'award', year: 2025, decidedYear: 2025, batchSeq: 1 }], { uscc: '91330211FFFF000002' })
    const raw = { id: 'DIR-TRI-2', qymc: formal.enterprise.name, tyshxydm: formal.enterprise.usccNorm, rdjb: '1', rddqrq: '2028-06-01', whpcyear: '2024', whpc: '2024-2', szq: '33020000' }
    const seeded = seedRecognized(db, formal, formal.events[0]!.id, raw, { rddqrq: '2028' })
    const C0 = await readC(db, dir)
    const B0 = await readB(dbPath)
    const B0Filtered = await readB(dbPath, { validYear: 2028 })
    expect((await readA(base, { q: '目录消失对照企业' })).total).toBe(1)
    expect(B0.total).toBe(1)
    expect(B0Filtered.total).toBe(1)

    removeDirectoryArchive(db, seeded.recordId, seeded.relation.id, seeded.query.id)
    const A1 = await readA(base, { q: '目录消失对照企业' })
    const B1 = await readB(dbPath)
    const B1Filtered = await readB(dbPath, { validYear: 2028 })
    const C1 = await readC(db, dir)
    expect(A1.total).toBe(0)
    expect(B1.total).toBe(1)
    expect(B1.rows[0]).toMatchObject({ enterpriseId: formal.enterprise.id, group: 'eligible' })
    expect(eligibility(B1)).toEqual(eligibility(B0))
    // The validYear witness is gone: the filter hit disappears, the row itself does not.
    expect(B1Filtered.total).toBe(0)
    expect((B1.rows[0] as { matchedValidYears: number[] }).matchedValidYears).toEqual([])
    expect(exportSnapshot(C1)).toEqual(exportSnapshot(C0))
    expect(eligibleIdentities(C1)).toEqual(eligibleIdentities(C0))
    // The only export difference is the existing provenance text citing the archived observation.
    expect(citationColumn(C0)).toContain('工信部已认定企业名单')
    expect(citationColumn(C1)).not.toContain('工信部已认定企业名单')
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
    db.$client.close(); rmSync(dir, { recursive: true, force: true }); vi.unstubAllEnvs()
  }
}, 120_000)

it('adds unconfirmed and title-conflicting directory rows to the directory reader only', async () => {
  const { dir, dbPath, db, matrix } = setup()
  const { server, base } = await startServer()
  try {
    const formal = matrix.formal('未确认目录对照企业', [{ eventType: 'award', year: 2025, decidedYear: 2025, batchSeq: 1 }], { uscc: '91330211FFFF000003' })
    const C0 = await readC(db, dir)
    const B0 = await readB(dbPath)
    expect((await readA(base, { q: '未确认目录对照企业' })).total).toBe(0)
    expect(B0.total).toBe(1)

    // An unconfirmed directory row (no confirmed event_recognized edge) is visible only in A.
    const unconfirmed = seedUnconfirmed(db, formal.enterprise, { id: 'DIR-TRI-3', qymc: formal.enterprise.name, tyshxydm: formal.enterprise.usccNorm, rdjb: '1', rddqrq: '2028-06-01' })
    const A1 = await readA(base, { q: '未确认目录对照企业' })
    const B1 = await readB(dbPath)
    const C1 = await readC(db, dir)
    expect(A1.total).toBe(1)
    expect(A1.rows[0]).toMatchObject({ record: { platformKey: 'DIR-TRI-3' }, conflicts: [] })
    // The assessment records platform observations by design; the qualification decision does not move.
    expect(eligibility(B1)).toEqual(eligibility(B0))
    expect(exportSnapshot(C1)).toEqual(exportSnapshot(C0))
    expect(citationColumn(C0)).not.toContain('工信部已认定企业名单')
    expect(citationColumn(C1)).toContain('工信部已认定企业名单')

    // A row whose raw rdjb contradicts the observed query scope reports a structured conflict; B/C stay identical.
    seedUnconfirmed(db, formal.enterprise, { id: 'DIR-TRI-4', qymc: formal.enterprise.name, tyshxydm: formal.enterprise.usccNorm, rdjb: '3', rddqrq: '2029-01-01' }, '1')
    const A2 = await readA(base, { q: '未确认目录对照企业' })
    const B2 = await readB(dbPath)
    const C2 = await readC(db, dir)
    expect(A2.total).toBe(2)
    const conflicting = A2.rows.find(row => row.kind === 'record' && row.record.platformKey === 'DIR-TRI-4')
    expect(conflicting).toMatchObject({ conflicts: ['title_conflict'], matchedVersion: { titleRaw: '3' }, titleScopes: ['1'] })
    expect(unconfirmed.recordId).not.toBeNull()
    expect(eligibility(B2)).toEqual(eligibility(B0))
    expect(exportSnapshot(C2)).toEqual(exportSnapshot(C0))
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
    db.$client.close(); rmSync(dir, { recursive: true, force: true }); vi.unstubAllEnvs()
  }
}, 120_000)

it('removes only the validYear filter hit when a directory witness disappears, without changing eligibility', async () => {
  const { dir, dbPath, db, matrix } = setup()
  const { server, base } = await startServer()
  try {
    const first = matrix.formal('对照甲企业', [{ eventType: 'award', year: 2025, decidedYear: 2025, batchSeq: 1 }], { uscc: '91330211FFFF000004' })
    const second = matrix.formal('对照乙企业', [{ eventType: 'award', year: 2025, decidedYear: 2025, batchSeq: 1 }], { uscc: '91330211FFFF000005' })
    const raw = (id: string, name: string, uscc: string | null) => ({ id, qymc: name, tyshxydm: uscc, rdjb: '1', rddqrq: '2028-06-01', whpcyear: '2024', whpc: '2024-2', szq: '33020000' })
    seedRecognized(db, first, first.events[0]!.id, raw('DIR-TRI-5', first.enterprise.name, first.enterprise.usccNorm), { rddqrq: '2028' })
    const secondSeeded = seedRecognized(db, second, second.events[0]!.id, raw('DIR-TRI-6', second.enterprise.name, second.enterprise.usccNorm), { rddqrq: '2028' })

    const C0 = await readC(db, dir)
    const B0 = await readB(dbPath)
    const B0Filtered = await readB(dbPath, { validYear: 2028 })
    expect((await readA(base)).total).toBe(2)
    expect(B0.total).toBe(2)
    expect(B0Filtered.total).toBe(2)
    expect(C0.counts.eligible).toBe(2)
    expect(B0Filtered.rows.map(row => row.enterpriseId)).toEqual([first.enterprise.id, second.enterprise.id])

    removeDirectoryArchive(db, secondSeeded.recordId, secondSeeded.relation.id, secondSeeded.query.id)
    const A1 = await readA(base)
    const B1 = await readB(dbPath)
    const B1Filtered = await readB(dbPath, { validYear: 2028 })
    const C1 = await readC(db, dir)
    expect(A1.total).toBe(1)
    // With the filter off, both formal rows stay; deleting a directory witness never drops eligibility.
    expect(B1.total).toBe(2)
    expect(eligibility(B1)).toEqual(eligibility(B0))
    expect(B1.rows.map(row => row.group)).toEqual(['eligible', 'eligible'])
    // With the filter on, only the remaining witness matches.
    expect(B1Filtered.total).toBe(1)
    expect(B1Filtered.rows.map(row => row.enterpriseId)).toEqual([first.enterprise.id])
    // The export decision surface never consumes directory rows; only the provenance text does.
    expect(exportSnapshot(C1)).toEqual(exportSnapshot(C0))
    expect(eligibleIdentities(C1)).toEqual(eligibleIdentities(C0))
    expect((citationColumn(C0).match(/工信部已认定企业名单/g) ?? [])).toHaveLength(2)
    expect((citationColumn(C1).match(/工信部已认定企业名单/g) ?? [])).toHaveLength(1)
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
    db.$client.close(); rmSync(dir, { recursive: true, force: true }); vi.unstubAllEnvs()
  }
}, 120_000)
