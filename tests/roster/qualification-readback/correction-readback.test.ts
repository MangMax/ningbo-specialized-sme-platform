import { initializeDb } from '../../../db/client'
import { submitNativePlatformQuery } from '../../platform/fixtures/native-query'
/** #407 parent-frozen correction/readback cases.
 * Synthetic SQLite only. MCP dispatcher assertions do not stand for real SDK proof.
 * Budget tests deliberately fake only the reader output, never qualification policy.
 */
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as schema from '../../../db/schema'
import type { OfficialPublishedRow, RosterImportRequest } from '../../../lib/roster-import-client'
import * as qualification from '../../../lib/roster/current-qualification'
import { getRosterEnterpriseDetail } from '../../../lib/roster/enterprise-roster'
import { handleEventCorrectionRequest } from '../../../server/utils/roster-event-correction-api'
import type { EventCorrectionRequest } from '../../../server/utils/roster-event-correction'
import { dispatchEventCorrectionMcp } from '../../../server/utils/mcp-event-correction'
import { handleRosterImportRequest } from '../../../server/utils/roster-import-http'
import { preflightRosterImport, commitRosterImport } from '../../../server/utils/roster-import'
import { preflightRecordCorrespondences, commitRecordCorrespondences, type CorrespondenceRequest } from '../../../server/utils/record-correspondence'
import { startHttpFixture, type HttpFixture } from '../../support/http'

const NOW = Date.parse('2026-01-15T00:00:00.000Z')
const TOKEN = 'synthetic-407-correction-token'
const SOURCE = '407 synthetic source bytes only'
const SOURCE_HASH = createHash('sha256').update(SOURCE).digest('hex')
let sqlite: Database.Database
let db: ReturnType<typeof drizzle<typeof schema>>
let dir: string
let api: HttpFixture | undefined
let enterprise: typeof schema.enterprise.$inferSelect
let record: typeof schema.record.$inferSelect
let event: typeof schema.recordEvent.$inferSelect
let evidence: typeof schema.recordEvidence.$inferSelect
let file: typeof schema.storedFile.$inferSelect
let document: typeof schema.sourceDocument.$inferSelect

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  dir = mkdtempSync(join(tmpdir(), 'qualification-correction-407-'))
  writeFileSync(join(dir, 'notice.txt'), SOURCE)
  db = initializeDb({ create: true, dbPath: join(dir,'source.sqlite') })
  sqlite = db.$client
  enterprise = db.insert(schema.enterprise).values({ name: '合成更正甲', nameNorm: '合成更正甲', usccNorm: '913302000000000001' }).returning().get()
  record = db.insert(schema.record).values({ enterpriseId: enterprise.id, titleCode: 'innovative_sme', source: 'jxj', nameRaw: '合成公布原名', usccRaw: enterprise.usccNorm }).returning().get()
  event = db.insert(schema.recordEvent).values({ recordId: record.id, eventType: 'review', year: 2025, batchSeq: null, decidedYear: null, reviewOutcome: null }).returning().get()
  evidence = db.insert(schema.recordEvidence).values({ recordEventId: event.id, sourceFile: 'notice.txt', attachment: '附件2', listNo: 1 }).returning().get()
  file = db.insert(schema.storedFile).values({ relPath: 'notice.txt', filename: 'notice.txt', ext: 'txt', bytes: Buffer.byteLength(SOURCE), sha256: SOURCE_HASH, source: 'jxj', kind: 'announcement' }).returning().get()
  document = db.insert(schema.sourceDocument).values({ source: 'jxj', title: '2025年新认定第二批及2022年企业复核通过名单', path: 'notice.txt' }).returning().get()
  const correctionRoute = (action: 'preflight' | 'commit' | 'get' | 'audit') =>
    (request: { method: string; headers: Record<string, string | undefined>; body: unknown; query: Record<string, unknown> }) =>
      handleEventCorrectionRequest({ ...request, action, id: event.id }, { db, apiToken: TOKEN })
  api = await startHttpFixture({ routes: {
    '/api/roster/events/corrections/preflight': correctionRoute('preflight'),
    '/api/roster/events/corrections/commit': correctionRoute('commit'),
    ...Object.fromEntries((['preflight', 'commit'] as const).map(action => [
      `/api/roster/import/${action}`,
      (request: { method: string; headers: Record<string, string | undefined>; body: unknown }) => handleRosterImportRequest(action, request, {
        db, apiToken: TOKEN, filesDir: dir,
        executeImport: async (source, phase, body, errors, context, options) => phase === 'preflight'
          ? preflightRosterImport(source, body, errors, { ...context, ...options })
          : commitRosterImport(source, body, errors, { ...context, ...options, deferCandidateTasks: true }),
      }),
    ])),
  }, getRoutes: {
    [`/api/roster/events/${event.id}`]: correctionRoute('get'),
    [`/api/roster/events/${event.id}/audit`]: correctionRoute('audit'),
    [`/api/roster/enterprises/${enterprise.id}`]: () => ({ status: 200, body: getRosterEnterpriseDetail(db, enterprise.id, NOW) }),
  } })
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
function correction(patch: EventCorrectionRequest['operations'][number]['patch'] = { year: 2022, decidedYear: 2025, reviewOutcome: 'passed', batchSeq: null }): EventCorrectionRequest {
  return { idempotencyKey: '407-exact-correction', sourceIdentity: 'synthetic/attachment2', actor: { type: 'agent', id: 'synthetic-407' },
    basis: '合成附件2明确复核2022年原认定企业；通知新认定第二批不用于填原批次',
    operations: [{ eventId: event.id, recordId: record.id, enterpriseId: enterprise.id, expectedRevision: 1, patch }] }
}
async function post(path: string, body: unknown, authorized = true) {
  const response = await fetch(api!.baseUrl + path, { method: 'POST', headers: { 'content-type': 'application/json',
    ...(authorized ? { authorization: `Bearer ${TOKEN}` } : {}) }, body: JSON.stringify(body) })
  return { status: response.status, body: await response.json() as any }
}
async function get(path: string) {
  const response = await fetch(api!.baseUrl + path, { headers: { authorization: `Bearer ${TOKEN}` } })
  return { status: response.status, body: await response.json() as any }
}
async function preflight(body: EventCorrectionRequest) {
  const result = await post('/api/roster/events/corrections/preflight', body)
  expect(result.status).toBe(200)
  expect(result.body.planHash).toMatch(/^[a-f0-9]{64}$/)
  return result.body
}
async function commit(body: EventCorrectionRequest, planHash: string) {
  return post('/api/roster/events/corrections/commit', { request: body, planHash })
}
function currentTitle() {
  return qualification.readCurrentQualificationAssessment(db.$client, enterprise.id, NOW, { assessmentVersion: 'enterprise-qualification-407-v1' }).titles.find(t => t.titleCode === 'innovative_sme')!
}
function businessState() {
  return { events: db.select().from(schema.recordEvent).all(), evidence: db.select().from(schema.recordEvidence).all(),
    audit: db.select().from(schema.eventCorrectionAudit).all(), rows: db.select().from(schema.officialEvidenceRowRevision).all() }
}
function publishedRow(nameRaw: string | null): OfficialPublishedRow {
  return { nameRaw, usccRaw: null, districtRaw: null, declaration: { kind: 'existing', sourceDocumentId: document.id, basis: '合成正式公告声明' },
    storedFileId: file.id, path: 'notice.txt', sha256: SOURCE_HASH, bytes: Buffer.byteLength(SOURCE), attachment: '附件2', sectionKey: 'synthetic-attachment2-section',
    listNo: 2, page: null, sourceBindingKnown: true, actor: { type: 'agent', id: 'synthetic-407' }, basis: '只捕获合成原行，不修改事件语义' }
}
function captureRequest(nameRaw: string | null): RosterImportRequest {
  return { idempotencyKey: '407-capture-only', sourceKind: 'announcement', sourceIdentity: 'synthetic/attachment2-capture',
    payload: { officialEvidenceAppends: [{ eventId: event.id, recordId: record.id, enterpriseId: enterprise.id, expectedVersion: 1,
      evidence: { sourceFile: 'notice.txt', attachment: '附件2', listNo: 2, page: null, publishedRow: publishedRow(nameRaw) } }] } }
}

