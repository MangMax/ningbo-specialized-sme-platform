import { readEvidenceImpact113 } from '../../server/utils/evidence-impact-113'
/** #108 additive read projection. Business decisions stay owned by #102. */
import { inArray, sql } from 'drizzle-orm'
import { z } from 'zod'
import { enterprise } from '../../db/schema'
import { currentDecision102, currentDecisionState102, type DecisionDb } from '../../server/utils/decision-lifecycle-102'
import { normalizeUscc } from '../domain'
import { identityFunctions, identityUsccSql } from './enterprise-read-snapshot'
import { identityKeys, type IdentityKeyVariants } from './current-identity-keys'
import { platformQueryResultShape, type PlatformQueryPage } from '../platform/live-query'
import { differenceTargetSources, readDifferenceCollectionScopes, selectDifferenceCollections, selectDifferenceCollectionsBatch } from '../platform/difference-sources'

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
const metadataProjection = sql`case when json_valid(q.collection_evidence) then json_object(
        'source',json_extract(q.collection_evidence,'$.source'), 'status',json_extract(q.collection_evidence,'$.status'),
        'effectiveConditions',json_extract(q.collection_evidence,'$.effectiveConditions'), 'titleScope',json_extract(q.collection_evidence,'$.titleScope'),
        'pages',json_extract(q.collection_evidence,'$.pages'), 'completeness',json_extract(q.collection_evidence,'$.completeness'),
        'fullRange',json_extract(q.collection_evidence,'$.fullRange'), 'unfinished',json_extract(q.collection_evidence,'$.unfinished'),
        'error',json_extract(q.collection_evidence,'$.error'), 'limits',json_extract(q.collection_evidence,'$.limits')) else null end`
/** Metadata extraction stays inside SQLite; original rows/raw_response never enter JS. */
function queryMetadata(db: DecisionDb, scope: AssessmentScope, variants?: IdentityKeyVariants, ownQueryIds?: readonly number[]) {
  identityFunctions(db)
  const e = db.get<{ uscc: string | null; name: string }>(sql`select uscc_norm as uscc,name_norm as name from enterprise where id=${scope.enterpriseId}`)!
  const uscc = normalizeUscc(e.uscc) || null, rdjb = rdjbByTitle[scope.titleCode] ?? ''
  if (differenceTargetSources(db)) {
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
  const selected = ownQueryIds ? sql`select q.id from platform_query q where q.id in (select value from json_each(${JSON.stringify(ownQueryIds)})) and ${titleScope} order by q.queried_at desc,q.id desc limit 51` : indexed ? sql`select id from (${indexed}) order by queried_at desc,id desc limit 51` : sql`select q.id from platform_query q
    where (q.query_key=${`name:${e.name}`} or
      (${uscc} is not null and ${uscc?.includes(':') ? sql`1` : sql`instr(q.query_key,':')=0`} and ${identityUsccSql(sql`q.query_key`)}=${uscc}) or
      q.id in (select query_id from platform_relation where enterprise_id=${scope.enterpriseId}))
      and (q.interface='apply_list' or q.title_code=${scope.titleCode} or instr(','||q.rdjb||',',${`,` + rdjb + `,`})>0 or (q.rdjb='' and q.title_code is null))
    order by q.queried_at desc,q.id desc limit 51`
  const rows = db.all<QueryMetadata>(sql`with selected as materialized (${selected})
    select q.id,q.interface,q.query_key as queryKey,q.title_code as titleCode,q.rdjb,q.queried_at as queriedAt,q.status,
      exists(select 1 from platform_relation r where r.query_id=q.id and r.enterprise_id=${scope.enterpriseId}) as matched,
      ${metadataProjection} as metadata
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
  if (!differenceTargetSources(db)) {
    for (const scope of unique) set(scope, readQueryCoverage(db, scope, variants))
    return result
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

export function readQueryAssessments(db: DecisionDb, scopes: AssessmentScope[]): QueryAssessment[] {
  return readCoveragesForScopes(db, scopes).map((queryCoverage, index) => {
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
  if (differenceTargetSources(db)) {
    const coverage = readQueryCoverageBatch(db, scopes)
    return scopes.map(scope => coverage.get(scope.enterpriseId)!.get(scope.titleCode)!)
  }
  identityFunctions(db)
  const keyOf = (s: AssessmentScope) => JSON.stringify([s.enterpriseId, s.titleCode])
  const targets = [...new Map(scopes.map(s => [keyOf(s), s])).values()]
  const ids = [...new Set(targets.map(s => s.enterpriseId))]
  const enterprises = new Map(db.all<{ id: number; name: string; uscc: string | null }>(sql`
    select id,name_norm name,uscc_norm uscc from enterprise where id in (${sql.join(ids.map(id => sql`${id}`), sql`,`)})`).map(e => [e.id, e]))
  const targetSql = sql.join(targets.map((s, i) => {
    const e = enterprises.get(s.enterpriseId)
    return sql`select ${i} slot,${s.enterpriseId} enterpriseId,${s.titleCode} titleCode,${rdjbByTitle[s.titleCode] ?? ''} rdjb,${e?.name ?? ''} name,${normalizeUscc(e?.uscc) || null} uscc`
  }), sql` union all `)
  const rows = db.all<QueryMetadata & { slot: number }>(sql`
    with targets as materialized (${targetSql}),
    raw_keys as materialized (select distinct query_key from platform_query),
    keys as materialized (select query_key,${identityUsccSql(sql`query_key`)} uscc from raw_keys),
    candidates as (
      select t.slot,q.id from targets t join platform_query q on q.query_key='name:'||t.name
      union
      select t.slot,q.id from targets t join keys k on k.uscc=t.uscc join platform_query q on q.query_key=k.query_key
      union
      select t.slot,r.query_id from targets t join platform_relation r on r.enterprise_id=t.enterpriseId
    ),
    ranked as materialized (
      select c.slot,q.id,row_number() over (partition by c.slot order by q.queried_at desc,q.id desc) rank
      from candidates c join targets t on t.slot=c.slot join platform_query q on q.id=c.id
      where q.interface='apply_list' or q.title_code=t.titleCode or instr(','||q.rdjb||',',','||t.rdjb||',')>0 or (q.rdjb='' and q.title_code is null)
    ),
    selected as materialized (select slot,id,rank from ranked where rank<=51)
    select selected.slot,q.id,q.interface,q.query_key queryKey,q.title_code titleCode,q.rdjb,q.queried_at queriedAt,q.status,
      exists(select 1 from platform_relation r where r.query_id=q.id and r.enterprise_id=t.enterpriseId) matched,
      ${metadataProjection} metadata
    from selected join targets t on t.slot=selected.slot join platform_query q on q.id=selected.id
    order by selected.slot,selected.rank`)
  const grouped = new Map<number, QueryMetadata[]>()
  for (const row of rows) {
    const group = grouped.get(row.slot) ?? []
    group.push(row); grouped.set(row.slot, group)
  }
  const coverage = new Map(targets.map((s, slot) => {
    const selected = grouped.get(slot) ?? []
    return [keyOf(s), coverageOf({ rows: selected.slice(0, 50), truncated: selected.length > 50, uscc: normalizeUscc(enterprises.get(s.enterpriseId)?.uscc) || null }, s)] as const
  }))
  return scopes.map(s => coverage.get(keyOf(s))!)
}
