import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as schema from '../db/schema'
import { TITLE_SEED } from '../db/titles'
import { getRosterEnterpriseDetail } from '../lib/roster/enterprise-roster'
import { readCurrentCandidate } from '../lib/roster/current-qualification'
import { reviewCurrentExportDecision } from './helpers/current-export-decisions'
import { saveDecision102 } from '../server/utils/decision-lifecycle-102'
import { preflightRecordCorrespondences, commitRecordCorrespondences, type CorrespondenceRequest } from '../server/utils/record-correspondence'
import * as correspondenceReads from '../server/utils/record-correspondence'
import * as publishedReads from '../lib/roster/official-published-presentation'
import { readEvidenceToken113 } from '../server/utils/evidence-impact-113'

const AS_OF = Date.parse('2026-06-01T00:00:00Z')
let sqlite: Database.Database
let db: ReturnType<typeof drizzle<typeof schema>>
beforeEach(() => {
  sqlite = new Database(':memory:')
  sqlite.pragma('foreign_keys = ON')
  db = drizzle(sqlite, { schema })
  migrate(db, { migrationsFolder: 'db/migrations' })
  db.insert(schema.title).values([...TITLE_SEED]).run()
})
afterEach(() => { vi.restoreAllMocks(); sqlite.close() })

function formalEnterprise() {
  const enterprise = db.insert(schema.enterprise).values({ name: '合成正式企业', nameNorm: '合成正式企业', usccNorm: '913302000000000001' }).returning().get()
  const record = db.insert(schema.record).values({ enterpriseId: enterprise.id, titleCode: 'innovative_sme', source: 'jxj', usccRaw: enterprise.usccNorm }).returning().get()
  const event = db.insert(schema.recordEvent).values({ recordId: record.id, eventType: 'award', year: 2025, batchSeq: 1, decidedYear: 2025 }).returning().get()
  const evidence = db.insert(schema.recordEvidence).values({ recordEventId: event.id, sourceFile: 'synthetic/official.pdf', listNo: 1 }).returning().get()
  return { enterprise, record, event, evidence }
}

it('binds detail assessment to stable identity cycle time and read-only fact versions', () => {
  const { enterprise } = formalEnterprise()
  const detail = getRosterEnterpriseDetail(db, enterprise.id, AS_OF)!
  expect(detail.qualificationAssessment).toMatchObject({
    enterpriseId: enterprise.id, asOf: '2026-06-01T00:00:00.000Z',
    titles: expect.arrayContaining([expect.objectContaining({
      titleCode: 'innovative_sme', group: 'eligible',
      cycles: [{ originYear: 2025, batchSeq: 1, precision: 'year' }],
    })]),
  })
})

function assessment(id: number, asOf = AS_OF, title = 'innovative_sme') {
  return getRosterEnterpriseDetail(db, id, asOf)!.qualificationAssessment.titles.find(t => t.titleCode === title)!
}

function observation(enterprise: typeof schema.enterprise.$inferSelect, status: 'success' | 'no_record' | 'failed', rowStatus: string | null = null, titleCode = 'innovative_sme', rdjb = '1') {
  const failed = status === 'failed'
  const query = db.insert(schema.platformQuery).values({
    interface: 'business_list', queryKey: enterprise.usccNorm!, rdjb, titleCode,
    queriedAt: '2026-05-01T00:00:00Z', status,
    collectionEvidence: {
      source: 'businessList', status, effectiveConditions: { uscc: enterprise.usccNorm!, combination: 'and' },
      titleScope: { mode: 'selected', rdjb: [rdjb] }, queriedAt: '2026-05-01T00:00:00Z', completedAt: '2026-05-01T00:00:01Z',
      rows: [], pages: failed ? [] : [{ source: 'businessList', rdjb, page: 1, status: 'success', fetchedCount: status === 'success' ? 1 : 0, declaredTotal: status === 'success' ? 1 : 0, error: null }],
      fetchedCount: status === 'success' ? 1 : 0, declaredTotal: failed ? null : status === 'success' ? 1 : 0,
      completeness: failed ? 'partial' : 'complete', fullRange: true,
      unfinished: failed ? [{ source: 'businessList', rdjb, page: 1 }] : [],
      error: failed ? { code: 'invalid_response', message: 'synthetic failed query' } : null,
      limits: { maxRequests: 100, maxRows: 5000, maxDurationMs: 60000, pageSize: 50 },
    },
  }).returning().get()
  const relation = status === 'success' ? db.insert(schema.platformRelation).values({
    queryId: query.id, sequenceNo: 1, enterpriseId: enterprise.id, usccRaw: enterprise.usccNorm,
    status: rowStatus, year: 2025, batch: '2025-1', matchBasis: 'uscc', verificationStatus: 'confirmed',
  }).returning().get() : null
  return { query, relation }
}