it('review_correction_reads_actual_after_and_preserves_event_identity', async () => {
  const body = correction()
  const before = businessState()
  const plan = await preflight(body)
  expect(plan.qualificationDiagnostics).toContainEqual(expect.objectContaining({ ref: `event:${event.id}`, eventType: 'review',
    values: { year: 2022, decidedYear: 2025, batchSeq: null, reviewOutcome: 'passed' },
    fieldGaps: expect.arrayContaining([expect.objectContaining({ field: 'batchSeq', valueState: 'unknown' })]) }))
  expect(plan.qualificationReadback).toMatchObject({ stage: 'before', status: 'captured', target: { enterpriseId: enterprise.id } })
  expect(businessState()).toEqual(before)
  const spy = vi.spyOn(qualification, 'readCurrentQualificationAssessment')
  const result = await commit(body, plan.planHash)
  expect(result.status).toBe(200)
  expect(spy).toHaveBeenCalledTimes(1)
  expect(result.body).toMatchObject({ eventIds: [event.id], qualificationReadback: { stage: 'after', status: 'captured', target: { enterpriseId: enterprise.id } } })
  const snapshot = result.body.qualificationReadback.assessment
  expect(snapshot).toMatchObject({ asOf: '2026-01-15T00:00:00.000Z', ruleVersion: 'current-roster-116-v8', assessmentVersion: 'enterprise-qualification-407-v1' })
  expect(snapshot.titles.map((t: any) => t.titleCode).sort()).toEqual(['innovative_sme', 'little_giant', 'specialized_sme'])
  const title = snapshot.titles.find((t: any) => t.titleCode === 'innovative_sme')
  expect(title).toMatchObject({ group: 'pending', evidence: [{ eventId: event.id, revision: 2, year: 2022, decidedYear: 2025, reviewOutcome: 'passed', batchSeq: null }] })
  expect(title.completeness.fieldGaps).toContainEqual(expect.objectContaining({ eventId: event.id, field: 'batchSeq' }))
  const detail = await get(`/api/roster/enterprises/${enterprise.id}`)
  expect(qualification.readCurrentQualificationAssessment(db.$client, enterprise.id, Date.parse(snapshot.asOf), { assessmentVersion: 'enterprise-qualification-407-v1' })).toEqual(snapshot)
  expect(detail.body.qualificationAssessment).toEqual(qualification.readCurrentQualificationAssessment(db.$client, enterprise.id, Date.parse(snapshot.asOf)))
  const read = await get(`/api/roster/events/${event.id}`)
  expect(read.body.event).toMatchObject({ id: event.id, recordId: record.id, revision: 2, year: 2022, decidedYear: 2025, batchSeq: null, reviewOutcome: 'passed' })
  expect(read.body.evidence).toEqual(before.evidence)
  const audit = await get(`/api/roster/events/${event.id}/audit`)
  expect(audit.body).toMatchObject({ total: 1, rows: [{ before: { revision: 1, year: 2025 }, after: { revision: 2, year: 2022 }, basis: body.basis }] })
})

