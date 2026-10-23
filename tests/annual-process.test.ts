import { expect, it } from 'vitest'
import { buildAnnualProcess, type AnnualProcessEvent } from '../lib/roster/annual-process'
import type { PlatformBusinessGroup, PlatformBusinessObservationRef } from '../lib/platform/business-record'

const event: AnnualProcessEvent = { id: 1, eventType: 'award', year: 2024, decidedYear: null, reviewOutcome: null, record: { enterpriseId: 1, titleCode: 'specialized_sme', usccRaw: '91330211255994457P' } }
function group(id: number, facts: Record<string, unknown> = {}, overrides: Partial<PlatformBusinessObservationRef> = {}): PlatformBusinessGroup {
  const metadata = { recordId: id, versionId: id, interface: 'apply_list', platformKey: `SQ-${id}`, groupState: 'verified', identityState: 'resolved', contentState: 'verified', keySource: 'both', projectionRuleVersion: '1', hashAlgorithm: 'sha256', contentHash: `hash-${id}` } as const
  const observation: PlatformBusinessObservationRef = { relationId: id, queryId: id, sequenceNo: 1, interface: 'apply_list', relationKey: `SQ-${id}`, queriedAt: '2026-10-01T00:00:00Z', queryStatus: 'success', queryKey: event.record.usccRaw!, rdjb: '2', queryTitleCode: 'specialized_sme', titleCode: 'specialized_sme', enterpriseId: 1, usccRaw: event.record.usccRaw, nameRaw: '合成企业', verificationStatus: 'confirmed', matchBasis: 'uscc', target: { eventId: 1, enterpriseId: 1, titleCode: 'specialized_sme', type: 'event_process', role: 'context_only' }, evidence: { process: { declareKind: 'apply', appliedAt: '2024-03-01 09:00:00', status: '终审通过', normalizationConflicts: [], ...facts }, temporal: { relationYear: 2024, ...facts }, source: { identityOnly: false } }, conflicts: [], businessRecord: metadata, existingCorrespondenceIds: [], existingCorrespondences: [], ...overrides }
  return { businessRecord: observation.businessRecord, representativeRelationId: id, observationRefs: [observation], existingCorrespondenceIds: observation.existingCorrespondenceIds, existingCorrespondences: observation.existingCorrespondences, conflicts: [] }
}
const read = (groups: PlatformBusinessGroup[], e = event) => buildAnnualProcess({ event: e, groups, coverage: [] })

it('keeps the complete annual process and chooses the last application only as an unconfirmed final candidate', () => {
  const result = read([group(1, { status: '终审不通过' }), group(2, { appliedAt: '2024-12-13 10:00:00' })])
  expect(result.steps).toHaveLength(2)
  expect(result.steps.map(s => [s.status, s.annualEligible])).toEqual([['终审不通过', true], ['终审通过', true]])
  expect(result.latestStepId).toBe(result.steps[1]!.id)
  expect(result.finalCandidateStepId).toBe(result.steps[1]!.id)
  expect(result.steps[1]!.groups[0]!.observationRefs[0]!.existingCorrespondences).toEqual([])
  expect(result).not.toHaveProperty('finalStepId')
})

it('never searches back to an earlier pass when the year ends returned or failed', () => {
  for (const status of ['终审不通过', '已退回待审核', '新状态']) {
    const result = read([group(1), group(2, { status, appliedAt: '2024-12-13 10:00:00' })])
    expect(result.latestStepId).toBe(result.steps[1]!.id)
    expect(result.finalCandidateStepId).toBeNull()
    expect(result.reasons).toContain(status === '终审不通过' ? 'official_result_mismatch' : 'latest_status_not_terminal')
  }
})

it('deduplicates observations across versions and uses observation time for an A B A return', () => {
  const a = group(1), b = group(2, { status: '已退回待审核' }), again = group(3)
  b.observationRefs[0]!.businessRecord = { ...b.businessRecord, recordId: 1 }
  b.businessRecord = b.observationRefs[0]!.businessRecord
  again.observationRefs[0]!.businessRecord = a.businessRecord
  again.businessRecord = a.businessRecord
  a.observationRefs[0]!.queriedAt = '2026-10-01T00:00:00Z'
  b.observationRefs[0]!.queriedAt = '2026-10-02T00:00:00Z'
  again.observationRefs[0]!.queriedAt = '2026-10-03T00:00:00Z'
  a.observationRefs.push(again.observationRefs[0]!)
  const result = read([b, a])
  expect(result.steps).toHaveLength(1)
  expect(result.steps[0]).toMatchObject({ status: '终审通过', latestObservationRelationIds: [3], groups: expect.any(Array) })
  expect(result.steps[0]!.groups).toHaveLength(2)
  expect(result.finalCandidateStepId).toBe(result.steps[0]!.id)
})

