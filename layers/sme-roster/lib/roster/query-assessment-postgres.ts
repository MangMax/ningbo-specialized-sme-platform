import { and, eq, inArray, sql } from 'drizzle-orm'
import { enterprise } from '../../../../db/postgresql/enterprise-tables'
import { platformCollection } from '../../../../db/postgresql/platform-tables'
import { differenceReason } from '../../../../db/postgresql/roster-selection-tables'
import { currentPostgresDecisions102 } from '../../server/utils/decision-lifecycle/postgres-reads'
import { projectRetiredEvidenceAssessment, type AssessmentScope } from './query-assessment-projection'
import { isCurrentPlatformCollection } from '../platform/current-observation-postgres'
import { readPostgresDifferenceObservations } from '../platform/difference-sources-postgres'
import { readPostgresQueryCoverage } from './query-coverage-postgres'

export async function readPostgresQueryAssessments(db: Parameters<typeof readPostgresQueryCoverage>[0], scopes: readonly AssessmentScope[], ownedCoverage?: Awaited<ReturnType<typeof readPostgresQueryCoverage>>) {
  if (!scopes.length) return []
  const requested = scopes.map(({enterpriseId,titleCode,direction}) => ({enterpriseId,titleCode,direction}))
  const decisions = await currentPostgresDecisions102(db, requested)
  const relationIds = decisions.flatMap(({ current }) => current?.evidenceRelationId != null ? [current.evidenceRelationId] : [])
  const currentEvidence = await readPostgresDifferenceObservations(db, relationIds)
  const queryIds = decisions.flatMap(({ current }) => current?.evidenceRelationId == null && current?.evidenceQueryId != null ? [current.evidenceQueryId] : [])
  const currentQueries = queryIds.length ? new Set((await db.select({ id: platformCollection.publicId }).from(platformCollection)
    .where(and(inArray(platformCollection.publicId, [...new Set(queryIds)]), isCurrentPlatformCollection(db, platformCollection, 'evidence')))).map(row => row.id)) : new Set<number>()
  const currentIds = decisions.flatMap(item => item.current ? [item.current.id] : [])
  const historical = currentIds.length ? await db.select({
    id: differenceReason.id, validity: differenceReason.retiredEvidenceValidity, reviewed: differenceReason.retiredEvidenceReviewed,
  }).from(differenceReason).where(eq(differenceReason.id, sql`ANY(${sql.param(currentIds)}::bigint[])`)) : []
  const byDecisionId = new Map(historical.map(item => [item.id, item]))
  let coverage = ownedCoverage
  if (!coverage) {
    const rows = await db.select({ id: enterprise.id, uscc_norm: enterprise.usccNorm, name_norm: enterprise.nameNorm })
      .from(enterprise).where(inArray(enterprise.id, [...new Set(scopes.map(scope => scope.enterpriseId))]))
    coverage = await readPostgresQueryCoverage(db, rows, [...new Set(scopes.map(scope => scope.titleCode))])
  }
  return requested.map((scope, index) => {
    const item = coverage.get(scope.enterpriseId)?.get(scope.titleCode)
    if (!item) throw new Error('Query assessment coverage scope missing')
    const decision = decisions[index]!
    const baseline = decision.current ? byDecisionId.get(decision.current.id) : undefined
    const relationId = decision.current?.evidenceRelationId
    const queryId = decision.current?.evidenceQueryId
    const outdated = relationId != null ? !currentEvidence.has(relationId) : queryId != null && !currentQueries.has(queryId)
    const savedValidity = baseline?.validity ?? null
    const validity = outdated && savedValidity !== 'premise_invalid' ? 'evidence_changed' : savedValidity
    return projectRetiredEvidenceAssessment(scope, item, decision, validity, !outdated && baseline?.reviewed === true)
  })
}
