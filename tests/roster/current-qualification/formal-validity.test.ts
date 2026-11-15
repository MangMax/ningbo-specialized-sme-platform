import { createRuntimeSchema } from '../../../db/create-runtime'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { eq } from 'drizzle-orm'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ExcelJS from 'exceljs'
import { afterEach, expect, it, vi } from 'vitest'
import * as schema from '../../../db/schema'
import { readCurrentQualificationAssessment } from '../../../lib/roster/current-qualification'
import { listCurrentQualified } from '../../../lib/roster/current-qualified-query'
import { writeCurrentWorkbook } from '../../../lib/roster/current-workbook'
import { reviewCurrentExportDecision } from '../fixtures/qualification-decisions'

const opened: Database.Database[] = []
afterEach(() => { for (const db of opened.splice(0)) db.close(); vi.useRealTimers() })
// Real sample coordinates: Lanfan1834 award7154(2023/batch2); Yayan3420 award1245(null batch)/review4318(2023/batch1/decided2026/passed); Yongchuang574 award574/review3246(2022/null batch/decided2026/passed).
// Owned source IDs and enterprise names are synthetic; unknown exact publication dates stay omitted.
function fixture(kind: 'lanfan' | 'yayan' | 'yongchuang' = 'lanfan') {
  const sqlite = new Database(':memory:'); opened.push(sqlite)
  const db = drizzle(sqlite, { schema }); sqlite.pragma('foreign_keys=ON'); createRuntimeSchema(sqlite)
  const enterprise = db.insert(schema.enterprise).values({ name: kind, nameNorm: kind, usccNorm: '913302000000000001' }).returning().get()
  const title: 'innovative_sme' | 'specialized_sme' = kind === 'lanfan' ? 'innovative_sme' : 'specialized_sme'
  const record = db.insert(schema.record).values({ enterpriseId: enterprise.id, titleCode: title, source: 'jxj', nameRaw: kind, usccRaw: enterprise.usccNorm }).returning().get()
  const award = db.insert(schema.recordEvent).values({ recordId: record.id, eventType: 'award', year: kind === 'yongchuang' ? 2022 : 2023, batchSeq: kind === 'lanfan' ? 2 : null }).returning().get()
  const sha = 'a'.repeat(64), file = db.insert(schema.storedFile).values({ relPath: 'owned/source.pdf', filename: 'source.pdf', ext: 'pdf', bytes: 1, sha256: sha }).returning().get()
  const evidenceFor = (id: number) => db.insert(schema.recordEvidence).values({ recordEventId: id, sourceFile: file.relPath, page: kind === 'lanfan' ? 27 : kind === 'yayan' ? 12 : 6 }).returning().get()
  const evidence = evidenceFor(award.id)
  const review = kind === 'lanfan' ? null : db.insert(schema.recordEvent).values({ recordId: record.id, eventType: 'review', year: award.year, batchSeq: kind === 'yayan' ? 1 : null, decidedYear: 2026, reviewOutcome: 'passed' }).returning().get()
  const reviewEvidence = review ? evidenceFor(review.id) : null
  const fact = kind === 'lanfan' ? { evidenceId: evidence.id, sourceSha256: sha, statementPages: [2], interval: { validFrom: '2023-11-01', validThrough: '2026-10-31' } } : { evidenceId: reviewEvidence!.id, sourceSha256: sha, statementPages: [2], originAwardEventId: award.id, continuation: kind === 'yayan' ? 'until_next_review_results' : 'until_this_review_results' }
  const target = review ?? award
  const install = (value: unknown = fact) => db.$client.prepare('UPDATE record_event SET formal_validity=? WHERE id=?').run(JSON.stringify(value), target.id)
  const read = (day = '2026-10-31', options = {}) => readCurrentQualificationAssessment(sqlite, enterprise.id, Date.parse(day + 'T04:00:00Z'), options as any)
  const selected = (day?: string) => read(day).titles.find(t => t.titleCode === title)!
  const addReview = (outcome: 'passed' | 'failed' | null, year = 2026) => { const e = db.insert(schema.recordEvent).values({ recordId: record.id, eventType: 'review', year: award.year, batchSeq: award.batchSeq, decidedYear: year, reviewOutcome: outcome }).returning().get(); evidenceFor(e.id); return e }
  return { sqlite, db, enterprise, record, award, review, file, title, target, fact, install, read, selected, addReview }
}