it('correction_replay_returns_original_capture_without_reader_or_new_audit', async () => {
  const body = correction(), plan = await preflight(body)
  const first = await commit(body, plan.planHash)
  expect(first.status).toBe(200)
  expect(first.body.eventIds).toEqual([event.id])
  expect(first.body.qualificationReadback.status).toBe('captured')
  vi.setSystemTime(Date.parse('2027-01-15T00:00:00Z'))
  db.update(schema.storedFile).set({ bytes: 99 }).where(eq(schema.storedFile.id, file.id)).run()
  const spy = vi.spyOn(qualification, 'readCurrentQualificationAssessment')
  const second = await commit(body, plan.planHash)
  expect(second.body).toEqual(first.body)
  expect(spy).not.toHaveBeenCalled()
  expect(db.select().from(schema.eventCorrectionAudit).all()).toHaveLength(1)
  // Read-only dispatcher parity, not SDK transport evidence.
  expect(dispatchEventCorrectionMcp('commit', { request: body, planHash: plan.planHash }, { db, authorized: true })).toEqual(first.body)
  expect(spy).not.toHaveBeenCalled()
})

it('same_enterprise_two_titles_invokes_shared_reader_once', async () => {
  const secondRecord = db.insert(schema.record).values({ enterpriseId: enterprise.id, titleCode: 'specialized_sme', source: 'jxj' }).returning().get()
  const secondEvent = db.insert(schema.recordEvent).values({ recordId: secondRecord.id, eventType: 'award', year: 2025 }).returning().get()
  db.insert(schema.recordEvidence).values({ recordEventId: secondEvent.id, sourceFile: 'notice.txt' }).run()
  const body = correction()
  body.operations.push({ eventId: secondEvent.id, recordId: secondRecord.id, enterpriseId: enterprise.id, expectedRevision: 1, patch: { decidedYear: 2025 } })
  const plan = await preflight(body)
  const spy = vi.spyOn(qualification, 'readCurrentQualificationAssessment')
  const result = await commit(body, plan.planHash)
  expect(result.status).toBe(200)
  expect(spy).toHaveBeenCalledTimes(1)
  expect(result.body.qualificationReadback.target).toEqual({ enterpriseId: enterprise.id })
  expect(result.body.qualificationReadback.assessment.titles).toHaveLength(3)
  expect(db.select().from(schema.eventCorrectionAudit).all()).toHaveLength(2)
})

it('multiple_correction_targets_keep_legacy_commit_and_do_not_pick_first', async () => {
  const other = db.insert(schema.enterprise).values({ name: '合成更正乙', nameNorm: '合成更正乙' }).returning().get()
  const otherRecord = db.insert(schema.record).values({ enterpriseId: other.id, titleCode: 'innovative_sme', source: 'jxj' }).returning().get()
  const otherEvent = db.insert(schema.recordEvent).values({ recordId: otherRecord.id, eventType: 'award', year: 2025 }).returning().get()
  db.insert(schema.recordEvidence).values({ recordEventId: otherEvent.id, sourceFile: 'notice.txt' }).run()
  const body = correction()
  body.operations.push({ eventId: otherEvent.id, recordId: otherRecord.id, enterpriseId: other.id, expectedRevision: 1, patch: { decidedYear: 2025 } })
  const plan = await preflight(body)
  const spy = vi.spyOn(qualification, 'readCurrentQualificationAssessment')
  const result = await commit(body, plan.planHash)
  expect(result.status).toBe(200)
  expect(result.body.qualificationReadback).toEqual({ stage: 'after', status: 'not_retained', reason: 'multiple_targets', target: null, enterpriseIds: [enterprise.id, other.id] })
  expect(spy).not.toHaveBeenCalled()
  expect(db.select().from(schema.eventCorrectionAudit).all()).toHaveLength(2)
})