function subjectDecision(enterpriseId: number, reasonCode: 'deregistered' | 'moved_out' | 'moved_in' | 'other', titleCode = 'innovative_sme', direction = 'missing_in_miit', effectiveAt = '2026-01-01T00:00:00Z', confirmed = true) {
  const decision = db.insert(schema.differenceReason).values({
    enterpriseId, titleCode, direction: direction as 'missing_in_miit' | 'extra_in_miit',
    status: 'confirmed_reason', reasonCode, verificationStatus: confirmed ? 'confirmed' : 'pending',
    lifecycleAction: 'replace', basis: '独立合成主体证明', effectiveAt,
    recordedAt: '2026-01-02T00:00:00Z', measureCode: 'keep_history',
  }).returning().get()
  if (confirmed) reviewCurrentExportDecision(db, decision)
  return decision
}

it.each([
  { case: 'approved', queryStatus: 'success', rowStatus: '终审通过', platformStatus: 'requires_verification', coverage: 'complete', outcome: 'records' },
  { case: 'no-record', queryStatus: 'no_record', rowStatus: null, platformStatus: 'requires_verification', coverage: 'complete', outcome: 'no_record' },
  { case: 'returned', queryStatus: 'success', rowStatus: '退回', platformStatus: 'requires_verification', coverage: 'complete', outcome: 'records' },
  { case: 'not-approved', queryStatus: 'success', rowStatus: '不通过', platformStatus: 'requires_verification', coverage: 'complete', outcome: 'records' },
  { case: 'failed-query', queryStatus: 'failed', rowStatus: null, platformStatus: 'query_failed', coverage: 'failed', outcome: 'unknown' },
])('keeps formal qualification independent of platform observation: $case', ({ queryStatus, rowStatus, platformStatus, coverage, outcome }) => {
  const { enterprise } = formalEnterprise()
  const { query, relation } = observation(enterprise, queryStatus as 'success' | 'no_record' | 'failed', rowStatus)
  const value = assessment(enterprise.id)
  expect(value.group).toBe('eligible')
  expect(value.officialQualification.group).toBe('eligible')
  expect(value.platform).toMatchObject({ status: platformStatus, comparison: 'not_established', observations: [{ queryId: query.id, status: coverage, outcome, queryStatus, rows: relation ? [{ relationId: relation.id, status: rowStatus, year: 2025, batch: '2025-1' }] : [] }] })
  expect(value.correspondence.status).toBe('unmatched')
})

it('keeps not queried distinct from no record and legacy zero differences distinct from confirmation', () => {
  const { enterprise } = formalEnterprise()
  db.insert(schema.record).values({ enterpriseId: enterprise.id, titleCode: 'innovative_sme', source: 'miit', usccRaw: enterprise.usccNorm }).run()
  const detail = getRosterEnterpriseDetail(db, enterprise.id, AS_OF)!
  const value = detail.qualificationAssessment.titles.find(t => t.titleCode === 'innovative_sme')!
  expect(value.platform).toMatchObject({ status: 'not_queried', observations: [] })
  expect(value.officialQualification.group).toBe('eligible')
  expect(value.completeness.gaps).toContain('published_name_not_retained')
  expect(detail.enterprise.difference).toEqual({ count: 0, status: null, reasonCode: null, anyCurrent: false })
  expect(detail.titleAssessments.every(a => a.currentDecision.current === null)).toBe(true)
})