it('isolates owner title explicit year and apply review update before yearly qualification', () => {
  const others = [group(2, { declareKind: 'review' }), group(3, { declareKind: 'update' }), group(4, { relationYear: 2025 }), group(5, {}, { titleCode: 'innovative_sme' }), group(6, {}, { enterpriseId: 2, usccRaw: '91330211790043112T' })]
  expect(read([group(1), ...others]).steps.map(s => s.groups[0]!.representativeRelationId)).toEqual([1])
})

it('requires the review conclusion year and outcome without borrowing the original award year', () => {
  const review: AnnualProcessEvent = { ...event, eventType: 'review', year: 2021, decidedYear: null }
  const missingYear = read([group(1, { declareKind: 'review' })], review)
  expect(missingYear).toMatchObject({ businessYear: null, latestStepId: null, finalCandidateStepId: null })
  expect(missingYear.reasons).toContain('official_business_year_missing')
  const missingResult = read([group(1, { declareKind: 'review' })], { ...review, decidedYear: 2024 })
  expect(missingResult.businessYear).toBe(2024)
  expect(missingResult.latestStepId).not.toBeNull()
  expect(missingResult.finalCandidateStepId).toBeNull()
  expect(missingResult.reasons).toContain('official_result_missing')
  expect(read([group(1, { declareKind: 'review', status: '终审不通过' })], { ...review, decidedYear: 2024, reviewOutcome: 'failed' }).finalCandidateStepId).not.toBeNull()
})

it('blocks fallback past a potentially newer business with missing year kind or application time', () => {
  for (const facts of [{ relationYear: null }, { declareKind: null }, { appliedAt: null }]) {
    const result = read([group(1), group(2, { appliedAt: '2024-12-13 10:00:00', ...facts })])
    expect(result.steps).toHaveLength(2)
    expect(result.latestStepId).toBeNull()
    expect(result.finalCandidateStepId).toBeNull()
    expect(result.reasons).toContain('potential_later_business_unresolved')
  }
})

it('preserves unknown business identities and excludes only explicitly proven name transcriptions', () => {
  const unknown = group(2, { relationYear: null, declareKind: null, appliedAt: null, status: null }, { relationKey: null })
  unknown.businessRecord = { ...unknown.businessRecord, recordId: null, versionId: null, platformKey: null, groupState: 'not_indexed', identityState: 'not_indexed', contentState: 'not_indexed' }
  unknown.observationRefs[0]!.businessRecord = unknown.businessRecord
  const identityOnly = structuredClone(unknown)
  identityOnly.observationRefs[0]!.evidence.source = { identityOnly: true }
  expect(read([group(1), unknown]).finalCandidateStepId).toBeNull()
  expect(read([group(1), identityOnly]).steps).toHaveLength(1)
  expect(read([group(1), identityOnly]).excludedIdentityRelationIds).toEqual([2])
})

it('does not break ties using row IDs or skip a newer conflicting observation', () => {
  expect(read([group(1), group(2)]).reasons).toContain('latest_application_time_tied')
  const a = group(1), b = group(2, { status: '终审不通过' })
  b.observationRefs[0]!.businessRecord = a.businessRecord
  b.businessRecord = a.businessRecord
  const tied = read([a, b])
  expect(tied.steps).toHaveLength(1)
  expect(tied.finalCandidateStepId).toBeNull()
  expect(tied.steps[0]!.reasons).toContain('latest_observation_conflict')
  b.observationRefs[0]!.queriedAt = '2026-10-02T00:00:00Z'
  b.observationRefs[0]!.evidence.process = { declareKind: 'apply', appliedAt: '2024-03-01 09:00:00', status: null, normalizationConflicts: [{ field: 'status', storedValue: '终审通过', rawValue: '终审不通过' }] }
  expect(read([a, b]).finalCandidateStepId).toBeNull()
})