it('file_drift_rejects_without_success_after_or_partial_correction', async () => {
  const body = correction(), plan = await preflight(body)
  db.update(schema.storedFile).set({ sha256: 'b'.repeat(64) }).where(eq(schema.storedFile.id, file.id)).run()
  const before = businessState(), spy = vi.spyOn(qualification, 'readCurrentQualificationAssessment')
  const result = await commit(body, plan.planHash)
  expect(result.status).toBe(409)
  expect(result.body.error.code).toBe('plan_mismatch')
  expect(result.body.qualificationReadback).toBeUndefined()
  expect(spy).not.toHaveBeenCalled()
  expect(businessState()).toEqual(before)
})

it('stale_revision_preserves_competing_update_and_has_no_after', async () => {
  const body = correction(), plan = await preflight(body)
  db.update(schema.recordEvent).set({ revision: 2, year: 2024 }).where(eq(schema.recordEvent.id, event.id)).run()
  const before = businessState()
  const result = await commit(body, plan.planHash)
  expect(result.status).toBe(409)
  expect(result.body.error.code).toBe('stale_revision')
  expect(result.body.qualificationReadback).toBeUndefined()
  expect(businessState()).toEqual(before)
})

it.each([
  { caseId: 'captured_name_is_null', name: null },
  { caseId: 'captured_name_is_empty', name: '' },
  { caseId: 'captured_name_is_spaces', name: '  ' },
  { caseId: 'capture_only_does_not_correct_semantics', name: '合成公布原名' },
])('$caseId', async ({ name }) => {
  const body = captureRequest(name), beforeEvent = { ...event }
  const plan = await post('/api/roster/import/preflight', body)
  expect(plan.status).toBe(200)
  expect(plan.body.preflight.conflicts).toEqual([])
  expect(plan.body.preflight.officialEvidencePlanHash).toMatch(/^[a-f0-9]{64}$/)
  body.payload.officialEvidencePlanHash = plan.body.preflight.officialEvidencePlanHash
  const result = await post('/api/roster/import/commit', body)
  expect(result.status).toBe(200)
  expect(result.body.status).toBe('committed')
  const read = await get(`/api/roster/events/${event.id}?official=latest&maxBytes=65536`)
  expect(read.status).toBe(200)
  const row = read.body.official.rows.find((r: any) => r.listNo === 2)
  expect(row).toMatchObject({ nameRaw: name, attachment: '附件2', sha256: SOURCE_HASH })
  expect(read.body.event).toMatchObject({ year: beforeEvent.year, decidedYear: null, batchSeq: null, reviewOutcome: null })
  const title = currentTitle() as any
  expect(title.completeness.gaps).toContain('missing_cycle_semantics')
  expect(title.completeness.fieldGaps.map((g: any) => g.field)).toEqual(expect.arrayContaining(['decidedYear', 'batchSeq', 'reviewOutcome']))
  expect(title.completeness.publishedNames).toContainEqual(expect.objectContaining({ availability: 'captured', nameKnown: name !== null && name.trim().length > 0 }))
  expect(title.group).toBe('pending')
})

it('uncaptured_legacy_name_is_distinct_from_captured_null', () => {
  const title = currentTitle() as any
  expect(title.completeness.publishedNames).toEqual([{ evidenceId: evidence.id, availability: 'unknown_legacy', nameKnown: false }])
  expect(title.completeness.gaps).toContain('published_name_not_retained')
  expect(title.completeness.gaps).not.toContain('published_name_unknown')
  expect(title.completeness.fieldGaps).toContainEqual(expect.objectContaining({ eventId: event.id, field: 'reviewOutcome' }))
})

it('capture_source_drift_rolls_back_original_rows_and_event', async () => {
  const body = captureRequest('合成原名')
  const plan = await post('/api/roster/import/preflight', body)
  expect(plan.status).toBe(200)
  expect(plan.body.preflight.conflicts).toEqual([])
  expect(plan.body.preflight.officialEvidencePlanHash).toMatch(/^[a-f0-9]{64}$/)
  body.payload.officialEvidencePlanHash = plan.body.preflight.officialEvidencePlanHash
  writeFileSync(join(dir, 'notice.txt'), 'competing synthetic bytes')
  const before = businessState()
  const result = await post('/api/roster/import/commit', body)
  expect(result.body.status).toBe('failed')
  expect(result.body.qualificationReadback?.status).not.toBe('captured')
  expect(result.body.summary.written).toBe(0)
  expect(businessState()).toEqual(before)
})