it.each([
  { case: 'confirmed-termination', reason: 'deregistered', group: 'excluded', subject: 'terminated', region: 'not_established' },
  { case: 'confirmed-move-out', reason: 'moved_out', group: 'excluded', subject: 'not_established', region: 'outside_ningbo' },
])('separates official qualification from subject and region: $case', ({ reason, group, subject, region }) => {
  const { enterprise } = formalEnterprise()
  const decision = subjectDecision(enterprise.id, reason as 'deregistered' | 'moved_out', 'specialized_sme')
  const value = assessment(enterprise.id)
  expect(value).toMatchObject({ group, officialQualification: { group: 'eligible' }, subject: { status: subject }, region: { status: region } })
  expect(value.references).toContain('decision:' + decision.id)
  expect(assessment(enterprise.id, AS_OF, 'little_giant').group).toBe('excluded')
})

it('does not resurrect terminated subject after return and preserves legacy shadow when another fact is unresolved', () => {
  const { enterprise } = formalEnterprise()
  subjectDecision(enterprise.id, 'deregistered')
  subjectDecision(enterprise.id, 'moved_in', 'specialized_sme', 'extra_in_miit', '2026-03-01T00:00:00Z')
  subjectDecision(enterprise.id, 'moved_out', 'little_giant', 'missing_in_miit', '2026-02-01T00:00:00Z', false)
  const value = assessment(enterprise.id)
  expect(value).toMatchObject({ group: 'excluded', subject: { status: 'terminated' }, officialQualification: { group: 'eligible' }, shadow: { legacyGroup: 'pending' } })
  expect(value.shadow.difference).toContain('主体终止优先排除')
})

it('withdraws a subject exclusion without deleting its history or changing official facts', () => {
  const { enterprise } = formalEnterprise()
  const decision = subjectDecision(enterprise.id, 'deregistered')
  const before = assessment(enterprise.id)
  saveDecision102(db, { enterpriseId: enterprise.id, titleCode: 'innovative_sme', direction: 'missing_in_miit',
    action: 'withdraw', expectedCurrentId: decision.id, idempotencyKey: 'synthetic-withdraw', actor: { type: 'agent', id: 'fixture' },
    basis: '原注销依据已明确撤回', ruleVersion: 'fixture', effectiveAt: '2026-03-01T00:00:00Z' })
  const after = assessment(enterprise.id)
  expect(before.group).toBe('excluded')
  expect(after).toMatchObject({ group: 'eligible', subject: { status: 'not_established' } })
  expect(after.versions.facts).toBe(before.versions.facts)
  expect(after.versions.decisions).not.toBe(before.versions.decisions)
  expect(db.select().from(schema.differenceReason).all()).toHaveLength(2)
})

it('replaces a terminated-subject decision in the same scope without deleting the old fact', () => {
  const { enterprise } = formalEnterprise()
  const previous = subjectDecision(enterprise.id, 'deregistered')
  const before = assessment(enterprise.id)
  const replacement = db.insert(schema.differenceReason).values({
    enterpriseId: enterprise.id, titleCode: 'innovative_sme', direction: 'missing_in_miit',
    status: 'confirmed_reason', reasonCode: 'moved_in', verificationStatus: 'confirmed',
    lifecycleAction: 'replace', previousId: previous.id, basis: '原注销事实已核实并由本决定替代',
    effectiveAt: '2026-03-01T00:00:00Z', recordedAt: '2026-03-02T00:00:00Z', measureCode: 'record_moved_in',
  }).returning().get()
  reviewCurrentExportDecision(db, replacement)
  const after = assessment(enterprise.id)
  expect(before.group).toBe('excluded')
  expect(after).toMatchObject({ group: 'eligible', subject: { status: 'not_established' }, region: { status: 'ningbo', decisionIds: [replacement.id] } })
  expect(after.versions.decisions).not.toBe(before.versions.decisions)
  expect(db.select().from(schema.differenceReason).all()).toHaveLength(2)
})

