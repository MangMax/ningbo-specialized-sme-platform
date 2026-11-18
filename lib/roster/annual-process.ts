import { normalizeUscc } from '../../layers/sme-roster/lib/domain'
import type { PlatformBusinessGroup, PlatformBusinessObservationRef, PlatformCorrespondenceRef } from '../../layers/sme-roster/lib/platform/business-record'
import type { EventSource } from './correspondence-view'

export const ANNUAL_PROCESS_RULE_VERSION = 'annual-process-250-v1'
export type AnnualProcessEvent = Pick<EventSource, 'id' | 'eventType' | 'year' | 'decidedYear' | 'reviewOutcome'> & {
  record: Pick<EventSource['record'], 'enterpriseId' | 'titleCode' | 'usccRaw'>
}
export interface AnnualProcessCoverage {
  queryId: number
  interface: string
  queriedAt: string
  status: string
  /** Legacy success has unknown range proof; it is not reported as complete. */
  completeness: string | null
  fullRange: boolean | null
}
export interface AnnualProcessStep {
  id: string
  businessKey: string | null
  /** Official original award year (`record_event.year`), also on review events. */
  awardYear: number | null
  /** Official review conclusion year (`record_event.decided_year`); null for awards/unknown. */
  decisionYear: number | null
  year: number | null
  declareKind: string | null
  /** Application time, never approval/completion time. */
  appliedAt: string | null
  status: string | null
  observedAt: string | null
  annualEligible: boolean
  reasons: string[]
  groups: PlatformBusinessGroup[]
  latestObservationRelationIds: number[]
  /** Each interface's latest version corroborating the selected logical state; never an older different state. */
  latestVersionRefs: Array<{ interface: string; recordId: number | null; versionId: number | null; relationIds: number[] }>
  /** One latest business_list observation with explicit title, if available. No confirmation implied. */
  preferredWriteRelationId: number | null
  corroboratedFields: string[]
  corroborationRefs: Array<{ field: string; fromRelationIds: number[]; toRelationIds: number[] }>
}
export interface AnnualFinalQualification {
  stepId: string | null
  status: 'confirmed' | 'eligible' | 'blocked' | 'none'
  reasons: string[]
  decisionRefs: PlatformCorrespondenceRef[]
}
export interface AnnualProcessScopeGap { relationId: number; queryId: number; interface: string; year: number | null; declareKind: string | null; appliedAt: string | null; reasons: string[] }
export interface EventAnnualProcess {
  event: AnnualProcessEvent
  ruleVersion: string
  businessYear: number | null
  declareKind: 'apply' | 'review' | null
  steps: AnnualProcessStep[]
  latestStepId: string | null
  latestStepSummary: Pick<AnnualProcessStep, 'id' | 'year' | 'declareKind' | 'appliedAt' | 'status' | 'observedAt'> | null
  /** Fact qualification only. Neither confirmed correspondence nor a persisted final mark. */
  finalCandidateStepId: string | null
  reasons: string[]
  coverage: AnnualProcessCoverage[]
  coverageReasons: string[]
  excludedIdentityRelationIds: number[]
  scopeGaps?: AnnualProcessScopeGap[]
  /** Enriched by #251's current-source/current-decision reader, never preflight on GET. */
  finalQualification?: AnnualFinalQualification
}
export interface AnnualProcessInput { event: AnnualProcessEvent; groups: PlatformBusinessGroup[]; coverage: AnnualProcessCoverage[]; scopeGaps?: AnnualProcessScopeGap[] }

