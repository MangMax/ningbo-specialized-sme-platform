import { readEvidenceImpact113 } from '../../server/utils/evidence-impact-113'
/** #108 additive read projection. Business decisions stay owned by #102. */
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { currentDecision102, type DecisionDb } from '../../server/utils/decision-lifecycle-102'
import { normalizeUscc } from '../domain'
import { identityFunctions, identityUsccSql } from './enterprise-read-snapshot'
import { identityKeys, type IdentityKeyVariants } from './current-identity-keys'
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
function queryMetadata(db: DecisionDb, scope: AssessmentScope, variants?: IdentityKeyVariants) {
  identityFunctions(db)
  const e = db.get<{ uscc: string | null; name: string }>(sql`select uscc_norm as uscc,name_norm as name from enterprise where id=${scope.enterpriseId}`)!
  const uscc = normalizeUscc(e.uscc) || null, rdjb = rdjbByTitle[scope.titleCode] ?? ''
  // Freeze bounded IDs before extracting JSON: ORDER BY/LIMIT on the outer
  // projection alone could parse metadata for every qualifying historical row.
  const titleScope = sql`(q.interface='apply_list' or q.title_code=${scope.titleCode} or instr(','||q.rdjb||',',${`,` + rdjb + `,`})>0 or (q.rdjb='' and q.title_code is null))`
  // Each identity branch uses the existing key/enterprise index. Take its top
  // 51 before merging: no branch can contribute a 52nd row to the global top 51.
  const keys = variants ? [...new Set([`name:${e.name}`, ...identityKeys(variants, uscc)])] : []
  const indexed = variants ? sql.join([
    sql`select id,queried_at from (select q.id,q.queried_at from platform_query q indexed by platform_query_key_idx where q.query_key in (select value from json_each(${JSON.stringify(keys)})) and ${titleScope} order by q.queried_at desc,q.id desc limit 51)`,
    sql`select id,queried_at from (select distinct q.id,q.queried_at from platform_relation r indexed by platform_relation_enterprise_idx join platform_query q on q.id=r.query_id where r.enterprise_id=${scope.enterpriseId} and ${titleScope} order by q.queried_at desc,q.id desc limit 51)`,
  ], sql` union `) : null
  const selected = indexed ? sql`select id from (${indexed}) order by queried_at desc,id desc limit 51` : sql`select q.id from platform_query q
    where (q.query_key=${`name:${e.name}`} or
      (${uscc} is not null and ${uscc?.includes(':') ? sql`1` : sql`instr(q.query_key,':')=0`} and ${identityUsccSql(sql`q.query_key`)}=${uscc}) or
      q.id in (select query_id from platform_relation where enterprise_id=${scope.enterpriseId}))
      and (q.interface='apply_list' or q.title_code=${scope.titleCode} or instr(','||q.rdjb||',',${`,` + rdjb + `,`})>0 or (q.rdjb='' and q.title_code is null))
    order by q.queried_at desc,q.id desc limit 51`
  const rows = db.all<QueryMetadata>(sql`with selected as materialized (${selected})
    select q.id,q.interface,q.query_key as queryKey,q.title_code as titleCode,q.rdjb,q.queried_at as queriedAt,q.status,
      exists(select 1 from platform_relation r where r.query_id=q.id and r.enterprise_id=${scope.enterpriseId}) as matched,
      case when json_valid(q.collection_evidence) then json_object(
        'source',json_extract(q.collection_evidence,'$.source'), 'status',json_extract(q.collection_evidence,'$.status'),
        'effectiveConditions',json_extract(q.collection_evidence,'$.effectiveConditions'), 'titleScope',json_extract(q.collection_evidence,'$.titleScope'),
        'pages',json_extract(q.collection_evidence,'$.pages'), 'completeness',json_extract(q.collection_evidence,'$.completeness'),
        'fullRange',json_extract(q.collection_evidence,'$.fullRange'), 'unfinished',json_extract(q.collection_evidence,'$.unfinished'),
        'error',json_extract(q.collection_evidence,'$.error'), 'limits',json_extract(q.collection_evidence,'$.limits')) else null end as metadata
    from selected join platform_query q on q.id=selected.id
    order by q.queried_at desc,q.id desc`)
  return { rows: rows.slice(0, 50), truncated: rows.length > 50, uscc }
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
export function readQueryCoverage(db: DecisionDb, scope: AssessmentScope, variants?: IdentityKeyVariants) {
  const { rows, truncated, uscc } = queryMetadata(db, scope, variants), rdjb = rdjbByTitle[scope.titleCode]
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
export function readQueryAssessment(db: DecisionDb, scope: AssessmentScope, variants?: IdentityKeyVariants) {
  scope = { enterpriseId: scope.enterpriseId, titleCode: scope.titleCode, direction: scope.direction }
  const currentDecision = currentDecision102(db, scope), queryCoverage = readQueryCoverage(db, scope, variants)
  const current = currentDecision.current
  const executed = queryCoverage.sources.filter(s => s.titleCode === scope.titleCode && s.queryStatus !== 'not_queried' && ['exact_uscc', 'matched_relation'].includes(s.subjectMatch))
  const impact = readEvidenceImpact113(db, { ...scope, direction: scope.direction }, current?.id ?? null)
  const reviewed = impact.state?.reviewedRevisionId
  const pending = !!impact.state && impact.state.latestRevisionId > (reviewed ?? -1)
  // The scope token also advances for coverage-only and disjoint partitions.
  // Until processing finishes stay conservative; once ready, the per-decision
  // pending state carries substantive changes without rewriting the review audit.
  const changed = reviewed != null && !impact.token.projectionReady
  const invalid = current?.status === 'not_queried' && executed.length > 0 && reviewed == null
  const validity = !current ? 'not_applicable' : pending ? impact.state!.classification : changed ? 'evidence_changed' : reviewed != null ? 'valid' : invalid ? 'premise_invalid' : 'unknown'
  const reasons = validity === 'premise_invalid' ? ['query_executed'] : validity === 'evidence_changed' ? ['committed_evidence_changed'] : validity === 'unknown' ? ['no_evidence_baseline'] : []
  return {
    queryCoverage, currentDecision,
    explanationValidity: { status: validity, reasons, explanationId: current?.id ?? null, evidenceQueryIds: invalid ? executed.map(s => s.queryId) : current?.evidenceQueryId ? [current.evidenceQueryId] : [] },
    assessment: current ? 'decided' : currentDecision.versionId ? 'withdrawn' : queryCoverage.status === 'complete' ? 'queried_unjudged' : queryCoverage.status === 'not_queried' ? 'not_queried' : 'unknown',
  }
}
export type QueryAssessment = ReturnType<typeof readQueryAssessment>