it.each([
  { case: 'future-query', queriedAt: '2027-01-01T00:00:00Z', applicability: 'after_as_of', status: 'not_queried' },
  { case: 'unknown-query-time', queriedAt: 'not-a-time', applicability: 'unknown_time', status: 'requires_verification' },
])('preserves observation time applicability without manufacturing absence: $case', ({ queriedAt, applicability, status }) => {
  const { enterprise } = formalEnterprise()
  const { query } = observation(enterprise, 'success', '退回')
  db.update(schema.platformQuery).set({ queriedAt }).where(eq(schema.platformQuery.id, query.id)).run()
  expect(assessment(enterprise.id)).toMatchObject({ group: 'eligible', platform: { status, comparison: 'not_established', observations: [{ queryId: query.id, queriedAt, applicability, rows: [{ status: '退回' }] }] } })
})

it('uses the later location decision without reviving a formally failed cycle', () => {
  const { enterprise, record } = formalEnterprise()
  const failed = db.insert(schema.recordEvent).values({ recordId: record.id, eventType: 'review', year: 2025, batchSeq: 1, decidedYear: 2026, reviewOutcome: 'failed' }).returning().get()
  db.insert(schema.recordEvidence).values({ recordEventId: failed.id, sourceFile: 'synthetic/failed.pdf' }).run()
  subjectDecision(enterprise.id, 'moved_out', 'specialized_sme')
  subjectDecision(enterprise.id, 'moved_in', 'little_giant', 'extra_in_miit', '2026-03-01T00:00:00Z')
  observation(enterprise, 'success', '终审通过')
  expect(assessment(enterprise.id)).toMatchObject({ group: 'excluded', officialQualification: { group: 'excluded' }, region: { status: 'ningbo' } })
})

it('keeps conflicting same-year original batches unresolved instead of selecting the passing one', () => {
  const { enterprise, record } = formalEnterprise()
  const other = db.insert(schema.recordEvent).values({ recordId: record.id, eventType: 'review', year: 2025, batchSeq: 2, decidedYear: 2026, reviewOutcome: 'failed' }).returning().get()
  db.insert(schema.recordEvidence).values({ recordEventId: other.id, sourceFile: 'synthetic/other-batch.pdf' }).run()
  expect(assessment(enterprise.id)).toMatchObject({ group: 'pending', cycles: [{ originYear: 2025, batchSeq: 1, precision: 'year' }, { originYear: 2025, batchSeq: 2, precision: 'year' }] })
})

it.each([
  { case: 'unknown-origin', year: null, batch: 1, group: 'pending' },
  { case: 'unknown-batch', year: 2025, batch: null, group: 'pending' },
  { case: 'known-renewal', year: 2025, batch: 1, group: 'eligible' },
])('preserves originating-cycle guards without broadening unknown batch rules: $case', ({ year, batch, group }) => {
  const { enterprise, record } = formalEnterprise()
  const review = db.insert(schema.recordEvent).values({ recordId: record.id, eventType: 'review', year, batchSeq: batch, decidedYear: 2026, reviewOutcome: 'passed' }).returning().get()
  db.insert(schema.recordEvidence).values({ recordEventId: review.id, sourceFile: 'synthetic/review.pdf' }).run()
  expect(assessment(enterprise.id).group).toBe(group)
})

it.each([
  { case: 'before-due-year', asOf: '2027-12-31T23:59:59.999Z', group: 'eligible' },
  { case: 'at-due-year', asOf: '2028-01-01T00:00:00Z', group: 'pending' },
])('retains year precision and does not invent a policy extension: $case', ({ asOf, group }) => {
  const { enterprise } = formalEnterprise()
  const value = assessment(enterprise.id, Date.parse(asOf))
  expect(value.group).toBe(group)
  expect(value.cycles).toEqual([{ originYear: 2025, batchSeq: 1, precision: 'year' }])
})

it('does not promote nurture or platform-only approval to formal qualification', () => {
  const { enterprise, event } = formalEnterprise()
  db.update(schema.recordEvent).set({ eventType: 'nurture' }).where(eq(schema.recordEvent.id, event.id)).run()
  observation(enterprise, 'success', '终审通过')
  expect(assessment(enterprise.id)).toMatchObject({ group: 'excluded', officialQualification: { group: 'excluded' } })
  db.delete(schema.recordEvidence).run()
  db.delete(schema.recordEvent).run()
  expect(assessment(enterprise.id)).toMatchObject({ group: 'pending', officialQualification: { group: 'pending' } })
})