it('confirmed_edge_does_not_fill_event_and_correction_requires_revalidation', async () => {
  const native = submitNativePlatformQuery(db, { interface: 'business_list', queryKey: enterprise.usccNorm!, rdjb: '1', titleCode: 'innovative_sme', queriedAt: '2025-12-01T00:00:00Z', status: 'success', rawResponse: 'Synthetic approved 2022 process', relations: [{ sequenceNo: 1, enterpriseId: enterprise.id, usccRaw: enterprise.usccNorm, status: '终审通过', year: 2022, batch: '2022-1', matchBasis: 'uscc', verificationStatus: 'confirmed' }] })
  const query = { id: native.queryId }, relation = { id: native.relationIds[0]! }
  const body: CorrespondenceRequest = { idempotencyKey: '407-confirm-edge', sourceIdentity: 'synthetic/edge', actor: { type: 'agent', id: 'synthetic-407' }, basis: '合成来源对应', ruleId: 'manual', ruleVersion: 'fixture',
    operations: [{ action: 'create', status: 'confirmed', edge: { type: 'event_process', eventId: event.id, relationId: relation.id, role: 'context_only' } }] }
  commitRecordCorrespondences(db, body, preflightRecordCorrespondences(db, body).planHash)
  const title = currentTitle() as any
  expect(title).toMatchObject({ group: 'pending', correspondence: { status: 'confirmed' }, completeness: { status: 'incomplete' } })
  expect(title.evidence[0]).toMatchObject({ year: 2025, decidedYear: null, batchSeq: null, reviewOutcome: null })
  expect(title.completeness.fieldGaps).toContainEqual(expect.objectContaining({ field: 'reviewOutcome' }))
  const update = correction(), plan = await preflight(update)
  expect((await commit(update, plan.planHash)).status).toBe(200)
  const beforeGet = businessState()
  expect(currentTitle().correspondence.status).toBe('requires_revalidation')
  expect(db.select().from(schema.recordCorrespondence).all()).toMatchObject([{ status: 'confirmed' }])
  expect(businessState()).toEqual(beforeGet)
})

// Only budget/count partitions inject a snapshot. All semantics above use real SQLite reader.
// Fixture construction measures the independently specified full envelope, not production limits.
function literalSnapshotEnvelopeBytes(bytes: 65536 | 65537) {
  const snapshot = structuredClone(getRosterEnterpriseDetail(db, enterprise.id, NOW)!.qualificationAssessment)
  snapshot.assessmentVersion = 'enterprise-qualification-407-v1'
  snapshot.titles[0]!.notes = ['汉'] // UTF8 discriminator: this is 3 bytes, not one JS code unit.
  const envelope = { stage: 'after', status: 'captured', target: { enterpriseId: enterprise.id }, assessment: snapshot }
  const base = Buffer.byteLength(JSON.stringify(envelope), 'utf8')
  expect(base).toBeLessThan(65536)
  snapshot.titles[0]!.notes[0] += 'x'.repeat(bytes - base)
  // Independent digest reconstruction; hexadecimal replacement is constant length.
  const { snapshotId: _old, titles, ...scope } = snapshot
  snapshot.snapshotId = createHash('sha256').update(JSON.stringify([scope, titles])).digest('hex')
  expect(Buffer.byteLength(JSON.stringify(envelope), 'utf8')).toBe(bytes)
  return snapshot
}

it('capture_exactly_65536_utf8_bytes_keeps_complete_snapshot_once', async () => {
  const body = correction(), plan = await preflight(body)
  const literal = literalSnapshotEnvelopeBytes(65536)
  const spy = vi.spyOn(qualification, 'readCurrentQualificationAssessment').mockReturnValue(literal)
  const result = await commit(body, plan.planHash)
  expect(result.status).toBe(200)
  expect(spy).toHaveBeenCalledTimes(1)
  expect(result.body.qualificationReadback).toEqual({ stage: 'after', status: 'captured', target: { enterpriseId: enterprise.id }, assessment: literal })
  expect(Buffer.byteLength(JSON.stringify(result.body.qualificationReadback), 'utf8')).toBe(65536)
  expect(db.select().from(schema.eventCorrectionAudit).all()).toHaveLength(1)
})

it('capture_65537_utf8_bytes_reports_unavailable_without_failing_commit', async () => {
  const body = correction(), plan = await preflight(body)
  const literal = literalSnapshotEnvelopeBytes(65537)
  const spy = vi.spyOn(qualification, 'readCurrentQualificationAssessment').mockReturnValue(literal)
  const result = await commit(body, plan.planHash)
  expect(result.status).toBe(200)
  expect(spy).toHaveBeenCalledTimes(1)
  expect(result.body.qualificationReadback).toEqual({ stage: 'after', status: 'unavailable', reason: 'response_limit', target: { enterpriseId: enterprise.id }, requiredBytes: 65537 })
  expect(result.body.qualificationReadback).not.toHaveProperty('assessment')
  expect(db.select().from(schema.eventCorrectionAudit).all()).toHaveLength(1)
  const replay = await commit(body, plan.planHash)
  expect(replay.body).toEqual(result.body)
  expect(spy).toHaveBeenCalledTimes(1)
})

