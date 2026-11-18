import { createRuntimeSchema } from '../../../db/create-runtime'
/** #407 parent-frozen contract tests. UNRUN at authoring: no production implementation.
 * HTTP uses the real public handler and existing in-process executor injection;
 * it does not prove native worker, Nitro middleware or real MCP SDK behavior.
 */
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as schema from '../../../db/schema'
import type { RosterImportEvent, RosterImportRequest } from '../../../lib/roster-import-client'
import * as qualification from '../../../lib/roster/current-qualification'
import { getRosterEnterpriseDetail } from '../../../layers/sme-roster/lib/roster/enterprise-roster'
import { handleRosterImportRequest } from '../../../server/utils/roster-import-http'
import { commitRosterImport, preflightRosterImport } from '../../../server/utils/roster-import'
import { readImportReceipt } from '../../../server/utils/import-receipts'
import { startHttpFixture, type HttpFixture } from '../../support/http'

const NOW = Date.parse('2026-01-15T00:00:00.000Z')
const TOKEN = 'synthetic-407-import-token'
let sqlite: Database.Database
let db: ReturnType<typeof drizzle<typeof schema>>
let api: HttpFixture | undefined
let dir: string

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  dir = mkdtempSync(join(tmpdir(), 'qualification-import-407-'))
  sqlite = new Database(':memory:')
  sqlite.pragma('foreign_keys=ON')
  db = drizzle(sqlite, { schema })
  createRuntimeSchema(sqlite)
  // No new HTTP framework: only the route map for the existing shared fixture.
  api = await startHttpFixture({
    routes: Object.fromEntries((['preflight', 'commit'] as const).map(action => [
      `/api/roster/import/${action}`,
      (request: { method: string; headers: Record<string, string | undefined>; body: unknown }) => handleRosterImportRequest(action, request, {
        db, apiToken: TOKEN,
        executeImport: async (source, phase, body, errors, context, options) => phase === 'preflight'
          ? preflightRosterImport(source, body, errors, { ...context, ...options })
          : commitRosterImport(source, body, errors, { ...context, ...options, deferCandidateTasks: true }),
      }),
    ])),
    getRoutes: {
      '/api/roster/import/receipts/items': request => ({ status: 200, body: readImportReceipt(db, 'items', request.query) }),
      '/api/roster/import/receipts': request => ({ status: 200, body: readImportReceipt(db, 'get', request.query) }),
      '/api/roster/enterprises/1': () => ({ status: 200, body: getRosterEnterpriseDetail(db, 1, NOW) }),
    },
  })
})
afterEach(async () => {
  try { await api?.close() } finally {
    api = undefined
    vi.restoreAllMocks()
    vi.useRealTimers()
    sqlite?.close()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

function request(events: RosterImportEvent[], names = ['合成附件甲']): RosterImportRequest {
  return { idempotencyKey: '407-import-literal', sourceKind: 'announcement', sourceIdentity: 'synthetic/notice-407',
    payload: { announcement: {
      sourceDocument: { source: 'jxj', title: '2025年新认定第二批及2022年企业复核通过名单' },
      records: names.map(name => ({ enterprise: { name }, source: 'jxj', titleCode: 'innovative_sme', events })),
    } } }
}
const award: RosterImportEvent = { eventType: 'award', year: 2025, decidedYear: 2025, batchSeq: 2,
  evidence: [{ sourceFile: 'synthetic/notice.txt', attachment: '附件1', listNo: 1 }] }
const review: RosterImportEvent = { eventType: 'review', year: 2022, decidedYear: 2025, batchSeq: 1, reviewOutcome: 'passed',
  evidence: [{ sourceFile: 'synthetic/notice.txt', attachment: '附件2', listNo: 1 }] }
async function post(action: 'preflight' | 'commit', body: RosterImportRequest, authorized = true) {
  const response = await fetch(`${api!.baseUrl}/api/roster/import/${action}`, { method: 'POST',
    headers: { 'content-type': 'application/json', ...(authorized ? { authorization: `Bearer ${TOKEN}` } : {}) }, body: JSON.stringify(body) })
  return { status: response.status, body: await response.json() as any }
}
async function get(path: string) {
  const response = await fetch(api!.baseUrl + path)
  return { status: response.status, body: await response.json() as any }
}
function expectCompleteSnapshot(snapshot: any, enterpriseId: number) {
  expect(snapshot).toMatchObject({ enterpriseId, asOf: '2026-01-15T00:00:00.000Z',
    ruleVersion: 'current-roster-116-v8', assessmentVersion: 'enterprise-qualification-407-v1' })
  expect(snapshot.titles.map((t: any) => t.titleCode).sort()).toEqual(['innovative_sme', 'little_giant', 'specialized_sme'])
  const { snapshotId, titles, ...scope } = snapshot
  expect(snapshotId).toBe(createHash('sha256').update(JSON.stringify([scope, titles])).digest('hex'))
}
function counts() {
  return { enterprises: db.select().from(schema.enterprise).all().length,
    events: db.select().from(schema.recordEvent).all().length,
    evidence: db.select().from(schema.recordEvidence).all().length }
}

it('new_target_preflight_separates_candidate_from_current', async () => {
  const before = counts()
  const result = await post('preflight', request([{ ...review, batchSeq: null, decidedYear: null, reviewOutcome: null }]))
  expect(result.status).toBe(200)
  expect(result.body.status).toBe('preflight')
  expect(counts()).toEqual(before) // import_batch/import_receipt are deliberately not business facts.
  expect(result.body.preflight.qualificationDiagnostics).toEqual([expect.objectContaining({
    ref: 'record:0#0', eventType: 'review', values: { year: 2022, decidedYear: null, batchSeq: null, reviewOutcome: null },
    fieldGaps: expect.arrayContaining(['decidedYear', 'batchSeq', 'reviewOutcome'].map(field => expect.objectContaining({ field, valueState: 'unknown' }))),
  })])
  expect(result.body.preflight.qualificationReadback).toEqual({ stage: 'before', status: 'not_retained', reason: 'new_target', target: null })
  expect(result.body.preflight.qualificationReadback).not.toHaveProperty('assessment')
})

it('attachment1_commit_receipt_and_detail_share_full_snapshot', async () => {
  const body = request([award])
  await post('preflight', body)
  const spy = vi.spyOn(qualification, 'readCurrentQualificationAssessment')
  const result = await post('commit', body)
  expect(result.status).toBe(200)
  expect(result.body.status).toBe('committed')
  expect(spy).toHaveBeenCalledTimes(1)
  const capture = result.body.qualificationReadback
  expect(capture).toMatchObject({ stage: 'after', status: 'captured', target: { enterpriseId: 1 } })
  expectCompleteSnapshot(capture.assessment, 1)
  const title = capture.assessment.titles.find((t: any) => t.titleCode === 'innovative_sme')
  expect(title).toMatchObject({ group: 'eligible', evidence: [{ eventType: 'award', year: 2025, decidedYear: 2025, batchSeq: 2, reviewOutcome: null }] })
  const detail = await get('/api/roster/enterprises/1')
  expect(detail.status).toBe(200)
  expect(qualification.readCurrentQualificationAssessment(db.$client, 1, NOW, { assessmentVersion: 'enterprise-qualification-407-v1' })).toEqual(capture.assessment)
  expect(detail.body.qualificationAssessment).toEqual(qualification.readCurrentQualificationAssessment(db.$client, 1, NOW))
  const metadata = await get(`/api/roster/import/receipts?batchId=${result.body.batchId}`)
  expect(metadata.status).toBe(200)
  expect(metadata.body.receiptId).toBeGreaterThan(0)
  const itemIndex = result.body.items.findIndex((item: any) => item.kind === 'record_event')
  expect(itemIndex).toBeGreaterThanOrEqual(0)
  const historical = await get(`/api/roster/import/receipts/items?projection=qualification&source=redacted_receipt&receiptId=${metadata.body.receiptId}&itemIndex=${itemIndex}&maxBytes=65536`)
  expect(historical.status).toBe(200)
  expect(historical.body).toMatchObject({ batchId: result.body.batchId, receiptId: metadata.body.receiptId, itemIndex,
    target: { enterpriseId: 1 }, qualificationReadback: capture })
})

it.each([
  { caseId: 'review_no_origin', event: { ...review, year: null }, field: 'year' },
  { caseId: 'review_no_decision', event: { ...review, decidedYear: null }, field: 'decidedYear' },
  { caseId: 'review_no_outcome', event: { ...review, reviewOutcome: null }, field: 'reviewOutcome' },
  { caseId: 'review_no_batch', event: { ...review, batchSeq: null }, field: 'batchSeq' },
])('$caseId', async ({ event, field }) => {
  const body = request([event])
  const plan = await post('preflight', body)
  expect(plan.status).toBe(200)
  expect(plan.body.preflight.qualificationDiagnostics[0].fieldGaps).toContainEqual(expect.objectContaining({ field, valueState: 'unknown' }))
  const result = await post('commit', body)
  expect(result.body.status).toBe('committed')
  const assessment = result.body.qualificationReadback.assessment.titles.find((t: any) => t.titleCode === 'innovative_sme')
  expect(assessment.group).toBe('pending')
  expect(assessment.evidence[0][field]).toBeNull()
  expect(assessment.completeness.fieldGaps).toContainEqual(expect.objectContaining({ eventId: assessment.evidence[0].eventId, field }))
})

it('attachment2_review_never_borrows_new_notice_batch', async () => {
  const body = request([{ eventType: 'award', year: 2022, decidedYear: 2022, batchSeq: 1,
    evidence: [{ sourceFile: 'synthetic/original-2022.txt', attachment: '原认定第一批', listNo: 1 }] }, review])
  await post('preflight', body)
  const spy = vi.spyOn(qualification, 'readCurrentQualificationAssessment')
  const result = await post('commit', body)
  expect(result.status).toBe(200)
  expect(result.body.status).toBe('committed')
  expectCompleteSnapshot(result.body.qualificationReadback.assessment, 1)
  expect(spy).toHaveBeenCalledTimes(1) // Two events, still one enterprise and one complete snapshot.
  const title = result.body.qualificationReadback.assessment.titles.find((t: any) => t.titleCode === 'innovative_sme')
  expect(title).toMatchObject({ group: 'eligible', cycles: [{ originYear: 2022, batchSeq: 1, precision: 'year' }] })
  expect(title.evidence).toContainEqual(expect.objectContaining({ eventType: 'review', year: 2022, decidedYear: 2025, batchSeq: 1, reviewOutcome: 'passed' }))
})

it.each([
  { caseId: 'award_null_decision_uses_existing_year', event: { ...award, decidedYear: null }, group: 'eligible' },
  { caseId: 'award_null_batch_is_not_review_failure', event: { ...award, batchSeq: null }, group: 'eligible' },
  { caseId: 'nurture_has_no_review_requirements', event: { eventType: 'nurture', year: 2025 } as RosterImportEvent, group: 'excluded' },
  { caseId: 'maintain_has_no_review_requirements', event: { eventType: 'maintain', year: 2025 } as RosterImportEvent, group: 'pending' },
])('$caseId', async ({ event, group }) => {
  const result = await post('commit', request([event]))
  expect(result.body.status).toBe('committed')
  const title = result.body.qualificationReadback.assessment.titles.find((t: any) => t.titleCode === 'innovative_sme')
  expect(title.group).toBe(group)
  if (event.eventType === 'nurture' || event.eventType === 'maintain') {
    expect(title.completeness.fieldGaps.filter((gap: any) => ['reviewOutcome', 'decidedYear', 'batchSeq'].includes(gap.field))).toEqual([])
  } else expect(title.evidence[0]).toMatchObject({ decidedYear: event.decidedYear ?? null, batchSeq: event.batchSeq ?? null })
})

it('omitted_legacy_fields_remain_accepted_with_explicit_gaps', async () => {
  const result = await post('commit', request([{ eventType: 'review', year: 2022 }]))
  expect(result.body.status).toBe('committed')
  expect(result.body.summary.failed).toBe(0)
  const title = result.body.qualificationReadback.assessment.titles.find((t: any) => t.titleCode === 'innovative_sme')
  expect(title.evidence[0]).toMatchObject({ year: 2022, decidedYear: null, batchSeq: null, reviewOutcome: null })
  expect(title.completeness.fieldGaps.map((gap: any) => gap.field)).toEqual(expect.arrayContaining(['decidedYear', 'batchSeq', 'reviewOutcome']))
})

it('multiple_enterprises_commit_without_selecting_first_or_reading_T2', async () => {
  const spy = vi.spyOn(qualification, 'readCurrentQualificationAssessment')
  const result = await post('commit', request([award], ['合成附件甲', '合成附件乙']))
  expect(result.body.status).toBe('committed')
  expect(spy).not.toHaveBeenCalled()
  expect(result.body.qualificationReadback).toEqual({ stage: 'after', status: 'not_retained', reason: 'multiple_targets', target: null, enterpriseIds: [1, 2] })
  expect(counts()).toEqual({ enterprises: 2, events: 2, evidence: 2 })
})

it('replay_preserves_original_capture_asof_versions_and_reads_zero_times', async () => {
  const body = request([award])
  const first = await post('commit', body)
  expect(first.status).toBe(200)
  expect(first.body.status).toBe('committed')
  expect(first.body.qualificationReadback.status).toBe('captured')
  expectCompleteSnapshot(first.body.qualificationReadback.assessment, 1)
  vi.setSystemTime(Date.parse('2027-01-15T00:00:00Z'))
  // Independent competing fact changes only current detail, not the retained historical receipt.
  db.insert(schema.recordEvent).values({ recordId: 1, eventType: 'review', year: 2025, decidedYear: 2026, batchSeq: 2, reviewOutcome: 'failed' }).run()
  const current = getRosterEnterpriseDetail(db, 1, Date.now())!.qualificationAssessment
  expect(current.snapshotId).not.toBe(first.body.qualificationReadback.assessment.snapshotId)
  const spy = vi.spyOn(qualification, 'readCurrentQualificationAssessment')
  const replay = await post('commit', body)
  expect(replay.status).toBe(200)
  expect(replay.body.status).toBe('committed')
  expect(replay.body.qualificationReadback).toEqual(first.body.qualificationReadback)
  expect(spy).not.toHaveBeenCalled()
  expect(counts().events).toBe(2)
})

it('invalid_unknown_outcome_fails_atomically_without_success_after', async () => {
  const spy = vi.spyOn(qualification, 'readCurrentQualificationAssessment')
  const result = await post('commit', request([award, { ...review, reviewOutcome: 'unknown' } as unknown as RosterImportEvent]))
  expect(result.body.status).toBe('failed')
  expect(result.body.items).toContainEqual(expect.objectContaining({ ok: false, error: expect.objectContaining({ code: 'review_outcome_unknown' }) }))
  expect(result.body.qualificationReadback?.status).not.toBe('captured')
  expect(spy).not.toHaveBeenCalled()
  expect(counts()).toEqual({ enterprises: 0, events: 0, evidence: 0 })
})

it('legacy_receipt_projection_reports_not_retained_without_live_T2', async () => {
  const batch = db.insert(schema.importBatch).values({ idempotencyKey: 'legacy-407', sourceKind: 'announcement', sourceIdentity: 'synthetic/legacy', status: 'committed',
    summary: { written: 1, skipped: 0, failed: 0, evidenceRepointed: 0 }, itemResults: [{ ok: true, kind: 'record_event', ref: 'record:9', detail: { enterpriseId: 9 } }] }).returning().get()
  const spy = vi.spyOn(qualification, 'readCurrentQualificationAssessment')
  const result = await get(`/api/roster/import/receipts/items?projection=qualification&source=private_batch&batchId=${batch.id}&itemIndex=0&maxBytes=65536`)
  expect(result.status).toBe(200)
  expect(result.body).toMatchObject({ batchId: batch.id, itemIndex: 0, qualificationReadback: { stage: 'after', status: 'not_retained', reason: 'legacy_receipt', target: null } })
  expect(spy).not.toHaveBeenCalled()
})

it('unauthorized_submission_writes_no_business_or_receipt', async () => {
  const result = await post('commit', request([award]), false)
  expect(result.status).toBe(401)
  expect(counts()).toEqual({ enterprises: 0, events: 0, evidence: 0 })
  expect(db.select().from(schema.importReceipt).all()).toEqual([])
})

it('existing_target_preflight_reports_current_T2_separately_from_proposed_review', async () => {
  const first = await post('commit', request([award]))
  expect(first.body.status).toBe('committed')
  const before = qualification.readCurrentQualificationAssessment(db.$client, 1, NOW, { assessmentVersion: 'enterprise-qualification-407-v1' })
  const body = request([{ ...review, batchSeq: null }])
  body.idempotencyKey = '407-proposed-review'
  const spy = vi.spyOn(qualification, 'readCurrentQualificationAssessment')
  const plan = await post('preflight', body)
  expect(plan.status).toBe(200)
  expect(plan.body.preflight.qualificationReadback).toEqual({ stage: 'before', status: 'captured', target: { enterpriseId: 1 }, assessment: before })
  expect(plan.body.preflight.qualificationDiagnostics).toContainEqual(expect.objectContaining({ ref: 'record:0#0', eventType: 'review',
    values: { year: 2022, decidedYear: 2025, batchSeq: null, reviewOutcome: 'passed' } }))
  expect(spy).toHaveBeenCalledTimes(1)
  expect(counts().events).toBe(1)
})

it('qualification_projection_rejects_wrong_item_and_budget_without_changing_old_default', async () => {
  const result = await post('commit', request([award]))
  expect(result.body.status).toBe('committed')
  const before = counts()
  const defaultRead = await get(`/api/roster/import/receipts/items?batchId=${result.body.batchId}&pageSize=1`)
  expect(defaultRead.status).toBe(200)
  expect(defaultRead.body.rows).toHaveLength(1)
  expect(defaultRead.body.rows[0]).not.toHaveProperty('detail')
  const wrong = await get(`/api/roster/import/receipts/items?projection=qualification&source=private_batch&batchId=${result.body.batchId}&itemIndex=999&maxBytes=65536`)
  expect(wrong.status).toBe(404)
  const index = result.body.items.findIndex((item: any) => item.kind === 'record_event')
  expect(index).toBeGreaterThanOrEqual(0)
  const small = await get(`/api/roster/import/receipts/items?projection=qualification&source=private_batch&batchId=${result.body.batchId}&itemIndex=${index}&maxBytes=1`)
  expect(small.status).toBe(413)
  expect(small.body).not.toHaveProperty('qualificationReadback.assessment')
  expect(counts()).toEqual(before)
})

// #407 historical candidate diagnostics controls. Original19 above remain byte-frozen.
import { eq as historicalEq } from 'drizzle-orm'
import { ImportReceiptError as HistoricalReceiptError } from '../../../server/utils/import-receipts'

function historicalObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Synthetic historical fixture requires an object')
  return value as Record<string, unknown>
}
async function historicalSubmit(body: unknown) {
  // Raw candidate primitives are intentional protocol data; no cast into a typed event.
  const response = await fetch(api!.baseUrl + '/api/roster/import/commit', { method: 'POST', headers: {
    'content-type': 'application/json', authorization: `Bearer ${TOKEN}`,
  }, body: JSON.stringify(body) })
  return { status: response.status, body: historicalObject(await response.json()) }
}
function historicalItemIndex(body: unknown, recordId: number) {
  const items = historicalObject(body).items
  if (!Array.isArray(items)) throw new Error('Synthetic commit requires item results')
  const index = items.findIndex(value => {
    const item = historicalObject(value)
    return item.ok === true && item.kind === 'record_event' && historicalObject(item.detail).recordId === recordId
  })
  expect(index).toBeGreaterThanOrEqual(0)
  return index
}
function historicalProjection(batchId: number, itemIndex: number, receiptId?: number, maxBytes = 65536) {
  const source = receiptId === undefined ? `source=private_batch&batchId=${batchId}` : `source=redacted_receipt&receiptId=${receiptId}`
  return get(`/api/roster/import/receipts/items?projection=qualification&${source}&itemIndex=${itemIndex}&maxBytes=${maxBytes}`)
}

it('history_diagnostics_keep_original_candidates_and_exact_item_mapping', async () => {
  const seed = await post('commit', request([award]))
  expect(seed.status).toBe(200)
  expect(seed.body.status).toBe('committed')
  const body = { ...request([]), idempotencyKey: '407-history-two-records', payload: { announcement: {
    sourceDocument: { source: 'jxj', title: '合成历史诊断双称号' }, records: [
      { enterprise: { name: '合成附件甲' }, source: 'jxj', titleCode: 'innovative_sme', events: [
        { eventType: 'review', year: 2022, decidedYear: null, batchSeq: 1, reviewOutcome: 'passed' },
        { eventType: 'review', year: 2023, batchSeq: 1, reviewOutcome: 'passed' },
      ] },
      { enterprise: { name: '合成附件甲' }, source: 'jxj', titleCode: 'specialized_sme', events: [
        { eventType: 'award', year: 2021, decidedYear: 2021, batchSeq: 1 },
        { eventType: 'review', year: 2024, decidedYear: '  ', batchSeq: null },
      ] },
    ],
  } } }
  const result = await historicalSubmit(body)
  expect(result.status).toBe(200)
  expect(result.body.status).toBe('committed')
  expect(result.body.summary).not.toHaveProperty('qualificationDiagnosticsByItem')
  const innovative = db.select().from(schema.record).where(historicalEq(schema.record.titleCode, 'innovative_sme')).get()
  const specialized = db.select().from(schema.record).where(historicalEq(schema.record.titleCode, 'specialized_sme')).get()
  if (!innovative || !specialized) throw new Error('Both synthetic title records must exist')
  expect(innovative.enterpriseId).toBe(specialized.enterpriseId)
  const firstIndex = historicalItemIndex(result.body, innovative.id), secondIndex = historicalItemIndex(result.body, specialized.id)
  expect(firstIndex).not.toBe(secondIndex)
  const batchId = result.body.batchId
  if (typeof batchId !== 'number') throw new Error('Synthetic batch ID required')
  const beforeInitialReads = counts(), initialReadSpy = vi.spyOn(qualification, 'readCurrentQualificationAssessment')
  const metadata = await get(`/api/roster/import/receipts?batchId=${batchId}`)
  expect(metadata.status).toBe(200)
  const receiptId = metadata.body.receiptId
  expect(receiptId).toBeGreaterThan(0)
  const expectedFirst = { status: 'captured', items: [
    { ref: 'record:0#0', eventType: 'review', values: { year: 2022, decidedYear: null, batchSeq: 1, reviewOutcome: 'passed' }, fieldGaps: [{ field: 'decidedYear', valueState: 'unknown', inputState: 'null' }] },
    { ref: 'record:0#1', eventType: 'review', values: { year: 2023, decidedYear: null, batchSeq: 1, reviewOutcome: 'passed' }, fieldGaps: [{ field: 'decidedYear', valueState: 'unknown', inputState: 'omitted' }] },
  ] }
  const expectedSecond = { status: 'captured', items: [
    { ref: 'record:1#0', eventType: 'award', values: { year: 2021, decidedYear: 2021, batchSeq: 1, reviewOutcome: null }, fieldGaps: [] },
    { ref: 'record:1#1', eventType: 'review', values: { year: 2024, decidedYear: '  ', batchSeq: null, reviewOutcome: null }, fieldGaps: [
      { field: 'decidedYear', valueState: 'blank', inputState: 'provided' }, { field: 'batchSeq', valueState: 'unknown', inputState: 'null' }, { field: 'reviewOutcome', valueState: 'unknown', inputState: 'omitted' },
    ] },
  ] }
  const first = await historicalProjection(batchId, firstIndex), second = await historicalProjection(batchId, secondIndex, receiptId)
  expect(first.status).toBe(200)
  expect(second.status).toBe(200)
  expect(first.body.qualificationDiagnostics).toEqual(expectedFirst)
  expect(second.body.qualificationDiagnostics).toEqual(expectedSecond)
  expectCompleteSnapshot(first.body.qualificationReadback.assessment, innovative.enterpriseId)
  expect(second.body.qualificationReadback).toEqual(first.body.qualificationReadback)
  expect(initialReadSpy).not.toHaveBeenCalled()
  expect(counts()).toEqual(beforeInitialReads)
  initialReadSpy.mockRestore()
  const originalSummary = db.select().from(schema.importBatch).where(historicalEq(schema.importBatch.id, batchId)).get()!.summary
  const competing = db.select().from(schema.recordEvent).where(historicalEq(schema.recordEvent.recordId, innovative.id)).all().find(event => event.eventType === 'review' && event.year === 2022)
  if (!competing) throw new Error('Synthetic competing event required')
  db.update(schema.recordEvent).set({ year: 2040, decidedYear: 2041 }).where(historicalEq(schema.recordEvent.id, competing.id)).run()
  db.update(schema.importBatch).set({ preflightResult: { qualificationDiagnostics: ['synthetic mutable preflight poison'] } }).where(historicalEq(schema.importBatch.id, batchId)).run()
  vi.setSystemTime(Date.parse('2027-01-15T00:00:00Z'))
  expect(getRosterEnterpriseDetail(db, innovative.enterpriseId, Date.now())!.qualificationAssessment.snapshotId).not.toBe(first.body.qualificationReadback.assessment.snapshotId)
  const beforeReplayReads = counts()
  const spy = vi.spyOn(qualification, 'readCurrentQualificationAssessment')
  const replay = await historicalSubmit(body)
  expect(replay.status).toBe(200)
  expect(replay.body.status).toBe('committed')
  expect(replay.body.summary).not.toHaveProperty('qualificationDiagnosticsByItem')
  const retainedFirst = await historicalProjection(batchId, firstIndex), retainedSecond = await historicalProjection(batchId, secondIndex, receiptId)
  expect(retainedFirst.status).toBe(200)
  expect(retainedSecond.status).toBe(200)
  expect(retainedFirst.body).toEqual(first.body)
  expect(retainedSecond.body).toEqual(second.body)
  expect(db.select().from(schema.importBatch).where(historicalEq(schema.importBatch.id, batchId)).get()!.summary).toEqual(originalSummary)
  expect(spy).not.toHaveBeenCalled()
  expect(counts()).toEqual(beforeReplayReads)
})

it('history_diagnostics_legacy_is_not_retained_without_reader', async () => {
  const batch = db.insert(schema.importBatch).values({ idempotencyKey: '407-history-legacy-diagnostics', sourceKind: 'announcement', sourceIdentity: 'synthetic/legacy-diagnostics', status: 'committed',
    summary: { written: 1, skipped: 0, failed: 0, evidenceRepointed: 0 }, itemResults: [{ ok: true, kind: 'record_event', ref: 'record:9', detail: { enterpriseId: 9 } }] }).returning().get()
  const spy = vi.spyOn(qualification, 'readCurrentQualificationAssessment')
  const before = counts(), result = await historicalProjection(batch.id, 0)
  expect(result.status).toBe(200)
  expect(result.body.qualificationDiagnostics).toEqual({ status: 'not_retained', reason: 'legacy_receipt' })
  expect(result.body.qualificationDiagnostics).not.toHaveProperty('items')
  expect(result.body.qualificationReadback).toEqual({ stage: 'after', status: 'not_retained', reason: 'legacy_receipt', target: null })
  expect(spy).not.toHaveBeenCalled()
  expect(counts()).toEqual(before)
})

it.each([{ Case: 'tamper' }, { Case: 'redaction' }])('history_diagnostics_protection_$Case', async ({ Case }) => {
  // Synthetic saved-JSON mutation/redaction control; assessment reader itself remains real.
  const sentinel = 'synthetic-history-diagnostic-only'
  const body = { ...request([]), payload: { announcement: { sourceDocument: { source: 'jxj', title: '合成历史诊断保护' }, records: [
    { enterprise: { name: '合成附件甲' }, source: 'jxj', titleCode: 'innovative_sme', events: [{ eventType: 'review', year: Case === 'redaction' ? `token=${sentinel}` : 2022 }] },
  ] } } }
  const committed = await historicalSubmit(body)
  expect(committed.status).toBe(200)
  expect(committed.body.status).toBe('committed')
  const record = db.select().from(schema.record).get()
  if (!record || typeof committed.body.batchId !== 'number') throw new Error('Synthetic committed record/batch required')
  const batchId = committed.body.batchId, index = historicalItemIndex(committed.body, record.id)
  const stored = db.select().from(schema.importBatch).where(historicalEq(schema.importBatch.id, batchId)).get()!
  const summary = historicalObject(stored.summary), map = historicalObject(summary.qualificationDiagnosticsByItem), binding = historicalObject(map[String(index)])
  const diagnostics = historicalObject(binding.diagnostics)
  expect(diagnostics.status).toBe('captured')
  if (!Array.isArray(diagnostics.items) || diagnostics.items.length !== 1) throw new Error('One original synthetic diagnostic required')
  if (Case === 'tamper') {
    const values = historicalObject(historicalObject(diagnostics.items[0]).values)
    expect(values.year).toBe(2022)
    values.year = sentinel // Keep original digest to expose content corruption, not invalid JSON.
    db.update(schema.importBatch).set({ summary }).where(historicalEq(schema.importBatch.id, batchId)).run()
  } else expect(JSON.stringify(diagnostics)).toContain(`token=${sentinel}`)
  const frozenRow = db.select().from(schema.importBatch).where(historicalEq(schema.importBatch.id, batchId)).get()
  const before = counts(), spy = vi.spyOn(qualification, 'readCurrentQualificationAssessment')
  const result = await historicalProjection(batchId, index)
  expect(result.status).toBe(200)
  expect(result.body.qualificationDiagnostics).toEqual({ status: 'unavailable', reason: 'read_unavailable' })
  expect(result.body.qualificationDiagnostics).not.toHaveProperty('items')
  expect(JSON.stringify(result.body)).not.toContain(sentinel)
  expect(result.body.qualificationReadback).toEqual(committed.body.qualificationReadback)
  expectCompleteSnapshot(result.body.qualificationReadback.assessment, record.enterpriseId)
  expect(db.select().from(schema.importBatch).where(historicalEq(schema.importBatch.id, batchId)).get()).toEqual(frozenRow)
  expect(counts()).toEqual(before)
  expect(spy).not.toHaveBeenCalled()
})

it('history_diagnostics_whole_envelope_budget_includes_both_slots', async () => {
  const body = { ...request([]), payload: { announcement: { sourceDocument: { source: 'jxj', title: '合成历史诊断字节边界' }, records: [
    { enterprise: { name: '合成附件甲' }, source: 'jxj', titleCode: 'innovative_sme', events: [{ eventType: 'review', year: ' '.repeat(3000), decidedYear: 2025, batchSeq: 1, reviewOutcome: 'passed' }] },
  ] } } }
  const committed = await historicalSubmit(body)
  expect(committed.status).toBe(200)
  expect(committed.body.status).toBe('committed')
  const record = db.select().from(schema.record).get()
  if (!record || typeof committed.body.batchId !== 'number') throw new Error('Synthetic committed record/batch required')
  const batchId = committed.body.batchId, itemIndex = historicalItemIndex(committed.body, record.id)
  const before = counts(), spy = vi.spyOn(qualification, 'readCurrentQualificationAssessment')
  const complete = await historicalProjection(batchId, itemIndex)
  expect(complete.status).toBe(200)
  expect(complete.body.qualificationDiagnostics).toMatchObject({ status: 'captured', items: [{ values: { year: ' '.repeat(3000) } }] })
  const requiredBytes = Buffer.byteLength(JSON.stringify(complete.body), 'utf8')
  const { qualificationDiagnostics: _diagnostics, ...withoutDiagnostics } = complete.body
  expect(requiredBytes).toBeGreaterThan(JSON.stringify(complete.body).length)
  expect(requiredBytes).toBeLessThanOrEqual(65536)
  expect(Buffer.byteLength(JSON.stringify(withoutDiagnostics), 'utf8')).toBeLessThan(requiredBytes - 1)
  const exact = await historicalProjection(batchId, itemIndex, undefined, requiredBytes)
  expect(exact.status).toBe(200)
  expect(exact.body).toEqual(complete.body)
  const small = await historicalProjection(batchId, itemIndex, undefined, requiredBytes - 1)
  expect(small.status).toBe(413)
  expect(small.body).not.toHaveProperty('qualificationDiagnostics')
  expect(small.body).not.toHaveProperty('qualificationReadback')
  // The shared HTTP fixture retains status/message only on thrown errors. Inspect
  // the public read core's domain error directly for exact requiredBytes/code.
  let domainError: unknown
  try { readImportReceipt(db, 'items', { projection: 'qualification', source: 'private_batch', batchId, itemIndex, maxBytes: requiredBytes - 1 }) }
  catch (error) { domainError = error }
  expect(domainError).toBeInstanceOf(HistoricalReceiptError)
  expect(domainError).toMatchObject({ statusCode: 413, code: 'response_limit', requiredBytes })
  expect(counts()).toEqual(before)
  expect(spy).not.toHaveBeenCalled()
})

it('history_diagnostics_captured_empty_is_distinct_from_legacy', async () => {
  const body = request([award])
  const recordInput = body.payload.announcement?.records[0]
  if (!recordInput) throw new Error('Synthetic announcement record required')
  recordInput.source = 'miit' // Existing candidate helper deliberately has no official-event diagnostics here.
  const committed = await post('commit', body)
  expect(committed.status).toBe(200)
  expect(committed.body.status).toBe('committed')
  const record = db.select().from(schema.record).get()
  if (!record) throw new Error('Synthetic committed record required')
  const result = await historicalProjection(committed.body.batchId, historicalItemIndex(committed.body, record.id))
  expect(result.status).toBe(200)
  expect(result.body.qualificationDiagnostics).toEqual({ status: 'captured', items: [] })
})