it('keeps stable identity and titles separate through renaming and another title returning', () => {
  const { enterprise, record } = formalEnterprise()
  db.update(schema.record).set({ nameRaw: '旧公布名称' }).where(eq(schema.record.id, record.id)).run()
  db.insert(schema.enterpriseAlias).values({ enterpriseId: enterprise.id, name: '旧公布名称', nameNorm: '旧公布名称', sourceKind: 'manual', sourceRefId: 0, verificationStatus: 'confirmed' }).run()
  observation(enterprise, 'success', '退回', 'specialized_sme', '2')
  const value = assessment(enterprise.id)
  expect(value.group).toBe('eligible')
  expect(value.platform.status).toBe('not_queried')
  db.update(schema.record).set({ usccRaw: '913302000000000009' }).where(eq(schema.record.id, record.id)).run()
  expect(assessment(enterprise.id)).toMatchObject({ group: 'pending', completeness: { gaps: expect.arrayContaining(['identity_unresolved']) } })
})

it('versions corrections and source generations while confirmed correspondence requires revalidation', () => {
  const { enterprise, event, evidence } = formalEnterprise()
  const { relation } = observation(enterprise, 'success', '终审通过')
  const request: CorrespondenceRequest = { idempotencyKey: 'synthetic-edge', sourceIdentity: 'synthetic/source', actor: { type: 'agent', id: 'fixture' }, basis: '合成对应依据', ruleId: 'manual', ruleVersion: 'fixture',
    operations: [{ action: 'create', status: 'confirmed', edge: { type: 'event_process', eventId: event.id, relationId: relation!.id, role: 'context_only' } }] }
  const plan = preflightRecordCorrespondences(db, request)
  commitRecordCorrespondences(db, request, plan.planHash)
  const before = assessment(enterprise.id)
  expect(before.correspondence.status).toBe('confirmed')
  db.update(schema.recordEvent).set({ revision: 2 }).where(eq(schema.recordEvent.id, event.id)).run()
  const corrected = assessment(enterprise.id)
  expect(corrected).toMatchObject({ group: 'eligible', correspondence: { status: 'requires_revalidation' } })
  expect(corrected.evidence[0]).toMatchObject({ eventId: event.id, revision: 2, evidenceIds: [evidence.id] })
  expect(corrected.versions.facts).not.toBe(before.versions.facts)
  expect(corrected.versions.decisions).not.toBe(before.versions.decisions)
  db.insert(schema.storedFile).values({ relPath: 'synthetic/official.pdf', filename: 'official.pdf', ext: 'pdf', bytes: 10, sha256: 'a'.repeat(64) }).run()
  const versioned = assessment(enterprise.id)
  expect(versioned.versions.sources).not.toBe(corrected.versions.sources)
  expect(versioned.sourceVersions).toMatchObject([{ evidenceId: evidence.id, sha256: 'a'.repeat(64), capturedRevision: null }])
})

it('reads a deterministic snapshot under query-only SQLite and keeps legacy projections as an explicit shadow', () => {
  const { enterprise } = formalEnterprise()
  observation(enterprise, 'no_record')
  subjectDecision(enterprise.id, 'moved_out')
  const legacy = readCurrentCandidate(sqlite, enterprise.id, 'innovative_sme', 2026, AS_OF)
  const before = sqlite.prepare('select total_changes() as n').get()
  sqlite.pragma('query_only = ON')
  const first = getRosterEnterpriseDetail(db, enterprise.id, AS_OF)!
  const second = getRosterEnterpriseDetail(db, enterprise.id, AS_OF)!
  expect(first.qualificationAssessment).toEqual(second.qualificationAssessment)
  expect(first.qualificationAssessment.snapshotId).toMatch(/^[a-f0-9]{64}$/)
  expect(assessment(enterprise.id).shadow).toEqual({ legacyGroup: legacy.group, difference: null })
  expect(sqlite.prepare('select total_changes() as n').get()).toEqual(before)
  expect(sqlite.prepare('select count(*) as n from job').get()).toEqual({ n: 0 })
  expect(sqlite.prepare('select count(*) as n from difference_reason').get()).toEqual({ n: 1 })
  expect(sqlite.prepare('select count(*) as n from evidence_review_receipt_114').get()).toEqual({ n: 1 })
  expect(legacy.assessment).toBeUndefined()
})

