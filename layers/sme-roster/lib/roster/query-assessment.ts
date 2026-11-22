import { readEvidenceImpact113, readEvidenceImpacts113 } from '../../server/utils/evidence-impact-113'
/** #108 additive read projection. Business decisions stay owned by #102. */
import { inArray, sql } from 'drizzle-orm'
import { enterprise } from '../../../../db/schema'
import { currentDecision102, currentDecisions102, currentDecisionStates102, type DecisionDb } from '../../server/utils/decision-lifecycle-102'
import { normalizeUscc } from '../domain'
import { identityFunctions } from './enterprise-read-snapshot'
import type { IdentityKeyVariants } from './current-identity-keys'
import { readDifferenceCollectionScopes, selectDifferenceCollections, selectDifferenceCollectionsBatch } from '../platform/difference-sources'

import {
  assessmentStatuses, projectQueryAssessment, projectQueryComparisonWitnesses, projectQueryCoverage, rdjbByTitle,
  type AssessmentScope, type QueryAssessment, type QueryAssessmentSummary, type QueryMetadata,
} from './query-assessment-projection'

export * from './query-assessment-projection'

/** Execution-local, narrow identity keys only. Canonical keys need no entry.
 * Iterate existing covering indexes once per pinned export, not once per row.
 * No business writes, source bodies, persistent cache or truncation.
 */
function identityKeys(variants: IdentityKeyVariants, uscc: string | null): string[] {
  const normalized = normalizeUscc(uscc)
  return normalized ? [normalized, ...variants.get(normalized) ?? []] : []
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

export function readQueryCoverage(db: DecisionDb, scope: AssessmentScope, variants?: IdentityKeyVariants, ownQueryIds?: readonly number[]) {
  return projectQueryCoverage(queryMetadata(db, scope, variants, ownQueryIds), scope)
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
    set(scope, projectQueryCoverage({ uscc: targets[slot]!.uscc, truncated: rows.length > 50,
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
  return projectQueryComparisonWitnesses(queryMetadata(db, scope, variants, ownQueryIds), scope)
}
export function readQueryAssessment(db: DecisionDb, scope: AssessmentScope, variants?: IdentityKeyVariants, coverage?: ReturnType<typeof readQueryCoverage>) {
  scope = { enterpriseId: scope.enterpriseId, titleCode: scope.titleCode, direction: scope.direction }
  const currentDecision = currentDecision102(db, scope)
  return assessmentOf(db, scope, coverage ?? readQueryCoverage(db, scope, variants), currentDecision)
}
function assessmentOf(db: DecisionDb, scope: AssessmentScope, queryCoverage: ReturnType<typeof readQueryCoverage>, currentDecision = currentDecision102(db, scope), ownedImpact?: ReturnType<typeof readEvidenceImpact113>) {
  const current = currentDecision.current
  const impact = ownedImpact ?? readEvidenceImpact113(db, scope, current?.id ?? null)
  return projectQueryAssessment(scope, queryCoverage, currentDecision, impact)
}
export function readQueryAssessments(db: DecisionDb, scopes: AssessmentScope[], ownedCoverage?: ReturnType<typeof readQueryCoverageBatch>): QueryAssessment[] {
  scopes = scopes.map(({ enterpriseId, titleCode, direction }) => ({ enterpriseId, titleCode, direction }))
  const coverages = ownedCoverage ? scopes.map(scope => {
    const coverage = ownedCoverage.get(scope.enterpriseId)?.get(scope.titleCode)
    if (!coverage) throw new Error('Query assessment coverage scope missing')
    return coverage
  }) : readCoveragesForScopes(db, scopes)
  const decisions = currentDecisions102(db, scopes)
  const impacts = readEvidenceImpacts113(db, scopes.map((scope, index) => ({ scope, decisionId: decisions[index]!.current?.id ?? null, latestDecisionId: decisions[index]!.versionId })))
  return coverages.map((queryCoverage, index) => {
    const { enterpriseId, titleCode, direction } = scopes[index]!
    return assessmentOf(db, { enterpriseId, titleCode, direction }, queryCoverage, decisions[index]!, impacts[index]!)
  })
}

/** Scalar-only list projection; no full decision is hydrated and then discarded. */
export function readQueryAssessmentSummaries(db: DecisionDb, scopes: AssessmentScope[]): QueryAssessmentSummary[] {
  const decisions = currentDecisionStates102(db, scopes)
  const impacts = readEvidenceImpacts113(db, scopes.map((scope, index) => ({ scope, decisionId: decisions[index]!.current?.id ?? null, latestDecisionId: decisions[index]!.versionId })))
  return readCoveragesForScopes(db, scopes).map((queryCoverage, index) => {
    const { enterpriseId, titleCode, direction } = scopes[index]!
    const scope = { enterpriseId, titleCode, direction }
    const decision = decisions[index]!
    const impact = impacts[index]!
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
