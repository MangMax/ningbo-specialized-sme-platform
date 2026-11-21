import { eq, inArray, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { enterprise } from '../../../../db/postgresql/enterprise-tables'
import { evidenceScopeVersion113, explanationImpact113 } from '../../../../db/postgresql/evidence-review-tables'
import * as schema from '../../../../db/schema'
import { currentPostgresDecisions102 } from '../../server/utils/decision-lifecycle-102/postgres-reads'
import { evidenceKeys113, evidenceToken113, type readEvidenceImpacts113 } from '../../server/utils/evidence-impact-113'
import { postgresRosterRow } from './postgres-rows'
import { projectQueryAssessment, type AssessmentScope } from './query-assessment'
import { readPostgresQueryCoverage } from './query-coverage-postgres'

type Reader = Pick<NodePgDatabase, 'select'>
type ScopeInput = Parameters<typeof readEvidenceImpacts113>[1]
type Impact = typeof schema.explanationImpact113.$inferSelect
const ids = (values: readonly number[]) => sql`${sql.param(values)}::bigint[]`

export async function readPostgresEvidenceImpacts113(db: Reader, inputs: ScopeInput) {
  if (!inputs.length) return []
  const keys = [...new Set(inputs.flatMap(input => evidenceKeys113(input.scope)))]
  const version = evidenceScopeVersion113
  const versions = await db.select().from(version).where(eq(version.scopeKey, sql`ANY(${sql.param(keys)}::text[])`))
  const byKey = new Map(versions.map(row => [row.scopeKey, row]))
  const activeIds = [...new Set(inputs.flatMap(input => input.decisionId === null ? [] : [input.decisionId]))]
  const source = alias(explanationImpact113, 'p')
  const impacts = activeIds.length ? await db.select({
    row: sql<Impact>`${postgresRosterRow(schema.explanationImpact113,'p')}`,
  }).from(source).where(eq(source.decisionId, sql`ANY(${ids(activeIds)})`)) : []
  const byDecision = new Map(impacts.map(({ row }) => [row.decisionId, row]))
  return inputs.map(({ scope, decisionId, latestDecisionId }) => {
    const impact = decisionId === null ? undefined : byDecision.get(decisionId)
    const state = impact && impact.enterpriseId === scope.enterpriseId && impact.titleCode === scope.titleCode && impact.direction === scope.direction ? impact : null
    const selected = evidenceKeys113(scope).flatMap(key => byKey.has(key) ? [byKey.get(key)!] : [])
    return { state, token: evidenceToken113(scope, latestDecisionId, selected), hasReviewedBaseline: state?.reviewedRevisionId != null }
  })
}

export async function readPostgresQueryAssessments(db: Parameters<typeof readPostgresQueryCoverage>[0], scopes: readonly AssessmentScope[], ownedCoverage?: Awaited<ReturnType<typeof readPostgresQueryCoverage>>) {
  if (!scopes.length) return []
  const requested = scopes.map(({enterpriseId,titleCode,direction}) => ({enterpriseId,titleCode,direction}))
  const decisions = await currentPostgresDecisions102(db, requested)
  const impacts = await readPostgresEvidenceImpacts113(db, decisions.map((row, index) => ({
    scope: requested[index]!, decisionId: row.current?.id ?? null, latestDecisionId: row.versionId,
  })))
  let coverage = ownedCoverage
  if (!coverage) {
    const rows = await db.select({ id: enterprise.id, uscc_norm: enterprise.usccNorm, name_norm: enterprise.nameNorm })
      .from(enterprise).where(inArray(enterprise.id, [...new Set(scopes.map(scope => scope.enterpriseId))]))
    coverage = await readPostgresQueryCoverage(db, rows, [...new Set(scopes.map(scope => scope.titleCode))])
  }
  return requested.map((scope, index) => {
    const item = coverage.get(scope.enterpriseId)?.get(scope.titleCode)
    if (!item) throw new Error('Query assessment coverage scope missing')
    return projectQueryAssessment(scope, item, decisions[index]!, impacts[index]!)
  })
}