it.each(['lanfan', 'yayan', 'yongchuang'] as const)('consumes independent official facts for %s without rewriting original business coordinates', kind => {
  const f = fixture(kind)
  expect(f.selected().group).toBe(kind === 'lanfan' ? 'excluded' : 'eligible')
  f.install()
  expect(f.selected().group).toBe('eligible')
  expect(f.read()).toMatchObject({ ruleVersion: 'current-roster-116-v11', assessmentVersion: 'enterprise-qualification-687-v4' })
  expect(f.db.select().from(schema.recordEvent).where(eq(schema.recordEvent.id, f.award.id)).get()).toMatchObject({ year: kind === 'yongchuang' ? 2022 : 2023, batchSeq: kind === 'lanfan' ? 2 : null })
  expect(f.read('2026-10-31', { assessmentVersion: 'enterprise-qualification-407-v1' }).titles.find(t => t.titleCode === f.title)!.group).toBe('pending')
})

it.each([['2023-10-31', 'excluded'], ['2023-11-01', 'eligible'], ['2026-10-31', 'eligible'], ['2026-11-01', 'excluded']] as const)('uses inclusive official dates on %s', (day, group) => {
  const f = fixture(); f.install(); expect(f.selected(day).group).toBe(group)
})
it('uses Shanghai midnight rather than UTC day and changes the digest with formal facts', () => {
  const f = fixture(); const before = f.selected().versions.facts; f.install()
  expect(f.selected().versions.facts).not.toBe(before)
  const at = (time: string) => readCurrentQualificationAssessment(f.sqlite, f.enterprise.id, Date.parse(time)).titles.find(t => t.titleCode === f.title)!.group
  expect(at('2026-10-31T15:59:59Z')).toBe('eligible')
  expect(at('2026-10-31T16:00:00Z')).toBe('excluded')
})
it.each(['sha', 'removed', 'foreignEvidence'] as const)('does not retain certainty after %s source drift', change => {
  const f = fixture(); const previous = (day='2026-10-31') => f.read(day,{assessmentVersion:'enterprise-qualification-407-v2'}).titles.find(t=>t.titleCode===f.title)!; f.install(); expect(previous().group).toBe('eligible')
  if (change === 'sha') f.db.update(schema.storedFile).set({ sha256: 'b'.repeat(64) }).run()
  if (change === 'removed') f.db.update(schema.storedFile).set({ removedAt: '2026-10-01' }).run()
  if (change === 'foreignEvidence') f.install({ ...f.fact, evidenceId: 999999 })
  expect(previous().group).toBe('pending')
})
it.each(['failed', null] as const)('does not turn review outcome %s into a pass through dates', outcome => {
  const f = fixture('yongchuang'); f.install(); f.db.update(schema.recordEvent).set({ reviewOutcome: outcome }).where(eq(schema.recordEvent.id, f.review!.id)).run()
  expect(f.selected().group).not.toBe('eligible')
})
it('limits the this-result grace to publication and does not promise an indefinite renewal', () => {
  // Explicit synthetic publication day tests the clause boundary; no stamped date is inferred.
  const f = fixture('yongchuang'); f.install({ ...f.fact, publishedOn: '2026-02-27' })
  expect(f.selected('2026-02-26').group).toBe('eligible')
  expect(f.selected('2026-02-27').group).toBe('eligible')
  expect(f.selected('2029-02-28').group).toBe('excluded')
  f.db.update(schema.recordEvent).set({ reviewOutcome: 'failed' }).where(eq(schema.recordEvent.id, f.review!.id)).run()
  expect(f.selected('2026-02-26').group).toBe('eligible')
  expect(f.selected('2026-02-27').group).not.toBe('eligible')
})
it('next-result continuation ends on a later published failure and unknown results stay unresolved', () => {
  const f = fixture('yayan'); const previous = (day='2026-10-31') => f.read(day,{assessmentVersion:'enterprise-qualification-407-v2'}).titles.find(t=>t.titleCode===f.title)!; f.install(); expect(previous('2029-09-01').group).toBe('eligible')
  f.addReview(null, 2029); expect(previous('2029-09-01').group).toBe('pending')
  f.db.update(schema.recordEvent).set({ reviewOutcome: 'failed', batchSeq: 1 }).where(eq(schema.recordEvent.id, f.db.select().from(schema.recordEvent).all().at(-1)!.id)).run()
  expect(previous('2029-09-01').group).not.toBe('eligible')
})
it('keeps an unlinked ambiguous batch and known conflicting batch unresolved', () => {
  const f = fixture('yayan'); const previous=()=>f.read('2026-10-31',{assessmentVersion:'enterprise-qualification-407-v2'}).titles.find(t=>t.titleCode===f.title)!; f.install({ ...f.fact, originAwardEventId: undefined }); expect(previous().group).toBe('pending')
  f.install(); f.db.update(schema.recordEvent).set({ batchSeq: 2 }).where(eq(schema.recordEvent.id, f.award.id)).run(); expect(previous().group).toBe('pending')
})
it('preserves a separate same-year opposite cycle and later failures over interval evidence', () => {
  const f = fixture(); f.install(); f.addReview('failed'); expect(f.selected().group).not.toBe('eligible')
})
it.each(['deregistered', 'moved_out'] as const)('preserves %s priority over an explicit interval', reasonCode => {
  const f = fixture(); f.install()
  const d = f.db.insert(schema.differenceReason).values({ enterpriseId: f.enterprise.id, titleCode: f.title, direction: 'missing_in_miit', status: 'confirmed_reason', reasonCode, verificationStatus: 'confirmed', lifecycleAction: 'replace', basis: 'owned subject proof', effectiveAt: '2026-01-01T00:00:00Z', recordedAt: '2026-01-02T00:00:00Z', measureCode: 'keep_history' }).returning().get()
  reviewCurrentExportDecision(f.db, d)
  expect(f.selected().group).toBe('eligible') // Old difference decisions are notes under v3.
  expect(f.read('2026-10-31',{assessmentVersion:'enterprise-qualification-407-v2'}).titles.find(t=>t.titleCode===f.title)!.group).toBe('excluded')
})
it('current query and exported workbook consume the same default authority at the cutoff', async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-31T04:00:00Z'))
  const f = fixture(); f.install()
  const query = listCurrentQualified(f.sqlite, { titleCode: f.title, q: 'lanfan' })
  expect(query).toMatchObject({ total: 1, rows: [{ enterpriseId: f.enterprise.id, qualificationAssessment: { assessmentVersion: 'enterprise-qualification-687-v4' } }] })
  const filename = join(mkdtempSync(join(tmpdir(), 'validity-workbook-')), 'owned.xlsx')
  const result = await writeCurrentWorkbook(f.sqlite, f.title, filename, () => {})
  expect(result.counts).toEqual({ eligible: 1, pending: 0, excluded: 0 })
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.readFile(filename)
  expect(workbook.getWorksheet('有效企业')!.rowCount).toBe(2)
  expect(JSON.stringify(workbook.getWorksheet('有效企业')!.getRow(2).values)).toContain('lanfan')
})