it('corroborates missing explicit year across interfaces without merging record IDs or copying decisions', () => {
  const a = group(1), b = group(2, { relationYear: null }, { interface: 'business_list', relationKey: 'SQ-1' })
  b.businessRecord = { ...b.businessRecord, interface: 'business_list', platformKey: 'SQ-1' }
  b.observationRefs[0]!.businessRecord = b.businessRecord
  const decision = { id: 9, relationId: 1, eventId: 1, type: 'event_process', role: 'context_only', status: 'confirmed' } as any
  a.observationRefs[0]!.existingCorrespondences = [decision]
  a.observationRefs[0]!.existingCorrespondenceIds = [9]
  const result = read([a, b])
  expect(result.steps).toHaveLength(1)
  expect(result.steps[0]!.groups.map(g => [g.businessRecord.interface, g.businessRecord.recordId])).toEqual([['apply_list', 1], ['business_list', 2]])
  expect(result.steps[0]!.groups[1]!.observationRefs[0]!.existingCorrespondences).toEqual([])
  expect(result.steps[0]!.corroboratedFields).toContain('year')
  expect(result.finalCandidateStepId).toBe(result.steps[0]!.id)
  b.observationRefs[0]!.evidence.process = { declareKind: 'apply', appliedAt: '2024-04-01 09:00:00', status: '终审通过', normalizationConflicts: [] }
  expect(read([a, b]).steps).toHaveLength(2)
  expect(read([a, b]).finalCandidateStepId).toBeNull()
})

it('keeps historical partial and failed coverage without claiming completeness or blocking later complete facts', () => {
  const coverage = [
    { queryId: 1, interface: 'apply_list', queriedAt: '2026-09-01T00:00:00Z', status: 'failed', completeness: null, fullRange: null },
    { queryId: 2, interface: 'apply_list', queriedAt: '2026-10-01T00:00:00Z', status: 'success', completeness: null, fullRange: null },
  ]
  const legacy = buildAnnualProcess({ event, groups: [group(1)], coverage })
  expect(legacy.finalCandidateStepId).not.toBeNull()
  expect(legacy.coverage).toEqual(coverage)
  expect(legacy.coverageReasons).toEqual(['archive_failed', 'archive_range_unknown'])
  for (const adverse of [{ status: 'partial', completeness: 'partial', fullRange: false }, { status: 'failed', completeness: null, fullRange: null }]) {
    const result = buildAnnualProcess({ event, groups: [group(1)], coverage: [...coverage, { queryId: 3, interface: 'apply_list', queriedAt: '2026-10-02T00:00:00Z', ...adverse }] })
    expect(result.latestStepId).not.toBeNull()
    expect(result.finalCandidateStepId).toBeNull()
    expect(result.reasons).toContain('latest_archive_incomplete')
  }
})

it('retains missing latest status and observation timestamps rather than silently selecting an older observation', () => {
  const a = group(1), b = group(2, { status: null })
  b.businessRecord = a.businessRecord; b.observationRefs[0]!.businessRecord = a.businessRecord
  b.observationRefs[0]!.queriedAt = '2026-10-02T00:00:00Z'
  const result = read([a, b])
  expect(result.steps[0]).toMatchObject({ status: null, latestObservationRelationIds: [2] })
  expect(result.finalCandidateStepId).toBeNull()
  b.observationRefs[0]!.queriedAt = 'unknown'
  const unknown = read([a, b])
  expect(unknown.finalCandidateStepId).toBeNull()
  expect(unknown.steps[0]!.reasons).toContain('observation_time_unknown')
})

it('does not corroborate across identity title or stable-fact conflicts and preserves raw conflict evidence', () => {
  for (const changed of [{ usccRaw: '91330211790043112T' }, { titleCode: 'innovative_sme' }]) {
    const peer = group(2, { relationYear: null }, { interface: 'business_list', relationKey: 'SQ-1', ...changed })
    peer.businessRecord = { ...peer.businessRecord, platformKey: 'SQ-1', interface: 'business_list' }; peer.observationRefs[0]!.businessRecord = peer.businessRecord
    expect(read([group(1), peer]).steps[0]!.groups).toHaveLength(1)
    expect(read([group(1), peer]).steps[0]!.corroborationRefs).toEqual([])
  }
  const conflict = group(2, { appliedAt: null, normalizationConflicts: [{ field: 'appliedAt', storedValue: '2024-04-01', rawValue: '2024-05-01' }] })
  const result = read([group(1), conflict])
  expect(result.latestStepId).toBeNull()
  expect(result.steps[1]!.groups[0]!.observationRefs[0]!.evidence.process).toMatchObject({ normalizationConflicts: [{ field: 'appliedAt', storedValue: '2024-04-01', rawValue: '2024-05-01' }] })
})