it('invalid_patch_and_unauthorized_correction_have_no_after', async () => {
  const before = businessState()
  const invalid = correction({ decidedYear: 2020 }) // Conclusion precedes the retained original year2025.
  const badPlan = await post('/api/roster/events/corrections/preflight', invalid)
  expect(badPlan.status).toBe(422)
  expect(badPlan.body.error.code).toBe('invalid_event_combination')
  expect(badPlan.body.qualificationReadback).toBeUndefined()
  const denied = await post('/api/roster/events/corrections/preflight', correction(), false)
  expect(denied.status).toBe(401)
  expect(businessState()).toEqual(before)
})

it('second_operation_failure_rolls_back_first_event_audit_and_success_after', async () => {
  const second = db.insert(schema.recordEvent).values({ recordId: record.id, eventType: 'award', year: 2023, batchSeq: 1 }).returning().get()
  db.insert(schema.recordEvidence).values({ recordEventId: second.id, sourceFile: 'notice.txt' }).run()
  const body = correction()
  body.operations.push({ eventId: second.id, recordId: record.id, enterpriseId: enterprise.id, expectedRevision: 1, patch: { decidedYear: 2023 } })
  const plan = await preflight(body)
  // Synthetic fixture fault after the first operation, not a second business write path.
  sqlite.exec(`CREATE TRIGGER synthetic_407_audit_failure BEFORE INSERT ON event_correction_audit WHEN NEW.event_id = ${second.id} BEGIN SELECT RAISE(ABORT, 'synthetic second audit failure'); END`)
  const before = businessState(), spy = vi.spyOn(qualification, 'readCurrentQualificationAssessment')
  const result = await commit(body, plan.planHash)
  expect(result.status).toBe(500)
  expect(result.body.error.code).toBe('transaction_failed')
  expect(result.body.qualificationReadback).toBeUndefined()
  expect(spy).not.toHaveBeenCalled()
  expect(businessState()).toEqual(before)
})

it('exact_correction_keeps_other_enterprise_and_other_title_original_bytes', async () => {
  const other = db.insert(schema.enterprise).values({ name: '合成隔离乙', nameNorm: '合成隔离乙' }).returning().get()
  const otherRecord = db.insert(schema.record).values({ enterpriseId: other.id, titleCode: 'innovative_sme', source: 'jxj' }).returning().get()
  const otherEvent = db.insert(schema.recordEvent).values({ recordId: otherRecord.id, eventType: 'award', year: 2025, decidedYear: 2025, batchSeq: 1 }).returning().get()
  const otherTitleRecord = db.insert(schema.record).values({ enterpriseId: enterprise.id, titleCode: 'specialized_sme', source: 'jxj' }).returning().get()
  const otherTitle = db.insert(schema.recordEvent).values({ recordId: otherTitleRecord.id, eventType: 'review', year: 2023, decidedYear: 2026, batchSeq: 1, reviewOutcome: 'failed' }).returning().get()
  const body = correction(), plan = await preflight(body)
  expect((await commit(body, plan.planHash)).status).toBe(200)
  expect(db.select().from(schema.recordEvent).where(eq(schema.recordEvent.id, otherEvent.id)).get()).toEqual(otherEvent)
  expect(db.select().from(schema.recordEvent).where(eq(schema.recordEvent.id, otherTitle.id)).get()).toEqual(otherTitle)
  expect(db.select().from(schema.enterprise).where(eq(schema.enterprise.id, other.id)).get()).toEqual(other)
  expect(db.select().from(schema.eventCorrectionAudit).all()).toMatchObject([{ eventId: event.id, enterpriseId: enterprise.id }])
})

// #407 public finalization controls. Appended after the frozen 18 cases.
// Mocked snapshots below prove protocol/redaction partitions, not SQLite qualification policy.
function expectPublicCorrectionSnapshot(snapshot: qualification.CurrentQualificationSnapshot) {
  expect(snapshot).toMatchObject({ enterpriseId: enterprise.id, asOf: '2026-01-15T00:00:00.000Z',
    ruleVersion: 'current-roster-116-v8', assessmentVersion: 'enterprise-qualification-407-v1' })
  expect(snapshot.titles.map(title => title.titleCode).sort()).toEqual(['innovative_sme', 'little_giant', 'specialized_sme'])
  const { snapshotId, titles, ...scope } = snapshot
  expect(snapshotId).toMatch(/^[a-f0-9]{64}$/)
  expect(snapshotId).toBe(createHash('sha256').update(JSON.stringify([scope, titles])).digest('hex'))
}
function refreshProtocolDigest(snapshot: qualification.CurrentQualificationSnapshot) {
  const { snapshotId: _previous, titles, ...scope } = snapshot
  snapshot.snapshotId = createHash('sha256').update(JSON.stringify([scope, titles])).digest('hex')
}

