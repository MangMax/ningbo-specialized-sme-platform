import { createHash } from 'node:crypto'
import { expect, beforeEach, afterEach, it, vi } from 'vitest'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { enterprise } from '../../../db/postgresql/enterprise-tables'
import { record, recordEvent, recordEvidence } from '../../../db/postgresql/ledger-tables'
import { importBatch, importReceipt } from '../../../db/postgresql/import-tables'
import type { RosterImportEvent, RosterImportRequest } from '../../../layers/sme-roster/lib/roster-import-client'
import { readPostgresLegacyQualification } from '../../../layers/sme-roster/lib/roster/current-qualification-postgres'
import { readPostgresRosterEnterpriseDetail } from '../../../layers/sme-roster/lib/roster/enterprise-detail-postgres'
import { readPostgresImportReceipt } from '../../../layers/sme-roster/server/utils/import-receipts-postgres'
import { handlePostgresRosterImportRequest } from '../../../layers/sme-roster/server/utils/roster-import-http'
import { ImportReceiptError as HistoricalReceiptError } from '../../../layers/sme-roster/server/utils/import-receipt-model'
import { completeInProcessPostgresIntake } from '../imports/fixtures/in-process-intake-postgres'
import { useIsolatedPostgresCases } from '../../support/isolated-postgres-cases'

const schema = { enterprise, record, recordEvent, recordEvidence, importBatch, importReceipt }
const openCase = useIsolatedPostgresCases()
const NOW = Date.parse('2026-01-15T00:00:00.000Z')
const TOKEN = 'synthetic-import-token'
let db: NodePgDatabase
beforeEach(() => {
  db = openCase()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
})
afterEach(() => vi.useRealTimers())

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
  const result = await handlePostgresRosterImportRequest(action, { method: 'POST', body,
    headers: authorized ? { authorization: 'Bearer ' + TOKEN } : {} }, { apiToken: TOKEN })
  return { status: result.status, body: await completeInProcessPostgresIntake(db, result.body, body) as any }
}
async function get(path: string) {
  const url = new URL(path, 'http://fixture')
  try {
    const body = await readPostgresImportReceipt(db, url.pathname.endsWith('/items') ? 'items' : 'get', Object.fromEntries(url.searchParams))
    return { status: 200, body: body as any }
  } catch (error) {
    if (!(error instanceof HistoricalReceiptError)) throw error
    return { status: error.statusCode, body: { error: error.code } as any }
  }
}
const current = async (id: number) => (await readPostgresRosterEnterpriseDetail(db, id, Date.now()))?.qualificationAssessment
const captured = (id: number) => db.transaction(tx => readPostgresLegacyQualification(tx, id, Date.now()), { isolationLevel: 'repeatable read', accessMode: 'read only' })
function expectCompleteSnapshot(snapshot: any, enterpriseId: number) {
  expect(snapshot).toMatchObject({ enterpriseId, asOf: '2026-01-15T00:00:00.000Z',
    ruleVersion: 'current-roster-116-v8', assessmentVersion: 'enterprise-qualification-407-v1' })
  expect(snapshot.titles.map((t: any) => t.titleCode).sort()).toEqual(['innovative_sme', 'little_giant', 'specialized_sme'])
  const { snapshotId, titles, ...scope } = snapshot
  expect(snapshotId).toBe(createHash('sha256').update(JSON.stringify([scope, titles])).digest('hex'))
}
async function counts() {
  return { enterprises: (await db.select().from(schema.enterprise)).length,
    events: (await db.select().from(schema.recordEvent)).length,
    evidence: (await db.select().from(schema.recordEvidence)).length }
}

it('new_target_preflight_separates_candidate_from_current', async () => {
  const before = await counts()
  const result = await post('preflight', request([{ ...review, batchSeq: null, decidedYear: null, reviewOutcome: null }]))
  expect(result.status).toBe(200)
  expect(result.body.status).toBe('preflight')
  expect(await counts()).toEqual(before) // import_batch/import_receipt are deliberately not business facts.
  expect(result.body.preflight.qualificationDiagnostics).toEqual([expect.objectContaining({
    ref: 'record:0#0', eventType: 'review', values: { year: 2022, decidedYear: null, batchSeq: null, reviewOutcome: null },
    fieldGaps: expect.arrayContaining(['decidedYear', 'batchSeq', 'reviewOutcome'].map(field => expect.objectContaining({ field, valueState: 'unknown' }))),
  })])
  expect(result.body.preflight.qualificationReadback).toEqual({ stage: 'before', status: 'not_retained', reason: 'new_target', target: null })
  expect(result.body.preflight.qualificationReadback).not.toHaveProperty('assessment')
})