it.each([
  { case: 'legacy-record-name-is-not-capture', recordName: '旧记录名', availability: 'unknown_legacy' as const, nameRaw: null, gap: 'published_name_not_retained' },
  { case: 'captured-name-without-record-name', recordName: null, availability: 'captured' as const, nameRaw: '实际公布名', gap: null },
  { case: 'captured-null-name', recordName: '旧记录名', availability: 'captured' as const, nameRaw: null, gap: 'published_name_unknown' },
])('uses per-evidence published facts for completeness: $case', ({ recordName, availability, nameRaw, gap }) => {
  const { enterprise, record, event, evidence } = formalEnterprise()
  db.update(schema.record).set({ nameRaw: recordName }).where(eq(schema.record.id, record.id)).run()
  const fact: publishedReads.OfficialPublishedFact = availability === 'captured'
    ? { evidenceId: evidence.id, eventId: event.id, availability, revision: 1, nameRaw, sourceBindingKnown: true }
    : { evidenceId: evidence.id, eventId: event.id, availability, revision: null, nameRaw: null, sourceBindingKnown: null }
  // Isolate the completeness consumer; capture/SQL semantics have their own public tests.
  vi.spyOn(publishedReads, 'readOfficialPublishedPresentation').mockReturnValue(new Map([[evidence.id, fact]]))
  const detail = getRosterEnterpriseDetail(db, enterprise.id, AS_OF)!
  const value = detail.qualificationAssessment.titles.find(t => t.titleCode === 'innovative_sme')!
  expect(detail.publishedPresentation).toMatchObject({ availability: 'available', facts: [fact] })
  expect(value.completeness.publishedNames).toEqual([{ evidenceId: evidence.id, availability, nameKnown: nameRaw !== null }])
  if (gap) expect(value.completeness.gaps).toContain(gap)
  else expect(value.completeness.gaps).not.toContain('published_name_not_retained')
})

it.each([false, true])('keeps verified migration qualification independent of later location: movedOut=%s', movedOut => {
  const enterprise = db.insert(schema.enterprise).values({ name: '独立迁入企业', nameNorm: '独立迁入企业', usccNorm: '913302000000000002' }).returning().get()
  const { query, relation } = observation(enterprise, 'success', '终审通过')
  const scope = { enterpriseId: enterprise.id, titleCode: 'innovative_sme' as const, direction: 'extra_in_miit' as const }
  saveDecision102(db, { ...scope, action: 'replace', expectedCurrentId: null, idempotencyKey: 'migration-qualified', actor: { type: 'agent', id: 'fixture' }, ruleVersion: 'fixture', basis: '已独立核实迁入及资格', effectiveAt: '2025-01-01T00:00:00Z', decision: {
    status: 'confirmed_reason', reasonCode: 'moved_in', measureCode: 'record_moved_in', verificationStatus: 'confirmed', evidenceQueryId: query.id, evidenceRelationId: relation!.id,
    currentQualification: { titleCode: 'innovative_sme', validFrom: '2025-01-01T00:00:00Z', validUntil: '2028-01-01T00:00:00Z', basis: '独立核实的称号资格', publicationCheck: { status: 'not_found', scope: '宁波本称号公开名单' } },
  } })
  const current = db.select().from(schema.differenceReason).get()!
  const token = readEvidenceToken113(db, scope)
  saveDecision102(db, { ...scope, action: 'maintain', expectedCurrentId: current.id, idempotencyKey: 'migration-reviewed', actor: { type: 'agent', id: 'fixture' }, ruleVersion: 'fixture', basis: '已复核独立资格依据', effectiveAt: '2025-01-01T00:00:00Z', reviewedEvidence: { latestRevisionId: token.latestRevisionId, projectionReady: true } })
  if (movedOut) subjectDecision(enterprise.id, 'moved_out', 'specialized_sme', 'missing_in_miit', '2026-03-01T00:00:00Z')
  const value = assessment(enterprise.id)
  expect(value).toMatchObject({ group: movedOut ? 'excluded' : 'eligible', officialQualification: { group: 'eligible' }, region: { status: movedOut ? 'outside_ningbo' : 'ningbo' } })
  expect(value.officialQualification.basis).toContain('独立核实的称号资格')
  expect(value.officialQualification.notes).not.toContain('缺少已确认认定及资格依据')
})

