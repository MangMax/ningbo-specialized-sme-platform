import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { tmpdir } from 'node:os'
import { TITLE_SEED } from '../../../db/titles'
import { normalizeUscc } from '../../../layers/sme-roster/lib/domain'
import { submitNativePlatformQuery } from '../../platform/fixtures/native-query'
import { afterEach, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import * as s from '../../../upgrade/legacy-schema'
import * as nativeSchema from '../../../db/schema'
import { qualificationFileFixture } from '../fixtures/qualification-matrix'
import { readExportWorkbook } from '../../support/read-workbook'
import { ensurePlatformObservation } from '../../../upgrade/frozen/server/platform-business-record'
import { currentCandidateBindings, currentCandidateReadSqlFor } from '../../../upgrade/frozen/current-candidates'
import { prepareCurrentReader } from '../../../lib/roster/current-qualification'
import { listCurrentQualified } from '../../../lib/roster/current-qualified-query'
import { writeCurrentWorkbook } from '../../../lib/roster/current-workbook'
import type { CurrentTitle } from '../../../lib/roster/current-titles'

const fixtures: Array<{ close(): void }> = []
afterEach(() => {
  vi.useRealTimers()
  for (const fixture of fixtures.splice(0)) fixture.close()
})
let historicalTemplate: Buffer | undefined
function offlineHistoricalFixture() {
  // This fixture belongs only to the frozen pre-retirement candidate oracle.
  const dir = mkdtempSync(join(tmpdir(), 'offline-candidate468-'))
  const sqlite = historicalTemplate ? new Database(historicalTemplate) : new Database(':memory:')
  sqlite.pragma('foreign_keys=ON')
  if (!historicalTemplate) {
    migrate(drizzle(sqlite), { migrationsFolder: resolve('db/migrations') })
    historicalTemplate = sqlite.serialize()
  }
  const db = drizzle(sqlite, { schema: s })
  for (const title of TITLE_SEED) db.insert(s.title).values(title).onConflictDoNothing().run()
  sqlite.function('roster84_uscc', { deterministic: true }, normalizeUscc)
  const f = { sqlite, db, close() { sqlite.close(); rmSync(dir, { recursive: true, force: true }) } }
  fixtures.push(f)
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-11-05T04:00:00Z'))
  return f
}
type Fixture = ReturnType<typeof offlineHistoricalFixture>
function enterprise(f: Fixture, id: number) {
  return f.db.insert(s.enterprise).values({ id, name: `候选企业${id}`, nameNorm: `候选企业${id}`, usccNorm: `SYNTHETIC468-${id}`, city: '宁波市', district: '鄞州区' }).returning().get()
}
let serial = 0
function observation(f: Fixture, owner: number | null, archivedUscc: string | null, options: {
  raw?: Record<string, unknown>; relationKey?: string; project?: boolean; interface?: 'recognized_list' | 'business_list' | 'apply_list';
  queryId?: number; sequenceNo?: number; titleCode?: CurrentTitle; rdjb?: string;
} = {}) {
  const id = ++serial
  const titleCode = options.titleCode ?? 'innovative_sme'
  const rdjb = options.rdjb ?? { innovative_sme: '1', specialized_sme: '2', little_giant: '3' }[titleCode]
  const queryId = options.queryId ?? f.db.insert(s.platformQuery).values({
    interface: options.interface ?? 'recognized_list', queryKey: `synthetic468/${id}`, rdjb, titleCode,
    queriedAt: `2026-10-01T00:00:00.${String(id).padStart(3, '0')}Z`, status: 'success',
  }).returning().get().id
  const raw = options.raw ?? { id: `source468-${id}`, tyshxydm: archivedUscc }
  const relation = f.db.insert(s.platformRelation).values({
    queryId, enterpriseId: owner, usccRaw: archivedUscc, nameRaw: 'synthetic468',
    sequenceNo: options.sequenceNo ?? 1, rawFields: raw, relationKey: options.relationKey ?? String(raw.id ?? ''),
    verificationStatus: 'confirmed', matchBasis: 'manual',
  }).returning().get()
  const projection = options.project === false ? null : ensurePlatformObservation(f.db, relation.id)
  return { relation, projection }
}
function candidates(f: Fixture, title: CurrentTitle, source: 'typed' | 'legacy') {
  return f.sqlite.prepare(`select id from (${currentCandidateReadSqlFor(f.sqlite, source)}) order by id`)
    .all(currentCandidateBindings(title))
}

it('candidate migration retains exact archive owners and unprojected null conflicting and unresolved histories', () => {
  const f = offlineHistoricalFixture()
  for (let id = 1; id <= 12; id++) enterprise(f, id)
  const shared = { id: 'shared468', tyshxydm: ' synthetic468-1 ' }
  observation(f, null, 'SYNTHETIC468-1', { raw: shared })
  observation(f, 2, 'SYNTHETIC468-1', { raw: shared })
  observation(f, null, 'SYNTHETIC468-3', { project: false })
  observation(f, null, 'SYNTHETIC468-4', { raw: { id: 'null468', tyshxydm: null } })
  observation(f, null, 'SYNTHETIC468-5', { raw: { id: 'mismatch468', tyshxydm: 'SYNTHETIC468-6' } })
  const conflict = observation(f, null, 'SYNTHETIC468-7', { raw: { id: 'raw-key468', tyshxydm: 'SYNTHETIC468-7' }, relationKey: 'different-key468' })
  const missing = observation(f, null, 'SYNTHETIC468-8', { raw: { tyshxydm: 'SYNTHETIC468-8' } })
  observation(f, null, null, { raw: { id: 'no-archive-identity468', tyshxydm: 'SYNTHETIC468-9' } })
  observation(f, 10, null, { interface: 'business_list' })
  observation(f, 11, null, { interface: 'apply_list' })
  const noProjection = observation(f, null, 'SYNTHETIC468-12')
  f.db.delete(s.platformRecognizedProjection).where(eq(s.platformRecognizedProjection.versionId, noProjection.projection!.versionId!)).run()
  expect(conflict.projection).toMatchObject({ identityState: 'conflict', recordId: null })
  expect(missing.projection).toMatchObject({ identityState: 'missing_key', recordId: null })
  const expected = [1, 2, 3, 4, 5, 7, 8, 10, 11, 12].map(id => ({ id }))
  expect(candidates(f, 'innovative_sme', 'typed')).toEqual(expected)
  expect(candidates(f, 'innovative_sme', 'legacy')).toEqual(expected)
  expect(candidates(f, 'specialized_sme', 'typed')).toEqual([])
})

it('candidate migration retains page scoped titles and unknown scope without using the row title', () => {
  const f = offlineHistoricalFixture()
  for (let id = 1; id <= 3; id++) enterprise(f, id)
  const query = f.db.insert(s.platformQuery).values({ interface: 'recognized_list', queryKey: 'multi468', rdjb: '1,2,3', queriedAt: '2026-10-01T00:00:00Z', status: 'success' }).returning().get()
  f.sqlite.prepare('update platform_query set collection_evidence=? where id=?').run(JSON.stringify({ pages: [
    { status: 'failed', rdjb: '1', fetchedCount: 99 },
    { status: 'success', rdjb: '2', fetchedCount: 1 },
    { status: 'success', rdjb: '3', fetchedCount: 1 },
  ] }), query.id)
  for (let id = 1; id <= 3; id++) observation(f, null, `SYNTHETIC468-${id}`, {
    queryId: query.id, sequenceNo: id, raw: { id: `multi468-${id}`, tyshxydm: `SYNTHETIC468-${id}`, rdjb: '1' },
  })
  for (const [title, expected] of [
    ['innovative_sme', [3]], ['specialized_sme', [1, 3]], ['little_giant', [2, 3]],
  ] as const) {
    expect(candidates(f, title, 'typed')).toEqual(expected.map(id => ({ id })))
    expect(candidates(f, title, 'typed')).toEqual(candidates(f, title, 'legacy'))
  }
})

it.each(['innovative_sme', 'specialized_sme', 'little_giant'] as const)('candidate migration preserves all four candidate sources and duplicate elimination with missing indexes for %s', title => {
  const f = offlineHistoricalFixture()
  expect(candidates(f, title, 'typed')).toEqual([])
  const formal = {enterprise:enterprise(f, 1)}
  f.db.insert(s.record).values({enterpriseId:1,titleCode:title,source:'jxj'}).run()
  enterprise(f, 2)
  enterprise(f, 3)
  enterprise(f, 4)
  f.db.insert(s.differenceReason).values({ enterpriseId: 2, titleCode: title, direction: 'missing_in_miit', status: 'needs_review', recordedAt: '2026-10-01T00:00:00Z' }).run()
  f.db.insert(s.recordCorrespondence).values({edgeKey:'offline-candidate468',type:'later_process',role:'followup_review',enterpriseId:3,titleCode:title,status:'candidate',revision:1,targetIdentity:{},provenance:{},sourceFingerprint:'offline-candidate468',ruleId:'historical-oracle',ruleVersion:'1',createdAt:'2026-10-01'}).run()
  observation(f, 4, null, { titleCode: title })
  observation(f, formal.enterprise.id, null, { titleCode: title })
  for (const covered of [true, false]) {
    if (!covered) f.sqlite.exec('drop index platform_relation_current_candidate_cover_idx; drop index platform_query_current_candidate_cover_idx')
    expect(candidates(f, title, 'typed')).toEqual([1, 2, 3, 4].map(id => ({ id })))
    expect(candidates(f, title, 'typed')).toEqual(candidates(f, title, 'legacy'))
  }
})

it.each(['innovative_sme', 'specialized_sme', 'little_giant'] as const)('native qualified query and parsed workbook preserve platform-only candidates for %s', async title => {
  const f = qualificationFileFixture()
  fixtures.push(f)
  prepareCurrentReader(f.sqlite)
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-11-05T04:00:00Z'))
  const formal = f.formal('正式候选', [{ eventType: 'award', year: 2026, decidedYear: 2026, batchSeq: 1 }], { title })
  const rdjb = { innovative_sme: '1', specialized_sme: '2', little_giant: '3' }[title]
  for (const id of [20, 21, 22]) {
    const name = '候选企业' + id
    const enterprise = f.db.insert(nativeSchema.enterprise).values({ id, name, nameNorm: name, usccNorm: 'SYNTHETIC468-' + id }).returning().get()
    const stamp = '2026-10-01T00:00:00Z'
    const rawFields = { id: 'native468-' + id, qymc: name, tyshxydm: enterprise.usccNorm!, rdjb }
    const collectionEvidence = {
      source: 'queryBusList' as const, status: 'success' as const,
      effectiveConditions: { combination: 'and' as const, name },
      titleScope: { mode: 'selected' as const, rdjb: [rdjb] },
      queriedAt: stamp, completedAt: stamp, rows: [rawFields],
      pages: [{ source: 'queryBusList' as const, rdjb, page: 1, status: 'success' as const, fetchedCount: 1, declaredTotal: 1, maxPage: 1, error: null }],
      fetchedCount: 1, declaredTotal: 1, completeness: 'complete' as const, fullRange: true, unfinished: [], error: null,
      limits: { maxRequests: 1, maxRows: 50, maxDurationMs: 1000, pageSize: 50 },
    }
    submitNativePlatformQuery(f.db, {
      interface: 'recognized_list', queryKey: 'name:' + name, titleCode: title, rdjb, queriedAt: stamp, status: 'success', collectionEvidence,
      relations: [{ sequenceNo: 1, relationKey: rawFields.id, enterpriseId: id === 20 ? null : id, nameRaw: name, usccRaw: rawFields.tyshxydm, rawFields, verificationStatus: 'confirmed', matchBasis: 'uscc' }],
    })
  }
  expect(listCurrentQualified(f.sqlite, { titleCode: title, page: 1, pageSize: 1 })).toMatchObject({ total: 1, rows: [{ enterpriseId: formal.enterprise.id }] })
  const path = join(f.sqlite.name, '..', 'candidate468-' + title + '.xlsx')
  const summary = await writeCurrentWorkbook(f.sqlite, title, path, () => {})
  const workbook = await readExportWorkbook(readFileSync(path))
  const names = workbook.worksheets.filter(sheet => sheet.name !== '口径说明').flatMap(sheet => (sheet.getRows(2, sheet.rowCount - 1) ?? []).map(row => row.getCell(2).value))
  expect(summary).toMatchObject({ total: 4, counts: { eligible: 1, pending: 0, excluded: 3 } })
  expect(names).toEqual(['正式候选', '候选企业20', '候选企业21', '候选企业22'])
})