it('public_safe_capture_keeps_complete_snapshot_and_digest', async () => {
  // Real SQLite and real shared reader, without a fabricated qualification result.
  const body = correction(), plan = await preflight(body)
  expect(plan.qualificationReadback.status).toBe('captured')
  expectPublicCorrectionSnapshot(plan.qualificationReadback.assessment)
  const spy = vi.spyOn(qualification, 'readCurrentQualificationAssessment')
  const result = await commit(body, plan.planHash)
  expect(result.status).toBe(200)
  expect(result.body.qualificationReadback).toMatchObject({ stage: 'after', status: 'captured', target: { enterpriseId: enterprise.id } })
  expectPublicCorrectionSnapshot(result.body.qualificationReadback.assessment)
  expect(spy).toHaveBeenCalledTimes(1)
  const detail = await get(`/api/roster/enterprises/${enterprise.id}`)
  expect(detail.status).toBe(200)
  expect(result.body.qualificationReadback.assessment).toEqual(qualification.readCurrentQualificationAssessment(db.$client, enterprise.id, Date.parse(detail.body.qualificationAssessment.asOf), { assessmentVersion: 'enterprise-qualification-407-v1' }))
  expect(detail.body.qualificationAssessment.assessmentVersion).toBe('enterprise-qualification-687-v4')
})

it.each([
  { Case: 'assignment', invalidDigest: false },
  { Case: 'bad_digest', invalidDigest: true },
])('public_projection_guard_$Case', async ({ invalidDigest }) => {
  const body = correction(), plan = await preflight(body)
  const fake = invalidDigest
    ? structuredClone(getRosterEnterpriseDetail(db, enterprise.id, NOW)!.qualificationAssessment)
    : literalSnapshotEnvelopeBytes(65536)
  const first = fake.titles[0]
  if (!first) throw new Error('Protocol fixture requires all title dimensions')
  const raw = 'synthetic-assignment-only'
  if (invalidDigest) {
    refreshProtocolDigest(fake)
    expect(fake.snapshotId).not.toBe('0'.repeat(64))
    fake.snapshotId = '0'.repeat(64)
  } else {
    first.notes.push(`token=${raw}`)
    refreshProtocolDigest(fake)
    const oversized = { stage: 'after', status: 'captured', target: { enterpriseId: enterprise.id }, assessment: fake }
    expect(Buffer.byteLength(JSON.stringify(oversized), 'utf8')).toBeGreaterThan(65536)
  }
  const spy = vi.spyOn(qualification, 'readCurrentQualificationAssessment').mockReturnValue(fake)
  const result = await commit(body, plan.planHash)
  expect(result.status).toBe(200)
  expect(result.body.qualificationReadback).toEqual({ stage: 'after', status: 'unavailable', reason: 'read_unavailable', target: { enterpriseId: enterprise.id } })
  expect(result.body.qualificationReadback).not.toHaveProperty('assessment')
  expect(JSON.stringify(result.body)).not.toContain(fake.snapshotId)
  if (!invalidDigest) {
    expect(JSON.stringify(fake)).toContain(raw)
    expect(JSON.stringify(result.body)).not.toContain(raw)
  }
  expect(spy).toHaveBeenCalledTimes(1)
  const stored = db.select().from(schema.importBatch).where(eq(schema.importBatch.id, result.body.batchId)).get()
  expect(stored?.summary).toMatchObject({ qualificationReadback: result.body.qualificationReadback })
  expect(db.select().from(schema.eventCorrectionAudit).all()).toHaveLength(1)
})

it('public_structural_key_collision_fails_closed_for_before_and_after', async () => {
  // Synthetic API token collides with versions.facts; no actual credential is inspected.
  const body = correction(), plan = await preflight(body)
  const context = { db, apiToken: 'facts' }
  const before = handleEventCorrectionRequest({ action: 'preflight', method: 'POST', body,
    headers: { authorization: 'Bearer facts' } }, context)
  expect(before.status).toBe(200)
  expect(before.body).toMatchObject({ qualificationReadback: { stage: 'before', status: 'unavailable', reason: 'read_unavailable', target: { enterpriseId: enterprise.id } } })
  expect(JSON.stringify(before.body)).not.toContain('"assessment"')
  const spy = vi.spyOn(qualification, 'readCurrentQualificationAssessment')
  const after = handleEventCorrectionRequest({ action: 'commit', method: 'POST', body: { request: body, planHash: plan.planHash },
    headers: { authorization: 'Bearer facts' } }, context)
  expect(after.status).toBe(200)
  expect(after.body).toMatchObject({ qualificationReadback: { stage: 'after', status: 'unavailable', reason: 'read_unavailable', target: { enterpriseId: enterprise.id } } })
  expect(JSON.stringify(after.body)).not.toContain('"assessment"')
  expect(spy).toHaveBeenCalledTimes(1)
  expect(db.select().from(schema.eventCorrectionAudit).all()).toHaveLength(1)
})