it('keeps published-name read failure distinct from missing capture and reuses one read', () => {
  const { enterprise, evidence } = formalEnterprise()
  const read = vi.spyOn(publishedReads, 'readOfficialPublishedPresentation').mockImplementation(() => { throw new publishedReads.OfficialPublishedPresentationError('response_limit') })
  const detail = getRosterEnterpriseDetail(db, enterprise.id, AS_OF)!
  const value = detail.qualificationAssessment.titles.find(t => t.titleCode === 'innovative_sme')!
  expect(detail.publishedPresentation).toMatchObject({ availability: 'unavailable', error: 'response_limit' })
  expect(value.completeness.publishedNames).toEqual([{ evidenceId: evidence.id, availability: 'unavailable', nameKnown: false }])
  expect(value.completeness.gaps).toContain('published_name_read_unavailable')
  expect(value.completeness.gaps).not.toContain('published_name_not_retained')
  expect(value.group).toBe('eligible')
  expect(read).toHaveBeenCalledTimes(1)
})

it('does not claim changed sources when correspondence revalidation is incomplete', () => {
  const { enterprise, event } = formalEnterprise()
  const { relation } = observation(enterprise, 'success', '终审通过')
  const request: CorrespondenceRequest = { idempotencyKey: 'unchanged-edge', sourceIdentity: 'synthetic/source', actor: { type: 'agent', id: 'fixture' }, basis: '合成对应依据', ruleId: 'manual', ruleVersion: 'fixture', operations: [{ action: 'create', status: 'confirmed', edge: { type: 'event_process', eventId: event.id, relationId: relation!.id, role: 'context_only' } }] }
  commitRecordCorrespondences(db, request, preflightRecordCorrespondences(db, request).planHash)
  const refs = correspondenceReads.listRecordCorrespondenceRefs(db, { enterpriseId: enterprise.id, titleCode: 'innovative_sme' })
  vi.spyOn(correspondenceReads, 'listRecordCorrespondenceRefs').mockReturnValue(refs.map(ref => ({ ...ref, requiresRevalidation: true })))
  const value = assessment(enterprise.id)
  expect(value.correspondence.status).toBe('requires_revalidation')
  expect(value.correspondence.message).not.toContain('来源变化')
  expect(value.group).toBe('eligible')
})

// #407 additive detail controls. All preceding #406 test bytes remain frozen.
import { createHash } from 'node:crypto'
import { diagnoseOfficialEventFields, readCurrentQualificationAssessment } from '../lib/roster/current-qualification'

it('field_gaps_review_raw_states_407', () => {
  // Pure field helper assertion; the shared file fixture is not qualification evidence here.
  expect(diagnoseOfficialEventFields({ eventType: 'review', year: null, decidedYear: '  ', reviewOutcome: null })).toEqual({
    values: { year: null, decidedYear: '  ', batchSeq: null, reviewOutcome: null },
    fieldGaps: [
      { field: 'year', valueState: 'unknown', inputState: 'null' },
      { field: 'decidedYear', valueState: 'blank', inputState: 'provided' },
      { field: 'batchSeq', valueState: 'unknown', inputState: 'omitted' },
      { field: 'reviewOutcome', valueState: 'unknown', inputState: 'null' },
    ],
  })
})

it('field_gaps_award_keeps_legacy_fallback_407', () => {
  const { enterprise, event } = formalEnterprise()
  db.update(schema.recordEvent).set({ decidedYear: null, batchSeq: null }).where(eq(schema.recordEvent.id, event.id)).run()
  const value = assessment(enterprise.id)
  expect(value).toMatchObject({ group: 'eligible', cycles: [{ originYear: 2025, batchSeq: null, precision: 'year' }],
    evidence: [{ eventId: event.id, eventType: 'award', year: 2025, decidedYear: null, batchSeq: null, reviewOutcome: null }] })
  expect(value.completeness.fieldGaps).toEqual([
    { eventId: event.id, field: 'decidedYear', valueState: 'unknown', inputState: 'null' },
    { eventId: event.id, field: 'batchSeq', valueState: 'unknown', inputState: 'null' },
  ])
  expect(readCurrentCandidate(sqlite, enterprise.id, 'innovative_sme', 2026, AS_OF).group).toBe('eligible')
})