it('reports empty and unsupported formal event scopes without inventing a final outcome', () => {
  expect(read([])).toMatchObject({ steps: [], latestStepId: null, finalCandidateStepId: null, reasons: ['no_annual_process'] })
  const unsupported = read([group(1)], { ...event, eventType: 'maintain' })
  expect(unsupported.finalCandidateStepId).toBeNull()
  expect(unsupported.reasons).toContain('official_event_type_unsupported')
})

it('chooses an explicit-title business observation only when it belongs to the selected latest version', () => {
  const old = group(1, {}, { interface: 'business_list', queryTitleCode: 'specialized_sme' })
  const later = group(2, { status: '终审通过' }, { interface: 'business_list', queriedAt: '2026-10-02T00:00:00Z', queryTitleCode: 'specialized_sme' })
  later.businessRecord = { ...later.businessRecord, recordId: 1 }; later.observationRefs[0]!.businessRecord = later.businessRecord
  const result = read([old, later])
  expect(result.steps[0]!.preferredWriteRelationId).toBe(2)
  expect(result.steps[0]!.latestVersionRefs).toEqual([{ interface: 'business_list', recordId: 1, versionId: 2, relationIds: [2] }])
  later.observationRefs[0]!.queryTitleCode = null; later.observationRefs[0]!.rdjb = ''
  expect(read([old, later]).steps[0]!.preferredWriteRelationId).toBeNull()
})

it('does not treat a provably earlier incomplete business as a competing later application', () => {
  const result = read([group(1, { relationYear: null, appliedAt: '2024-01-01 09:00:00' }), group(2, { appliedAt: '2024-12-13 10:00:00' })])
  expect(result.steps[0]!.reasons).toContain('platform_year_missing')
  expect(result.steps[0]!.annualEligible).toBe(false)
  expect(result.finalCandidateStepId).toBe(result.steps[1]!.id)
})

it('orders explicit offset observation times by their instants while keeping original timestamp text', () => {
  const a = group(1, { status: '终审不通过' }, { queriedAt: '2026-10-02T07:00:00+08:00' }), b = group(2, {}, { queriedAt: '2026-10-02T00:00:00Z' })
  b.businessRecord = a.businessRecord; b.observationRefs[0]!.businessRecord = a.businessRecord
  const result = read([a, b])
  expect(result.steps[0]!.latestObservationRelationIds).toEqual([2])
  expect(result.steps[0]!.observedAt).toBe('2026-10-02T00:00:00Z')
  expect(result.finalCandidateStepId).not.toBeNull()
})

it('selects each interface latest matching version while keeping global latest fact provenance and an explicit business endpoint', () => {
  const business = group(1, {}, { interface: 'business_list', queriedAt: '2026-10-01T00:00:00Z' })
  business.businessRecord = { ...business.businessRecord, interface: 'business_list' }; business.observationRefs[0]!.businessRecord = business.businessRecord
  const apply = group(2, {}, { relationKey: 'SQ-1', queriedAt: '2026-10-02T00:00:00Z' })
  apply.businessRecord = { ...apply.businessRecord, platformKey: 'SQ-1' }; apply.observationRefs[0]!.businessRecord = apply.businessRecord
  const result = read([business, apply]), step = result.steps[0]!
  expect(result.steps).toHaveLength(1)
  expect(step.latestObservationRelationIds).toEqual([2])
  expect(step.latestVersionRefs.map(r => [r.interface, r.versionId])).toEqual([['business_list', 1], ['apply_list', 2]])
  expect(step.preferredWriteRelationId).toBe(1)
  business.observationRefs[0]!.evidence.process = { declareKind: 'apply', appliedAt: '2024-03-01 09:00:00', status: '终审不通过', normalizationConflicts: [] }
  const changed = read([business, apply]).steps[0]!
  expect(changed.latestVersionRefs.map(r => r.interface)).toEqual(['apply_list'])
  expect(changed.preferredWriteRelationId).toBeNull()
})

it('does not mutate shared groups observations or their original decisions', () => {
  const groups = [group(1), group(2, { appliedAt: '2024-12-13 10:00:00' })]
  const before = structuredClone(groups)
  read(groups)
  expect(groups).toEqual(before)
})
