import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import * as s from '../db/schema'
import { fileMatrix408, refLiterals408 } from './helpers/current-qualified-408'
import { readExportWorkbook } from './helpers/read-export-workbook'
import { ensurePlatformObservation } from '../server/utils/platform-business-record'
import { currentCandidateBindings, currentCandidateReadSqlFor, currentCandidateSqlFor } from '../lib/roster/current-candidates'
import { prepareCurrentReader } from '../lib/roster/current-qualification'
import { listCurrentQualified } from '../lib/roster/current-qualified-query'
import { writeCurrentWorkbook } from '../lib/roster/current-workbook'
import type { CurrentTitle } from '../lib/roster/current-titles'

const fixtures: ReturnType<typeof fileMatrix408>[] = []
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  for (const fixture of fixtures.splice(0)) fixture.close()
})
function setup() {
  const f = fileMatrix408()
  fixtures.push(f)
  prepareCurrentReader(f.sqlite)
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-11-05T04:00:00Z'))
  return f
}
type Fixture = ReturnType<typeof setup>
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
  const f = setup()
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
  const f = setup()
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

it('candidate source rollback is explicit and environment driven and works without projection tables', () => {
  const f = setup()
  enterprise(f, 1)
  observation(f, null, 'SYNTHETIC468-1', { project: false })
  f.sqlite.exec('drop table platform_recognized_projection')
  expect(currentCandidateReadSqlFor(f.sqlite, 'legacy')).toBe(currentCandidateSqlFor(f.sqlite))
  expect(candidates(f, 'innovative_sme', 'legacy')).toEqual([{ id: 1 }])
  vi.stubEnv('ROSTER_RECOGNIZED_FILTER_SOURCE', 'legacy')
  expect(f.sqlite.prepare(currentCandidateReadSqlFor(f.sqlite)).all(currentCandidateBindings('innovative_sme'))).toEqual([{ id: 1 }])
})

it.each(['innovative_sme', 'specialized_sme', 'little_giant'] as const)('candidate migration preserves all four candidate sources and duplicate elimination with missing indexes for %s', title => {
  const f = setup()
  expect(candidates(f, title, 'typed')).toEqual([])
  const formal = f.formal('名录候选', undefined, { title })
  enterprise(f, 2)
  enterprise(f, 3)
  enterprise(f, 4)
  f.db.insert(s.differenceReason).values({ enterpriseId: 2, titleCode: title, direction: 'missing_in_miit', status: 'needs_review', recordedAt: '2026-10-01T00:00:00Z' }).run()
  refLiterals408(f.sqlite).legacyRef(`candidate468-${title}`, 'candidate', 3, title)
  observation(f, 4, null, { titleCode: title })
  observation(f, formal.enterprise.id, null, { titleCode: title })
  for (const covered of [true, false]) {
    if (!covered) f.sqlite.exec('drop index platform_relation_current_candidate_cover_idx; drop index platform_query_current_candidate_cover_idx')
    expect(candidates(f, title, 'typed')).toEqual([1, 2, 3, 4].map(id => ({ id })))
    expect(candidates(f, title, 'typed')).toEqual(candidates(f, title, 'legacy'))
  }
})

it.each(['innovative_sme', 'specialized_sme', 'little_giant'] as const)('qualified query and parsed workbook preserve platform-only candidates and rollback for %s', async title => {
  const f = setup()
  const formal = f.formal('正式候选', [{ eventType: 'award', year: 2026, decidedYear: 2026, batchSeq: 1 }], { title })
  for (const id of [20, 21, 22]) enterprise(f, id)
  observation(f, null, 'SYNTHETIC468-20', { titleCode: title })
  observation(f, 21, null, { titleCode: title, project: false })
  observation(f, null, 'SYNTHETIC468-22', { titleCode: title, raw: { id: `null-workbook468-${title}`, tyshxydm: null } })
  expect(candidates(f, title, 'typed')).toEqual([formal.enterprise.id, 20, 21, 22].map(id => ({ id })))
  const typed = listCurrentQualified(f.sqlite, { titleCode: title, page: 1, pageSize: 1 })
  const legacy = listCurrentQualified(f.sqlite, { titleCode: title, page: 1, pageSize: 1 }, { recognizedFactSource: 'legacy' })
  expect(typed).toEqual(legacy)
  expect(typed).toMatchObject({ total: 1, rows: [{ enterpriseId: formal.enterprise.id }] })
  const dir = join(f.sqlite.name, '..')
  const read = async (source?: 'typed' | 'legacy') => {
    const path = join(dir, `candidate468-${title}-${serial++}.xlsx`)
    const summary = await writeCurrentWorkbook(f.sqlite, title, path, () => {}, undefined, undefined, { recognizedFactSource: source })
    const workbook = await readExportWorkbook(readFileSync(path))
    const sheets = workbook.worksheets.map(sheet => ({ name: sheet.name, rows: (sheet.getRows(1, sheet.rowCount) ?? []).map(row => (row.values as unknown[]).slice(1)) }))
    return { total: summary.total, counts: summary.counts, sheets }
  }
  const workbook = await read()
  expect(workbook.total).toBe(4)
  expect(workbook.counts.eligible).toBe(1)
  const names = workbook.sheets.filter(sheet => sheet.name !== '口径说明').flatMap(sheet => sheet.rows.slice(1).map(row => row[1]))
  expect(names).toEqual(['正式候选', '候选企业20', '候选企业21', '候选企业22'])
  expect(names).toHaveLength(4)
  expect(await read('legacy')).toEqual(workbook)
  vi.stubEnv('ROSTER_RECOGNIZED_FILTER_SOURCE', 'legacy')
  expect(listCurrentQualified(f.sqlite, { titleCode: title, page: 1, pageSize: 1 })).toEqual(legacy)
  expect(await read()).toEqual(workbook)
})