it('field_gaps_nonreview_keeps_groups_407', () => {
  const { enterprise, event } = formalEnterprise()
  db.update(schema.recordEvent).set({ eventType: 'nurture', decidedYear: null, batchSeq: null }).where(eq(schema.recordEvent.id, event.id)).run()
  const nurture = assessment(enterprise.id)
  expect(nurture).toMatchObject({ group: 'excluded', officialQualification: { group: 'excluded' }, subject: { status: 'not_established' } })
  expect(nurture.completeness.fieldGaps).toEqual([])
  expect(readCurrentCandidate(sqlite, enterprise.id, 'innovative_sme', 2026, AS_OF).group).toBe('excluded')
  db.update(schema.recordEvent).set({ eventType: 'maintain' }).where(eq(schema.recordEvent.id, event.id)).run()
  const maintain = assessment(enterprise.id)
  expect(maintain).toMatchObject({ group: 'pending', subject: { status: 'not_established' } })
  expect(maintain.completeness.fieldGaps).toEqual([])
  expect(readCurrentCandidate(sqlite, enterprise.id, 'innovative_sme', 2026, AS_OF).group).toBe('pending')
})

it('detail_snapshot_scope_and_field_gaps_407', () => {
  const { enterprise, event } = formalEnterprise()
  db.update(schema.recordEvent).set({ eventType: 'review', year: null, decidedYear: null, batchSeq: null, reviewOutcome: null }).where(eq(schema.recordEvent.id, event.id)).run()
  const before = sqlite.prepare('select total_changes() as n').get()
  sqlite.pragma('query_only = ON')
  // Both are real API/MCP-shared function seams, not a started transport or historical-asOf API.
  const shared = readCurrentQualificationAssessment(sqlite, enterprise.id, AS_OF)
  const detail = getRosterEnterpriseDetail(db, enterprise.id, AS_OF)!
  const scope = { enterpriseId: enterprise.id, asOf: '2026-06-01T00:00:00.000Z', ruleVersion: 'current-roster-116-v8', assessmentVersion: 'enterprise-qualification-407-v1' }
  expect(detail.qualificationAssessment).toEqual(shared)
  expect(shared).toMatchObject(scope)
  expect(shared.titles.map(title => title.titleCode).sort()).toEqual(['innovative_sme', 'little_giant', 'specialized_sme'])
  expect(shared.snapshotId).toMatch(/^[a-f0-9]{64}$/)
  expect(shared.snapshotId).toBe(createHash('sha256').update(JSON.stringify([scope, shared.titles])).digest('hex'))
  for (const title of shared.titles) expect(title.versions).toEqual({
    facts: expect.stringMatching(/^[a-f0-9]{64}$/), sources: expect.stringMatching(/^[a-f0-9]{64}$/),
    decisions: expect.stringMatching(/^[a-f0-9]{64}$/), observations: expect.stringMatching(/^[a-f0-9]{64}$/),
  })
  const review = shared.titles.find(title => title.titleCode === 'innovative_sme')
  if (!review) throw new Error('Synthetic innovative assessment required')
  expect(review.group).toBe('pending')
  expect(review.completeness.fieldGaps).toEqual([
    { eventId: event.id, field: 'year', valueState: 'unknown', inputState: 'null' },
    { eventId: event.id, field: 'decidedYear', valueState: 'unknown', inputState: 'null' },
    { eventId: event.id, field: 'batchSeq', valueState: 'unknown', inputState: 'null' },
    { eventId: event.id, field: 'reviewOutcome', valueState: 'unknown', inputState: 'null' },
  ])
  expect(readCurrentCandidate(sqlite, enterprise.id, 'innovative_sme', 2026, AS_OF).group).toBe('pending')
  expect(sqlite.prepare('select total_changes() as n').get()).toEqual(before)
})
