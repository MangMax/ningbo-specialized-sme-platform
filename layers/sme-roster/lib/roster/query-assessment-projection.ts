import { z } from 'zod'
import type { readEvidenceImpact113 } from '../../server/utils/evidence-impact-113'
import type { currentDecision102, currentDecisionState102 } from '../../server/utils/decision-lifecycle-102'
import { normalizeUscc } from '../domain'
import { platformQueryResultShape, type PlatformQueryPage } from '../platform/live-query'

export type AssessmentScope = Parameters<typeof currentDecision102>[1]
type CoverageStatus = 'not_queried' | 'complete' | 'partial' | 'failed' | 'unknown'
const metadataSchema = z.object({
  source: platformQueryResultShape.source, status: platformQueryResultShape.status,
  effectiveConditions: platformQueryResultShape.effectiveConditions, titleScope: platformQueryResultShape.titleScope,
  pages: platformQueryResultShape.pages, completeness: platformQueryResultShape.completeness,
  fullRange: platformQueryResultShape.fullRange, unfinished: platformQueryResultShape.unfinished,
  error: platformQueryResultShape.error, limits: platformQueryResultShape.limits,
})
type Metadata = z.infer<typeof metadataSchema>
export const rdjbByTitle: Record<string, string> = { innovative_sme: '1', specialized_sme: '2', little_giant: '3' }
const sourceByInterface: Record<string, string> = { business_list: 'businessList', apply_list: 'queryList', recognized_list: 'queryBusList' }
export interface QueryMetadata {
  id: number; interface: string; queryKey: string; titleCode: string | null; rdjb: string; queriedAt: string; status: string
  metadata: string | null; matched: number
}
export interface QueryCoverageSource {
  queryId: number; interface: string; queriedAt: string; queryStatus: string; status: CoverageStatus; titleCode: string | null; rdjb: string
  conditions: Metadata['effectiveConditions'] | null; pages: PlatformQueryPage[]; fullRange: boolean | null
  completeness: string | null; unfinished: Metadata['unfinished']; outcome: 'records' | 'no_record' | 'unknown'
  subjectMatch: 'exact_uscc' | 'matched_relation' | 'name_only' | 'unknown'
}
function metadataOf(row: QueryMetadata): Metadata | null {
  if (!row.metadata) return null
  try {
    const m = JSON.parse(row.metadata)
    if (m.fullRange === 0 || m.fullRange === 1) m.fullRange = !!m.fullRange
    const parsed = metadataSchema.safeParse(m)
    return parsed.success ? parsed.data : null
  } catch { return null }
}
function completePages(pages: PlatformQueryPage[], pageSize: number, fullRange: boolean): boolean {
  if (!pages.length || !Number.isInteger(pageSize) || pageSize < 1) return false
  if (fullRange && pages[0]!.page !== 1) return false
  if (pages.some((p, i) => p.status !== 'success' || !Number.isInteger(p.page) || p.page < 1 || !Number.isInteger(p.fetchedCount) || p.fetchedCount < 0 || p.fetchedCount > pageSize || (i > 0 && p.page !== pages[i - 1]!.page + 1))) return false
  const totals = [...new Set(pages.flatMap(p => p.declaredTotal == null ? [] : [p.declaredTotal]))]
  const maxPages = [...new Set(pages.flatMap(p => p.maxPage == null ? [] : [p.maxPage]))]
  if (totals.length > 1 || maxPages.length > 1) return false
  const last = pages.at(-1)!, fetched = pages.reduce((n, p) => n + p.fetchedCount, 0)
  if (totals[0] != null) {
    if (!Number.isInteger(totals[0]) || totals[0] < 0 || pages.some(p => p.fetchedCount !== Math.min(pageSize, Math.max(0, totals[0]! - (p.page - 1) * pageSize)))) return false
    return fetched + (pages[0]!.page - 1) * pageSize === totals[0]
  }
  if (maxPages[0] != null) return Number.isInteger(maxPages[0]) && maxPages[0] === last.page && pages.slice(0, -1).every(p => p.fetchedCount === pageSize)
  return last.fetchedCount === 0 && pages.slice(0, -1).every(p => p.fetchedCount === pageSize)
}
export function projectQueryComparisonWitnesses(selected: Parameters<typeof projectQueryCoverage>[0], scope: Pick<AssessmentScope, 'titleCode'>) {
  const coverage = projectQueryCoverage(selected, scope)
  const rows = new Map(selected.rows.map(row => [row.id, row]))
  return { truncated: selected.truncated, sources: coverage.sources.map(source => {
    const row = rows.get(source.queryId)!
    return { source, queryKey: row.queryKey, metadata: metadataOf(row) }
  }) }
}
export function projectQueryCoverage({ rows, truncated, uscc }: { rows: QueryMetadata[]; truncated: boolean; uscc: string | null }, scope: Pick<AssessmentScope, 'titleCode'>) {
  const rdjb = rdjbByTitle[scope.titleCode]

  const sources: QueryCoverageSource[] = rows.flatMap(q => {
    const m = metadataOf(q)
    if (m && q.interface !== 'apply_list' && !m.titleScope.rdjb.includes(rdjb!)) return []
    const pages = m?.pages.filter(p => q.interface === 'apply_list' ? p.rdjb == null : p.rdjb === rdjb) ?? []
    const conditions = m?.effectiveConditions ?? null
    const exact = !!uscc && normalizeUscc(q.queryKey) === uscc && (!conditions?.uscc || normalizeUscc(conditions.uscc) === uscc)
    const subjectMatch: QueryCoverageSource['subjectMatch'] = exact ? 'exact_uscc' : q.matched ? 'matched_relation' : q.queryKey.startsWith('name:') ? 'name_only' : 'unknown'
    let status: CoverageStatus = 'unknown'
    if (q.status === 'not_queried' && (!m || m.status === 'not_queried')) status = 'not_queried'
    else if (['failed', 'auth_failed'].includes(q.status) || ['failed', 'auth_failed'].includes(m?.status ?? '') || pages.some(p => p.status !== 'success') || m?.error) status = 'failed'
    else if (q.status === 'partial' || m?.completeness === 'partial' || m?.unfinished.some(p => p.rdjb === rdjb || p.rdjb == null)) status = 'partial'
    else if (m && m.source === sourceByInterface[q.interface] && ['success', 'no_record'].includes(q.status) && m.status === q.status && (m.status !== 'no_record' || m.pages.every(p => p.fetchedCount === 0)) && m.completeness === 'complete' && !m.unfinished.length && completePages(pages, m.limits.pageSize, !!m.fullRange)) status = 'complete'
    const count = pages.reduce((n, p) => n + p.fetchedCount, 0)
    return [{ queryId: q.id, interface: q.interface, queriedAt: q.queriedAt, queryStatus: q.status, status, titleCode: q.interface === 'apply_list' || (!m && !q.titleCode && !q.rdjb) ? null : scope.titleCode, rdjb: q.rdjb,
      conditions, pages, fullRange: m ? !!m.fullRange : null, completeness: m?.completeness ?? null, unfinished: m?.unfinished ?? [],
      outcome: status === 'complete' && subjectMatch === 'exact_uscc' && m?.fullRange ? count === 0 ? 'no_record' : q.matched ? 'records' : 'unknown' : 'unknown', subjectMatch }]
  })
  // A later retry supersedes only the same source/conditions/title; unrelated
  // restricted queries cannot hide a still-complete unrestricted traversal.
  const latest = new Map<string, QueryCoverageSource>()
  for (const s of sources) {
    const conditions = s.conditions && Object.fromEntries(Object.entries(s.conditions).sort(([a], [b]) => a.localeCompare(b)))
    const key = JSON.stringify([s.interface, conditions, s.fullRange])
    if (!latest.has(key)) latest.set(key, s)
  }
  const relevant = [...latest.values()].filter(s => s.interface !== 'apply_list')
  const unrestricted = relevant.filter(s => s.subjectMatch === 'exact_uscc' && s.conditions?.uscc && normalizeUscc(s.conditions.uscc) === uscc && Object.keys(s.conditions).every(k => ['uscc', 'combination'].includes(k)) && s.fullRange)
  let status: CoverageStatus = 'unknown'
  if (!sources.length || sources.every(s => s.status === 'not_queried')) status = 'not_queried'
  else if (!truncated && unrestricted.some(s => s.status === 'complete')) status = 'complete'
  else if (relevant.some(s => s.status === 'partial' || (s.status === 'complete' && s.subjectMatch === 'exact_uscc'))) status = 'partial'
  else if (relevant.some(s => s.status === 'failed')) status = 'failed'
  return { status, sources, truncated }
}
/** Shared status rules; both full and scalar readers supply their own SQL projection. */
export function assessmentStatuses(scope: AssessmentScope, queryCoverage: ReturnType<typeof projectQueryCoverage>, currentDecision: ReturnType<typeof currentDecisionState102>, impact: ReturnType<typeof readEvidenceImpact113>) {
  const current = currentDecision.current
  const reviewed = impact.state?.reviewedRevisionId
  const { invalid, executed, assessment } = decisionCoverage(scope, queryCoverage, currentDecision, reviewed != null)
  const pending = !!impact.state && impact.state.latestRevisionId > (reviewed ?? -1)
  // The scope token also advances for coverage-only and disjoint partitions.
  // Until processing finishes stay conservative; once ready, the per-decision
  // pending state carries substantive changes without rewriting the review audit.
  const changed = reviewed != null && !impact.token.projectionReady
  const validity = !current ? 'not_applicable' : pending ? impact.state!.classification : changed ? 'evidence_changed' : reviewed != null ? 'valid' : invalid ? 'premise_invalid' : 'unknown'
  return { validity, invalid, executed, assessment }
}