it('keeps an independent ambiguous award unresolved and lets a later explicit new grant restore qualification', () => {
  const f = fixture('yayan'); const previous = (day='2026-10-31') => f.read(day,{assessmentVersion:'enterprise-qualification-407-v2'}).titles.find(t=>t.titleCode===f.title)!; f.install()
  const other = f.db.insert(schema.recordEvent).values({ recordId: f.record.id, eventType: 'award', year: 2023, batchSeq: 2 }).returning().get()
  f.db.insert(schema.recordEvidence).values({ recordEventId: other.id, sourceFile: f.file.relPath }).run()
  expect(previous().group).toBe('pending')
  const newer = f.db.insert(schema.recordEvent).values({ recordId: f.record.id, eventType: 'award', year: 2025, batchSeq: 2 }).returning().get()
  f.db.insert(schema.recordEvidence).values({ recordEventId: newer.id, sourceFile: f.file.relPath }).run()
  expect(previous().group).toBe('eligible')
})
it('explicit document interval takes priority over a next-result clause', () => {
  const f = fixture(); f.install({ ...f.fact, continuation: 'until_next_review_results' })
  expect(f.selected('2023-10-31').group).toBe('excluded')
  expect(f.selected('2026-11-01').group).toBe('excluded')
  f.addReview('failed', 2027)
  expect(f.selected('2027-11-01').group).not.toBe('eligible')
})
it('keeps legacy snapshot input bytes stable when formal dates are added', () => {
  const f = fixture()
  const before = f.read('2026-10-31', { assessmentVersion: 'enterprise-qualification-407-v1' })
  f.install()
  expect(f.read('2026-10-31', { assessmentVersion: 'enterprise-qualification-407-v1' })).toEqual(before)
  expect(f.read().snapshotId).not.toBe(before.snapshotId)
})