it('attachment1_commit_and_private_receipt_share_the_captured_snapshot', async () => {
  const body = request([award])
  await post('preflight', body)
  const result = await post('commit', body)
  expect(result.status).toBe(200)
  expect(result.body.status).toBe('committed')
  const capture = result.body.qualificationReadback
  expect(capture).toMatchObject({ stage: 'after', status: 'captured', target: { enterpriseId: 1 } })
  expectCompleteSnapshot(capture.assessment, 1)
  const title = capture.assessment.titles.find((t: any) => t.titleCode === 'innovative_sme')
  expect(title).toMatchObject({ group: 'eligible', evidence: [{ eventType: 'award', year: 2025, decidedYear: 2025, batchSeq: 2, reviewOutcome: null }] })
  expect(await captured(1)).toEqual(capture.assessment)
  const detail = await current(1)
  expect(detail?.titles.find(row => row.titleCode === 'innovative_sme')).toMatchObject({
    group: 'eligible', evidence: [expect.objectContaining({ eventType: 'award', year: 2025, decidedYear: 2025, batchSeq: 2 })],
  })
  const metadata = await get(`/api/roster/import/receipts?batchId=${result.body.batchId}`)
  expect(metadata.status).toBe(200)
  expect(metadata.body.receiptId).toBeGreaterThan(0)
  const itemIndex = result.body.items.findIndex((item: any) => item.kind === 'record_event')
  expect(itemIndex).toBeGreaterThanOrEqual(0)
  const historical = await get(`/api/roster/import/receipts/items?projection=qualification&source=private_batch&batchId=${result.body.batchId}&itemIndex=${itemIndex}`)
  expect(historical.status).toBe(200)
  expect(historical.body).toMatchObject({ batchId: result.body.batchId, receiptId: null, itemIndex,
    target: { enterpriseId: 1 }, qualificationReadback: capture })
  const redacted = await get(`/api/roster/import/receipts/items?projection=qualification&source=redacted_receipt&receiptId=${metadata.body.receiptId}&itemIndex=${itemIndex}`)
  expect(redacted.status).toBe(200)
  expect(redacted.body).toMatchObject({ batchId: result.body.batchId, receiptId: metadata.body.receiptId, itemIndex,
    qualificationReadback: { stage: 'after', status: 'not_retained', target: null } })
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
  const result = await post('commit', body)
  expect(result.status).toBe(200)
  expect(result.body.status).toBe('committed')
  expectCompleteSnapshot(result.body.qualificationReadback.assessment, 1)
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

it('multiple_enterprises_commit_without_selecting_first', async () => {
  const result = await post('commit', request([award], ['合成附件甲', '合成附件乙']))
  expect(result.body.status).toBe('committed')
  expect(result.body.qualificationReadback).toEqual({ stage: 'after', status: 'not_retained', reason: 'multiple_targets', target: null, enterpriseIds: [1, 2] })
  expect(await counts()).toEqual({ enterprises: 2, events: 2, evidence: 2 })
})

it('replay_preserves_original_capture_asof_and_versions', async () => {
  const body = request([award])
  const first = await post('commit', body)
  expect(first.status).toBe(200)
  expect(first.body.status).toBe('committed')
  expect(first.body.qualificationReadback.status).toBe('captured')
  expectCompleteSnapshot(first.body.qualificationReadback.assessment, 1)
  vi.setSystemTime(Date.parse('2027-01-15T00:00:00Z'))
  // Independent competing fact changes only current detail, not the retained historical receipt.
  await db.insert(schema.recordEvent).values({ recordId: 1, eventType: 'review', year: 2025, decidedYear: 2026, batchSeq: 2, reviewOutcome: 'failed' })
  const now = await current(1)
  expect(now?.snapshotId).not.toBe(first.body.qualificationReadback.assessment.snapshotId)
  const replay = await post('commit', body)
  expect(replay.status).toBe(200)
  expect(replay.body.status).toBe('committed')
  expect(replay.body.qualificationReadback).toEqual(first.body.qualificationReadback)
  expect((await counts()).events).toBe(2)
})

it('invalid_unknown_outcome_fails_atomically_without_success_after', async () => {
  const result = await post('commit', request([award, { ...review, reviewOutcome: 'unknown' } as unknown as RosterImportEvent]))
  expect(result.body.status).toBe('failed')
  expect(result.body.items).toContainEqual(expect.objectContaining({ ok: false, error: expect.objectContaining({ code: 'review_outcome_unknown' }) }))
  expect(result.body.qualificationReadback?.status).not.toBe('captured')
  expect(await counts()).toEqual({ enterprises: 0, events: 0, evidence: 0 })
})

it('legacy_receipt_projection_reports_not_retained_without_current_readback', async () => {
  const [batch] = await db.insert(schema.importBatch).values({ idempotencyKey: 'legacy-407', sourceKind: 'announcement', sourceIdentity: 'synthetic/legacy', createdAt: '2026-01-15', status: 'committed',
    summary: JSON.stringify({ written: 1, skipped: 0, failed: 0, evidenceRepointed: 0 }), itemResults: JSON.stringify([{ ok: true, kind: 'record_event', ref: 'record:9', detail: { enterpriseId: 9 } }]) }).returning()
  const result = await get(`/api/roster/import/receipts/items?projection=qualification&source=private_batch&batchId=${batch!.id}&itemIndex=0&maxBytes=65536`)
  expect(result.status).toBe(200)
  expect(result.body).toMatchObject({ batchId: batch!.id, itemIndex: 0, qualificationReadback: { stage: 'after', status: 'not_retained', reason: 'legacy_receipt', target: null } })
})

it('unauthorized_submission_writes_no_business_or_receipt', async () => {
  const result = await post('commit', request([award]), false)
  expect(result.status).toBe(401)
  expect(await counts()).toEqual({ enterprises: 0, events: 0, evidence: 0 })
  expect(await db.select().from(schema.importReceipt)).toEqual([])
})

it('existing_target_preflight_reports_current_assessment_separately_from_proposed_review', async () => {
  const first = await post('commit', request([award]))
  expect(first.body.status).toBe('committed')
  const before = await captured(1)
  const body = request([{ ...review, batchSeq: null }])
  body.idempotencyKey = '407-proposed-review'
  const plan = await post('preflight', body)
  expect(plan.status).toBe(200)
  expect(plan.body.preflight.qualificationReadback).toEqual({ stage: 'before', status: 'captured', target: { enterpriseId: 1 }, assessment: before })
  expect(plan.body.preflight.qualificationDiagnostics).toContainEqual(expect.objectContaining({ ref: 'record:0#0', eventType: 'review',
    values: { year: 2022, decidedYear: 2025, batchSeq: null, reviewOutcome: 'passed' } }))
  expect((await counts()).events).toBe(1)
})

it('qualification_projection_rejects_wrong_item_and_budget_without_changing_old_default', async () => {
  const result = await post('commit', request([award]))
  expect(result.body.status).toBe('committed')
  const before = await counts()
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
  expect(await counts()).toEqual(before)
})


it.each(['captured', 'changed_digest', 'redacted', 'empty', 'not_retained'] as const)('reads retained diagnostics with %s evidence', async scenario => {
  const enterpriseId = 13, recordId = 18, itemIndex = 1
  const binding = { itemIndex, ref: 'record:18', enterpriseId, recordId, candidateRef: 'record:0' }
  const item = { ref: 'record:0#0', eventType: 'review',
    values: { year: ' '.repeat(3000), decidedYear: null, batchSeq: 1, reviewOutcome: 'passed' },
    fieldGaps: [{ field: 'year', valueState: 'blank', inputState: 'provided' },
      { field: 'decidedYear', valueState: 'unknown', inputState: 'omitted' }],
  }
  if (scenario === 'redacted') {
    item.values.year = 'token=synthetic-history-diagnostic-only'
    item.fieldGaps[0]!.valueState = 'invalid'
  }
  const diagnostics = { status: 'captured', items: scenario === 'empty' ? [] : [item] }
  const digest = createHash('sha256').update(JSON.stringify([binding, diagnostics])).digest('hex')
  if (scenario === 'changed_digest') item.values.year = 'changed after capture'
  const [batch] = await db.insert(importBatch).values({
    idempotencyKey: 'retained-diagnostic-' + scenario, sourceKind: 'announcement', sourceIdentity: 'synthetic-historical',
    status: 'committed', createdAt: '2026-01-15', summary: JSON.stringify(scenario === 'not_retained' ? {}
      : { qualificationDiagnosticsByItem: { [itemIndex]: { ...binding, digest, diagnostics } } }),
    itemResults: JSON.stringify([{ ok: true, kind: 'record_event', ref: 'record:17', detail: { enterpriseId, recordId: 17 } },
      { ok: true, kind: 'record_event', ref: 'record:18', detail: { enterpriseId, recordId } }]),
  }).returning({ id: importBatch.id })
  const selector = { projection: 'qualification', source: 'private_batch', batchId: batch!.id, itemIndex }
  const actual = await readPostgresImportReceipt(db, 'items', selector)
  expect(actual).toMatchObject({ batchId: batch!.id, itemIndex,
    qualificationDiagnostics: scenario === 'not_retained' ? { status: 'not_retained', reason: 'legacy_receipt' }
      : scenario === 'changed_digest' || scenario === 'redacted' ? { status: 'unavailable', reason: 'read_unavailable' } : diagnostics,
  })
  expect(JSON.stringify(actual)).not.toContain('synthetic-history-diagnostic-only')
  const requiredBytes = Buffer.byteLength(JSON.stringify(actual))
  expect(await readPostgresImportReceipt(db, 'items', { ...selector, maxBytes: requiredBytes })).toEqual(actual)
  await expect(readPostgresImportReceipt(db, 'items', { ...selector, maxBytes: requiredBytes - 1 }))
    .rejects.toMatchObject({ statusCode: 413, code: 'response_limit', requiredBytes })
})