type Ref = PlatformBusinessObservationRef
const object = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}
const text = (v: unknown) => typeof v === 'string' && v.trim() ? v.trim() : null
const unique = <T>(values: T[]) => [...new Set(values)]
const fact = (ref: Ref) => {
  const p = object(ref.evidence.process), t = object(ref.evidence.temporal)
  return {
    year: typeof t.relationYear === 'number' && Number.isSafeInteger(t.relationYear) && t.relationYear > 0 ? t.relationYear : null,
    declareKind: text(p.declareKind), appliedAt: text(p.appliedAt), status: text(p.status),
    province: text(p.province), batch: text(t.relationBatch), awardBatchLabel: text(t.awardBatchLabel),
    normalizationConflicts: Array.isArray(p.normalizationConflicts) ? p.normalizationConflicts : [],
  }
}
/** Parse platform wall-clock application times deterministically, without host timezone inference. */
function time(value: string | null): number | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)?$/.test(value)) return null
  const canonical = value.replace(' ', 'T')
  const parsed = Date.parse(canonical.length === 10 ? canonical + 'T00:00:00Z' : /(?:Z|[+-]\d{2}:\d{2})$/.test(canonical) ? canonical : canonical + 'Z')
  const date = Date.parse(value.slice(0, 10) + 'T00:00:00Z')
  return Number.isFinite(parsed) && Number.isFinite(date) && new Date(date).toISOString().slice(0, 10) === value.slice(0, 10) ? parsed : null
}
function observationTime(value: string) {
  return /(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? time(value) : null
}
function identityOnly(ref: Ref) {
  const f = fact(ref)
  return object(ref.evidence.source).identityOnly === true && !ref.relationKey && !ref.businessRecord.platformKey && !f.declareKind && !f.appliedAt && !f.status && !f.normalizationConflicts.length
}
function interfaceKey(ref: Ref) {
  const m = ref.businessRecord
  // Unindexed/unknown rows retain original identity. A textual key is not a verified record ID.
  return m.groupState === 'verified' && m.recordId != null ? JSON.stringify([ref.interface, m.recordId]) : JSON.stringify([ref.interface, 'relation', ref.relationId])
}
const stableFields = ['year', 'declareKind', 'appliedAt', 'province', 'batch', 'awardBatchLabel'] as const
function canCorroborate(a: Ref[], b: Ref[]) {
  if (a[0]!.interface === b[0]!.interface || [...a, ...b].some(r => r.businessRecord.groupState !== 'verified')) return false
  const all = [...a, ...b]
  const codes = unique(all.map(r => normalizeUscc(r.usccRaw)))
  const keys = unique(all.map(r => r.businessRecord.platformKey ?? r.relationKey))
  if (codes.length !== 1 || !codes[0] || keys.length !== 1 || !keys[0]) return false
  if (unique(all.map(r => r.titleCode)).length !== 1 || unique(all.map(r => r.target.enterpriseId)).length !== 1) return false
  if (all.some(r => fact(r).normalizationConflicts.length || r.conflicts.length)) return false
  // Kind and application time must be explicitly established on both interfaces.
  if ([a, b].some(rs => !rs.some(r => fact(r).declareKind) || !rs.some(r => time(fact(r).appliedAt) != null))) return false
  return stableFields.every(field => unique(all.map(r => fact(r)[field]).filter(v => v != null)).length <= 1)
}
function buildStep(groups: PlatformBusinessGroup[]): AnnualProcessStep {
  const refs = unique(groups.flatMap(g => g.observationRefs)).sort((a, b) => a.relationId - b.relationId)
  const values = <K extends typeof stableFields[number]>(field: K) => unique(refs.map(r => fact(r)[field]).filter(v => v != null))
  const one = <K extends typeof stableFields[number]>(field: K) => values(field).length === 1 ? values(field)[0]! : null
  const reasons: string[] = []
  for (const field of stableFields) if (values(field).length > 1) reasons.push(`${field}_conflict`)
  const year = one('year') as number | null, declareKind = one('declareKind') as string | null, appliedAt = one('appliedAt') as string | null
  if (year == null) reasons.push('platform_year_missing')
  if (!declareKind || !['apply', 'review', 'update'].includes(declareKind)) reasons.push('process_type_unknown')
  if (time(appliedAt) == null) reasons.push('application_time_unknown')
  if (refs.some(r => !normalizeUscc(r.usccRaw) && r.verificationStatus !== 'confirmed')) reasons.push('identity_unknown')
  if (refs.some(r => r.businessRecord.groupState !== 'verified')) reasons.push('business_identity_unverified')
  const times = refs.map(r => observationTime(r.queriedAt))
  if (times.some(t => t == null)) reasons.push('observation_time_unknown')
  const max = Math.max(...times.filter((t): t is number => t != null))
  const latest = refs.filter(r => observationTime(r.queriedAt) === max)
  const statuses = unique(latest.map(r => fact(r).status))
  const status = statuses.length === 1 ? statuses[0]! : null
  if (statuses.length > 1) reasons.push('latest_observation_conflict')
  if (status == null) reasons.push('latest_status_missing')
  if (latest.some(r => fact(r).normalizationConflicts.length || r.conflicts.some(c => c !== 'correspondence_decision_conflict'))) reasons.push('latest_source_conflict')
  // Stable-field conflicts anywhere in the source history cannot be cured by a later pass.
  if (refs.some(r => fact(r).normalizationConflicts.some(c => object(c).field !== 'status'))) reasons.push('stable_source_conflict')
  const endpointRefs = [...Map.groupBy(refs, r => interfaceKey(r)).values()].flatMap(rs => {
    const last = Math.max(...rs.map(r => observationTime(r.queriedAt) ?? Infinity))
    return rs.filter(r => observationTime(r.queriedAt) === last && fact(r).status === status && !fact(r).normalizationConflicts.length && !r.conflicts.length)
  })
  const latestVersionRefs = [...Map.groupBy(endpointRefs, r => JSON.stringify([r.interface, r.businessRecord.recordId, r.businessRecord.versionId])).values()]
    .map(rs => ({ interface: rs[0]!.interface, recordId: rs[0]!.businessRecord.recordId, versionId: rs[0]!.businessRecord.versionId, relationIds: rs.map(r => r.relationId) }))
  const corroborationRefs = stableFields.flatMap(field => {
    const from = refs.filter(r => fact(r)[field] != null), to = refs.filter(r => fact(r)[field] == null)
    return from.length && to.length && values(field).length === 1 ? [{ field, fromRelationIds: from.map(r => r.relationId), toRelationIds: to.map(r => r.relationId) }] : []
  })
  return {
    id: JSON.stringify(unique(refs.map(interfaceKey)).sort()), businessKey: refs[0]!.businessRecord.platformKey ?? refs[0]!.relationKey,
    awardYear: null, decisionYear: null, year, declareKind, appliedAt, status, observedAt: latest[0]?.queriedAt ?? null,
    annualEligible: false, reasons: unique(reasons), groups,
    latestObservationRelationIds: latest.map(r => r.relationId), latestVersionRefs,
    preferredWriteRelationId: endpointRefs.find(r => r.interface === 'business_list' && (r.queryTitleCode ?? ({ '1': 'innovative_sme', '2': 'specialized_sme', '3': 'little_giant' } as Record<string, string>)[r.rdjb]) === r.target.titleCode)?.relationId ?? null,
    corroboratedFields: corroborationRefs.map(r => r.field), corroborationRefs,
  }
}

/** Complete, already owner/title/role-scoped observations; never pass a display page here. */
export function buildAnnualProcess(input: AnnualProcessInput): EventAnnualProcess {
  const { event } = input
  const businessYear = event.eventType === 'review' ? event.decidedYear : event.eventType === 'award' ? event.year : null
  const declareKind = event.eventType === 'award' ? 'apply' : event.eventType === 'review' ? 'review' : null
  const reasons: string[] = []
  if (!declareKind) reasons.push('official_event_type_unsupported')
  if (businessYear == null) reasons.push('official_business_year_missing')
  const excludedIdentityRelationIds: number[] = []
  const selected = input.groups.flatMap(g => {
    const refs = g.observationRefs.filter(r => {
      if (r.titleCode !== event.record.titleCode || r.target.enterpriseId !== event.record.enterpriseId || (r.enterpriseId != null && r.enterpriseId !== event.record.enterpriseId)) return false
      if (normalizeUscc(r.usccRaw) && normalizeUscc(event.record.usccRaw) && normalizeUscc(r.usccRaw) !== normalizeUscc(event.record.usccRaw)) return false
      if (identityOnly(r)) { excludedIdentityRelationIds.push(r.relationId); return false }
      const f = fact(r)
      return (!f.declareKind || !['apply', 'review', 'update'].includes(f.declareKind) || f.declareKind === declareKind)
    })
    return refs.length ? [{ ...g, observationRefs: refs }] : []
  })
  // A business's versions, including A->B->A observations, are one annual step.
  const records = [...Map.groupBy(selected, g => interfaceKey(g.observationRefs[0]!)).values()]
  const logical: PlatformBusinessGroup[][] = []
  for (const groups of records) {
    const refs = groups.flatMap(g => g.observationRefs)
    const peer = logical.find(gs => canCorroborate(gs.flatMap(g => g.observationRefs), refs))
    if (peer) peer.push(...groups)
    else logical.push([...groups])
  }
  const steps = logical.map(buildStep).filter(s => businessYear == null || s.year == null || s.year === businessYear).sort((a, b) => (time(a.appliedAt) ?? Infinity) - (time(b.appliedAt) ?? Infinity) || a.id.localeCompare(b.id))
  for (const s of steps) {
    s.awardYear = event.year
    s.decisionYear = event.decidedYear
    s.annualEligible = businessYear != null && s.year === businessYear && s.declareKind === declareKind && !s.reasons.some(r => ['identity_unknown', 'business_identity_unverified', 'stable_source_conflict'].includes(r) || r.endsWith('_conflict') && r !== 'latest_observation_conflict' && r !== 'latest_source_conflict')
  }
  let latest: AnnualProcessStep | null = null
  const eligible = steps.filter(s => s.annualEligible && time(s.appliedAt) != null)
  const max = Math.max(...eligible.map(s => time(s.appliedAt)!))
  const unresolved = steps.filter(s => (!s.annualEligible || time(s.appliedAt) == null) && (time(s.appliedAt) == null || time(s.appliedAt)! >= max))
  // A gap with no provable earlier bound can hide a later application. Never skip it.
  if (unresolved.length) reasons.push('potential_later_business_unresolved')
  else if (businessYear != null && declareKind && eligible.length) {
    const tail = eligible.filter(s => time(s.appliedAt) === max)
    if (tail.length === 1) latest = tail[0]!
    else reasons.push('latest_application_time_tied')
  }
  if ((input.scopeGaps ?? []).some(g => time(g.appliedAt) == null || time(g.appliedAt)! >= max)) { reasons.push('potential_later_title_unknown'); latest = null }
  if (!steps.length) reasons.push('no_annual_process')
  const expected = event.eventType === 'award' ? '终审通过' : event.reviewOutcome === 'passed' ? '终审通过' : event.reviewOutcome === 'failed' ? '终审不通过' : null
  if (event.eventType === 'review' && !expected) reasons.push('official_result_missing')
  if (latest && !['终审通过', '终审不通过'].includes(latest.status ?? '')) reasons.push('latest_status_not_terminal')
  else if (latest && expected && latest.status !== expected) reasons.push('official_result_mismatch')
  const coverageReasons = unique(input.coverage.flatMap(q => [
    ...(!['success', 'no_record'].includes(q.status) ? [`archive_${q.status}`] : []),
    ...(q.completeness === 'partial' || q.fullRange === false ? ['archive_range_incomplete'] : []),
    ...(q.completeness == null || q.fullRange == null ? ['archive_range_unknown'] : []),
  ]))
  // Coverage describes the archive, not an assertion of exhaustive live-platform truth.
  // An explicitly incomplete latest traversal is stronger adverse evidence than legacy unknown range metadata.
  const latestCoverage = [...Map.groupBy(input.coverage, q => q.interface).values()].flatMap(qs => {
    const last = Math.max(...qs.map(q => observationTime(q.queriedAt) ?? Infinity))
    return qs.filter(q => (observationTime(q.queriedAt) ?? Infinity) === last)
  })
  if (latestCoverage.some(q => q.status === 'partial' || q.completeness === 'partial' || q.fullRange === false || q.status === 'failed')) reasons.push('latest_archive_incomplete')
  const finalCandidateStepId = latest && expected && latest.status === expected && latest.reasons.length === 0 && !reasons.length ? latest.id : null
  return { event, ruleVersion: ANNUAL_PROCESS_RULE_VERSION, businessYear, declareKind, steps, latestStepId: latest?.id ?? null, latestStepSummary: latest ? { id: latest.id, year: latest.year, declareKind: latest.declareKind, appliedAt: latest.appliedAt, status: latest.status, observedAt: latest.observedAt } : null, finalCandidateStepId, reasons: unique(reasons), coverage: input.coverage, coverageReasons, scopeGaps: input.scopeGaps ?? [], excludedIdentityRelationIds: unique(excludedIdentityRelationIds).sort((a, b) => a - b) }
}

/** Skinny stable source set. Decision state is deliberately absent from generation inputs. */
export interface AnnualProcessSourceRefs {
  scope: { enterpriseId: number; titleCode: string; businessYear: number | null; declareKind: string; ruleVersion: string }
  // Explicit, fixed shape: the source generation hashes exactly these fields, so
  // a new record_event column must never leak in by spreading the whole row.
  event: { id: number; revision: number; recordId: number; eventType: string; year: number | null; batchSeq: number | null; sortKey: number; decidedYear: number | null; reviewOutcome: string | null; usccRaw: string | null }
  evidence: Array<{ id: number; sourceFile: string; attachment: string | null; listNo: number | null; page: number | null; fileId: number | null; sha256: string | null; removedAt: string | null }>
  titleScopeRefs: Array<{ queryId: number; relationId: number; titleCode: string | null; platformKey: string | null; usccNorm: string; recordId: number | null; versionId: number | null }>
  observations: Array<{ queryId: number; relationId: number; interface: string; recordId: number | null; versionId: number | null; sourceFingerprint: string }>
  coverage: AnnualProcessCoverage[]
}
export interface EventAnnualProcessRead { process: EventAnnualProcess; sourceGeneration: string; sourceRefs: AnnualProcessSourceRefs }
export interface EventAnnualProcessPage extends EventAnnualProcessRead { total: number; page: number; pageSize: number }