it.each(['passed', 'failed', null] as const)('honors explicit interval over this-result grace before publication of %s', outcome => {
  const f = fixture('yongchuang')
  f.db.update(schema.recordEvent).set({ formalValidity: { evidenceId: f.db.select().from(schema.recordEvidence).all().find(e => e.recordEventId === f.award.id)!.id, sourceSha256: f.file.sha256, statementPages: [2], interval: { validFrom: '2022-03-01', validThrough: '2025-12-31' } } }).where(eq(schema.recordEvent.id, f.award.id)).run()
  f.install({ ...f.fact, publishedOn: '2026-02-27' })
  f.db.update(schema.recordEvent).set({ reviewOutcome: outcome }).where(eq(schema.recordEvent.id, f.review!.id)).run()
  expect(f.selected('2022-02-28').group).toBe('excluded')
  expect(f.selected('2026-02-26').group).toBe('excluded')
  if (outcome === 'passed') expect(f.selected('2026-02-27').group).toBe('eligible')
  else expect(f.selected('2026-02-27').group).not.toBe('eligible')
})

it.each(['enterprise-qualification-407-v1','enterprise-qualification-407-v2'] as const)('freezes explicit %s cutoff with honest metadata', assessmentVersion=>{
 const f=fixture();f.install()
 const result=f.read('2026-11-01',{assessmentVersion})
 expect(result).toMatchObject({assessmentVersion,ruleVersion:assessmentVersion.endsWith('v1')?'current-roster-116-v8':'current-roster-116-v9'})
 expect(result.titles.find(t=>t.titleCode===f.title)!.group).toBe('pending')
 expect(f.selected('2026-11-01').group).toBe('excluded')
})
it.each(['enterprise-qualification-407-v1','enterprise-qualification-407-v2'] as const)('preserves %s future-review and failure/recovery rules',assessmentVersion=>{
 const f=fixture('yayan')
 const old=(day:string)=>f.read(day,{assessmentVersion}).titles.find(t=>t.titleCode===f.title)!
 expect(old('2025-06-01').group).toBe('pending')
 expect(f.selected('2025-06-01').group).toBe('eligible')
 f.addReview('failed',2024)
 expect(old('2026-10-31').group).toBe('pending')
 expect(f.selected().group).toBe('eligible')
})
it('explicit v2 retains interval continuation while v3 gives the interval priority',()=>{
 const f=fixture();f.install({...f.fact,continuation:'until_next_review_results'})
 expect(f.read('2026-11-01',{assessmentVersion:'enterprise-qualification-407-v2'}).titles.find(t=>t.titleCode===f.title)!.group).toBe('eligible')
 expect(f.selected('2026-11-01').group).toBe('excluded')
})
