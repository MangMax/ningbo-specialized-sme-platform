import { readEvidenceImpact113 } from '../../server/utils/evidence-impact-113'
/** #108 additive read projection. Business decisions stay owned by #102. */
import { inArray, sql } from 'drizzle-orm'
import { z } from 'zod'
import { enterprise } from '../../db/schema'
import { currentDecision102, currentDecisionState102, type DecisionDb } from '../../server/utils/decision-lifecycle-102'
import { normalizeUscc } from '../domain'
import { identityFunctions } from './enterprise-read-snapshot'
import { identityKeys, type IdentityKeyVariants } from './current-identity-keys'
import { platformQueryResultShape, type PlatformQueryPage } from '../platform/live-query'
import { readDifferenceCollectionScopes, selectDifferenceCollections, selectDifferenceCollectionsBatch } from '../platform/difference-sources'

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
const rdjbByTitle: Record<string, string> = { innovative_sme: '1', specialized_sme: '2', little_giant: '3' }
const sourceByInterface: Record<string, string> = { business_list: 'businessList', apply_list: 'queryList', recognized_list: 'queryBusList' }
interface QueryMetadata {
  id: number; interface: string; queryKey: string; titleCode: string | null; rdjb: string; queriedAt: string; status: string
  metadata: string | null; matched: number
}
export interface QueryCoverageSource {
  queryId: number; interface: string; queriedAt: string; queryStatus: string; status: CoverageStatus; titleCode: string | null; rdjb: string
  conditions: Metadata['effectiveConditions'] | null; pages: PlatformQueryPage[]; fullRange: boolean | null
  completeness: string | null; unfinished: Metadata['unfinished']; outcome: 'records' | 'no_record' | 'unknown'
  subjectMatch: 'exact_uscc' | 'matched_relation' | 'name_only' | 'unknown'
}
/** Metadata extraction stays inside SQLite; original rows/raw_response never enter JS. */
function queryMetadata(db: DecisionDb, scope: AssessmentScope, variants?: IdentityKeyVariants, ownQueryIds?: readonly number[]) {
  identityFunctions(db)
  const e = db.get<{ uscc: string | null; name: string }>(sql`select uscc_norm as uscc,name_norm as name from enterprise where id=${scope.enterpriseId}`)!
  const uscc = normalizeUscc(e.uscc) || null, rdjb = rdjbByTitle[scope.titleCode] ?? ''
  const selected = selectDifferenceCollections(db, scope.enterpriseId, { titleCode: scope.titleCode, rdjb, queryIds: ownQueryIds, limit: 51,
    queryKeys: variants ? [...new Set([`name:${e.name}`, ...identityKeys(variants, uscc)])] : undefined, normalizeIdentity: !variants })
  const metadata = readDifferenceCollectionScopes(db, selected.slice(0,50).map(r => r.collection))
  const rows: QueryMetadata[] = selected.slice(0,50).map(({ collection: q, id, matched }) => ({
    id, interface: q.interface, queryKey: q.queryKey, titleCode: q.titleCode, rdjb: q.rdjb, queriedAt: q.queriedAt, status: q.status, matched,
    // Supplemental pagination is presentation provenance, not the original
    // query's completeness assertion.
    metadata: q.provenanceState === 'legacy_supplement' ? null : JSON.stringify(metadata.get(q.id)!.metadata),
  }))
  return { rows, truncated: selected.length > 50, uscc }
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
export function readQueryCoverage(db: DecisionDb, scope: AssessmentScope, variants?: IdentityKeyVariants, ownQueryIds?: readonly number[]) {
  return coverageOf(queryMetadata(db, scope, variants, ownQueryIds), scope)
}
/** Chunk-local source read plan. Direction does not change query coverage, and
 * scope metadata is loaded once for the union of each title's newest 50 rows.
 * Only compiled SQL may be reused elsewhere; this map never outlives its caller. */
export function readQueryCoverageBatch(db: DecisionDb, scopes: readonly AssessmentScope[], variants?: IdentityKeyVariants): Map<number, Map<string, ReturnType<typeof readQueryCoverage>>> {
  const result = new Map<number, Map<string, ReturnType<typeof readQueryCoverage>>>()
  const unique = [...new Map(scopes.map(scope => [JSON.stringify([scope.enterpriseId, scope.titleCode]), scope])).values()]
  if (!unique.length) return result
  const set = (scope: AssessmentScope, coverage: ReturnType<typeof readQueryCoverage>) => {
    let titles = result.get(scope.enterpriseId)
    if (!titles) { titles = new Map(); result.set(scope.enterpriseId, titles) }
    titles.set(scope.titleCode, coverage)
  }
  const ids = [...new Set(unique.map(scope => scope.enterpriseId))]
  const enterprises = new Map(db.select({ id: enterprise.id, uscc: enterprise.usccNorm, name: enterprise.nameNorm })
    .from(enterprise).where(inArray(enterprise.id, ids)).all().map(row => [row.id, row]))
  const targets = unique.map(scope => {
    const e = enterprises.get(scope.enterpriseId), uscc = normalizeUscc(e?.uscc) || null
    return { enterpriseId: scope.enterpriseId, titleCode: scope.titleCode, rdjb: rdjbByTitle[scope.titleCode] ?? '', uscc,
      queryKeys: variants ? [...new Set([`name:${e?.name ?? ''}`, ...identityKeys(variants, uscc)])] : [e?.uscc ?? '', `name:${e?.name ?? ''}`] }
  })
  const selected = Map.groupBy(selectDifferenceCollectionsBatch(db, targets, !variants), row => row.slot)
  const retained = [...selected.values()].flatMap(rows => rows.slice(0, 50))
  const metadata = readDifferenceCollectionScopes(db, [...new Map(retained.map(row => [row.collection.id, row.collection])).values()])
  for (const [slot, scope] of unique.entries()) {
    const rows = selected.get(slot) ?? []
    set(scope, coverageOf({ uscc: targets[slot]!.uscc, truncated: rows.length > 50,
      rows: rows.slice(0, 50).map(({ collection: q, id, matched }) => ({
        id, interface: q.interface, queryKey: q.queryKey, titleCode: q.titleCode, rdjb: q.rdjb, queriedAt: q.queriedAt, status: q.status, matched,
        metadata: q.provenanceState === 'legacy_supplement' ? null : JSON.stringify(metadata.get(q.id)!.metadata),
      })),
    }, scope))
  }
  return result
}
/** Internal opt-in witness projection. Keep every retained retry/asOf candidate,
 * not the legacy aggregate status or its latest map. No rows/body fields escape SQL. */
export function readQueryComparisonWitnesses(db: DecisionDb, scope: AssessmentScope, variants?: IdentityKeyVariants, ownQueryIds?: readonly number[]) {
  const selected = queryMetadata(db, scope, variants, ownQueryIds)
  const coverage = coverageOf(selected, scope)
  const rows = new Map(selected.rows.map(row => [row.id, row]))
  return { truncated: selected.truncated, sources: coverage.sources.map(source => {
    const row = rows.get(source.queryId)!
    return { source, queryKey: row.queryKey, metadata: metadataOf(row) }
  }) }
}
function coverageOf({ rows, truncated, uscc }: ReturnType<typeof queryMetadata>, scope: AssessmentScope) {
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
export function readQueryAssessment(db: DecisionDb, scope: AssessmentScope, variants?: IdentityKeyVariants, coverage?: ReturnType<typeof readQueryCoverage>) {
  scope = { enterpriseId: scope.enterpriseId, titleCode: scope.titleCode, direction: scope.direction }
  const currentDecision = currentDecision102(db, scope)
  return assessmentOf(db, scope, coverage ?? readQueryCoverage(db, scope, variants), currentDecision)
}
/** Shared status rules; both full and scalar readers supply their own SQL projection. */
function assessmentStatuses(scope: AssessmentScope, queryCoverage: ReturnType<typeof readQueryCoverage>, currentDecision: ReturnType<typeof currentDecisionState102>, impact: ReturnType<typeof readEvidenceImpact113>) {

  const current = currentDecision.current
  const executed = queryCoverage.sources.filter(s => s.titleCode === scope.titleCode && s.queryStatus !== 'not_queried' && ['exact_uscc', 'matched_relation'].includes(s.subjectMatch))
  const reviewed = impact.state?.reviewedRevisionId
  const pending = !!impact.state && impact.state.latestRevisionId > (reviewed ?? -1)
  // The scope token also advances for coverage-only and disjoint partitions.
  // Until processing finishes stay conservative; once ready, the per-decision
  // pending state carries substantive changes without rewriting the review audit.
  const changed = reviewed != null && !impact.token.projectionReady
  const invalid = current?.status === 'not_queried' && executed.length > 0 && reviewed == null
  const validity = !current ? 'not_applicable' : pending ? impact.state!.classification : changed ? 'evidence_changed' : reviewed != null ? 'valid' : invalid ? 'premise_invalid' : 'unknown'
  return { validity, invalid, executed, assessment: current ? 'decided' : currentDecision.versionId ? 'withdrawn' : queryCoverage.status === 'complete' ? 'queried_unjudged' : queryCoverage.status === 'not_queried' ? 'not_queried' : 'unknown' }
}
function assessmentOf(db: DecisionDb, scope: AssessmentScope, queryCoverage: ReturnType<typeof readQueryCoverage>, currentDecision = currentDecision102(db, scope)) {
  const current = currentDecision.current
  const impact = readEvidenceImpact113(db, scope, current?.id ?? null)
  const { validity, invalid, executed, assessment } = assessmentStatuses(scope, queryCoverage, currentDecision, impact)
  const reasons = validity === 'premise_invalid' ? ['query_executed'] : validity === 'evidence_changed' ? ['committed_evidence_changed'] : validity === 'unknown' ? ['no_evidence_baseline'] : []
  return {
    queryCoverage, currentDecision,
    explanationValidity: { status: validity, reasons, explanationId: current?.id ?? null, evidenceQueryIds: invalid ? executed.map(s => s.queryId) : current?.evidenceQueryId ? [current.evidenceQueryId] : [] },
    assessment,
  }
}
export type QueryAssessment = ReturnType<typeof readQueryAssessment>

export type QueryAssessmentSummary = {
  queryCoverage: Pick<QueryAssessment['queryCoverage'], 'status'>
  assessment: QueryAssessment['assessment']
  explanationValidity: Pick<QueryAssessment['explanationValidity'], 'status'>
}

export function readQueryAssessments(db: DecisionDb, scopes: AssessmentScope[], ownedCoverage?: ReturnType<typeof readQueryCoverageBatch>): QueryAssessment[] {
  const coverages = ownedCoverage ? scopes.map(scope => {
    const coverage = ownedCoverage.get(scope.enterpriseId)?.get(scope.titleCode)
    if (!coverage) throw new Error('Query assessment coverage scope missing')
    return coverage
  }) : readCoveragesForScopes(db, scopes)
  return coverages.map((queryCoverage, index) => {
    const { enterpriseId, titleCode, direction } = scopes[index]!
    return assessmentOf(db, { enterpriseId, titleCode, direction }, queryCoverage)
  })
}

/** Scalar-only list projection; no full decision is hydrated and then discarded. */
export function readQueryAssessmentSummaries(db: DecisionDb, scopes: AssessmentScope[]): QueryAssessmentSummary[] {
  return readCoveragesForScopes(db, scopes).map((queryCoverage, index) => {
    const { enterpriseId, titleCode, direction } = scopes[index]!
    const scope = { enterpriseId, titleCode, direction }
    const decision = currentDecisionState102(db, scope)
    const impact = readEvidenceImpact113(db, scope, decision.current?.id ?? null)
    const status = assessmentStatuses(scope, queryCoverage, decision, impact)
    return { queryCoverage: { status: queryCoverage.status }, assessment: status.assessment, explanationValidity: { status: status.validity } }
  })
}

/** A page-local read plan, never a result cache. Direction does not alter query
 * coverage, so select the newest 51 IDs once per enterprise/title. Normalize the
 * archive key catalog inside SQLite once, instead of scanning it per row. JSON
 * extraction is AFTER the per-scope bound; raw bodies never enter JavaScript.
 * Decisions and evidence impact still use their owning lifecycle projections.
 */
function readCoveragesForScopes(db: DecisionDb, scopes: AssessmentScope[]): ReturnType<typeof readQueryCoverage>[] {
  if (!scopes.length) return []
  const coverage = readQueryCoverageBatch(db, scopes)
  return scopes.map(scope => coverage.get(scope.enterpriseId)!.get(scope.titleCode)!)
}