it('public_replay_rechecks_new_context_without_reader_or_storage_rewrite', async () => {
  const body = correction(), plan = await preflight(body)
  const first = await commit(body, plan.planHash)
  expect(first.status).toBe(200)
  expect(first.body.qualificationReadback).toMatchObject({ stage: 'after', status: 'captured', target: { enterpriseId: enterprise.id } })
  expectPublicCorrectionSnapshot(first.body.qualificationReadback.assessment)
  const storedBefore = db.select().from(schema.importBatch).where(eq(schema.importBatch.id, first.body.batchId)).get()
  expect(storedBefore).toBeDefined()
  const spy = vi.spyOn(qualification, 'readCurrentQualificationAssessment')
  // The original capture references notice.txt. New context must not publish it unchanged.
  const changed = handleEventCorrectionRequest({ action: 'commit', method: 'POST', body: { request: body, planHash: plan.planHash },
    headers: { authorization: 'Bearer notice.txt' } }, { db, apiToken: 'notice.txt' })
  expect(changed.status).toBe(200)
  expect(changed.body).toMatchObject({ qualificationReadback: { stage: 'after', status: 'unavailable', reason: 'read_unavailable', target: { enterpriseId: enterprise.id } } })
  expect(JSON.stringify(changed.body)).not.toContain('notice.txt')
  expect(JSON.stringify(changed.body)).not.toContain(first.body.qualificationReadback.assessment.snapshotId)
  expect(db.select().from(schema.importBatch).where(eq(schema.importBatch.id, first.body.batchId)).get()).toEqual(storedBefore)
  const originalContext = await commit(body, plan.planHash)
  expect(originalContext.status).toBe(200)
  expect(originalContext.body).toEqual(first.body)
  expect(spy).not.toHaveBeenCalled()
  expect(db.select().from(schema.eventCorrectionAudit).all()).toHaveLength(1)
})

it('public_unmarked_same_name_slot_keeps_legacy_sanitizer', async () => {
  // Protocol/mock control only: arbitrary same-name JSON is not a core-sealed typed slot.
  const core = await import('../../../server/utils/roster-event-correction')
  vi.spyOn(core, 'commitEventCorrections').mockReturnValue({
    qualificationReadbackProtocol: 'event-correction-407-v1',
    qualificationReadback: { stage: 'after', status: 'captured', token: 'synthetic-raw-secret', payload: 'token=synthetic-raw-value' },
    nested: { qualificationReadback: 'token=synthetic-nested-value' },
  })
  const result = handleEventCorrectionRequest({ action: 'commit', method: 'POST', body: { request: correction(), planHash: 'a'.repeat(64) },
    headers: { authorization: `Bearer ${TOKEN}` } }, { db, apiToken: TOKEN })
  expect(result.status).toBe(200)
  expect(result.body).toEqual({ qualificationReadbackProtocol: 'event-correction-407-v1', qualificationReadback: { stage: 'after', status: 'captured', payload: 'token=[REDACTED]' },
    nested: { qualificationReadback: 'token=[REDACTED]' } })
  expect(db.select().from(schema.eventCorrectionAudit).all()).toEqual([])
})

it('announcement_hash_recheck_keeps_existing_before_snapshot', async () => {
  const body: RosterImportRequest = {
    idempotencyKey: '407-announcement-hash-recheck', sourceKind: 'announcement', sourceIdentity: 'synthetic/hash-recheck',
    payload: { announcement: { sourceDocument: { source: 'jxj', title: document.title }, records: [{
      enterprise: { name: enterprise.name }, source: 'jxj', titleCode: 'innovative_sme',
      events: [{ eventType: 'award', year: 2024, decidedYear: 2024, batchSeq: 1, evidence: [{
        sourceFile: 'notice.txt', attachment: '附件2', listNo: 2, page: null, publishedRow: publishedRow('合成公布原名'),
      }] }],
    }] } },
  }
  const before = businessState()
  const first = await post('/api/roster/import/preflight', body)
  expect(first.status).toBe(200)
  expect(first.body.preflight.conflicts).toEqual([])
  expect(first.body.preflight.officialEvidencePlanHash).toMatch(/^[a-f0-9]{64}$/)
  expect(first.body.preflight.qualificationReadback).toMatchObject({ stage: 'before', status: 'captured', target: { enterpriseId: enterprise.id } })
  expectPublicCorrectionSnapshot(first.body.preflight.qualificationReadback.assessment)
  body.payload.officialEvidencePlanHash = first.body.preflight.officialEvidencePlanHash
  const spy = vi.spyOn(qualification, 'readCurrentQualificationAssessment')
  const repeated = await post('/api/roster/import/preflight', body)
  expect(repeated.status).toBe(200)
  expect(repeated.body.preflight.conflicts).toEqual([])
  expect(repeated.body.preflight.officialEvidencePlanHash).toBe(first.body.preflight.officialEvidencePlanHash)
  expect(businessState()).toEqual(before)
  expect(repeated.body.preflight.qualificationReadback).toEqual(first.body.preflight.qualificationReadback)
  expect(repeated.body.preflight.qualificationDiagnostics).toEqual(first.body.preflight.qualificationDiagnostics)
  expect(spy).toHaveBeenCalledTimes(1)
})