function decisionCoverage(scope: AssessmentScope, queryCoverage: ReturnType<typeof projectQueryCoverage>, currentDecision: ReturnType<typeof currentDecisionState102>, reviewed: boolean) {
  const current = currentDecision.current
  const executed = queryCoverage.sources.filter(s => s.titleCode === scope.titleCode && s.queryStatus !== 'not_queried' && ['exact_uscc', 'matched_relation'].includes(s.subjectMatch))
  const invalid = !reviewed && current?.status === 'not_queried' && executed.length > 0
  const assessment = current ? 'decided' : currentDecision.versionId ? 'withdrawn' : queryCoverage.status === 'complete' ? 'queried_unjudged' : queryCoverage.status === 'not_queried' ? 'not_queried' : 'unknown'
  return { invalid, executed, assessment }
}
export function projectQueryAssessment(scope: AssessmentScope, queryCoverage: ReturnType<typeof projectQueryCoverage>, currentDecision: ReturnType<typeof currentDecision102>, impact: ReturnType<typeof readEvidenceImpact113>) {
  const { validity, invalid, executed, assessment } = assessmentStatuses(scope, queryCoverage, currentDecision, impact)
  return assessmentResult(queryCoverage, currentDecision, validity, invalid, executed, assessment)
}

export function projectRetiredEvidenceAssessment(scope: AssessmentScope, queryCoverage: ReturnType<typeof projectQueryCoverage>, currentDecision: ReturnType<typeof currentDecision102>, historicalValidity: 'valid' | 'evidence_changed' | 'premise_invalid' | null, historicalReviewed: boolean) {
  const { invalid, executed, assessment } = decisionCoverage(scope, queryCoverage, currentDecision, historicalReviewed)
  const validity = !currentDecision.current ? 'not_applicable' : historicalValidity ?? (invalid ? 'premise_invalid' : 'unknown')
  return assessmentResult(queryCoverage, currentDecision, validity, invalid, executed, assessment)
}

function assessmentResult(queryCoverage: ReturnType<typeof projectQueryCoverage>, currentDecision: ReturnType<typeof currentDecision102>,
  validity: ReturnType<typeof assessmentStatuses>['validity'], invalid: boolean,
  executed: ReturnType<typeof assessmentStatuses>['executed'], assessment: ReturnType<typeof assessmentStatuses>['assessment']) {
  const current = currentDecision.current
  const reasons = validity === 'premise_invalid' ? ['query_executed'] : validity === 'evidence_changed' ? ['committed_evidence_changed'] : validity === 'unknown' ? ['no_evidence_baseline'] : []
  return {
    queryCoverage, currentDecision,
    explanationValidity: { status: validity, reasons, explanationId: current?.id ?? null, evidenceQueryIds: invalid ? executed.map(s => s.queryId) : current?.evidenceQueryId ? [current.evidenceQueryId] : [] },
    assessment,
  }
}
export type QueryAssessment = ReturnType<typeof projectQueryAssessment>

export type QueryAssessmentSummary = {
  queryCoverage: Pick<QueryAssessment['queryCoverage'], 'status'>
  assessment: QueryAssessment['assessment']
  explanationValidity: Pick<QueryAssessment['explanationValidity'], 'status'>
}
