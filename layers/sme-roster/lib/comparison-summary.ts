import { differenceEvidenceColumns } from './platform/difference-reference-target'
import { identityFunctions } from './roster/enterprise-read-snapshot'
import { inArray, sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../../../db/schema'
import { readComparisonTargetMemberships } from './comparison-platform'
import { targetSchema as target } from './platform/target-schema'
import type { ComparisonRowFilter } from './comparison-filter'
import type { getCuratedComparison } from './curation'
import type { ReconcileIndex } from './reconcile'
import { readQueryAssessmentSummaries } from './roster/query-assessment'

import { selectComparisonSummaryPage, projectComparisonSummary } from './comparison-summary-projection'

export * from './comparison-summary-projection'

/**
 * Keep global/filter counts on narrow SQL projections. Only the selected page gets
 * relation counts and a response DTO; never hydrate platform or cache originals.
 * The base comparison/curation reader already projects record/enterprise scalars.
 */
export function readComparisonSummary(
  db: BetterSQLite3Database<typeof schema>,
  result: ReturnType<typeof getCuratedComparison>,
  reconcile: ReconcileIndex,
  filter: ComparisonRowFilter,
  page: number,
  pageSize: number,
) {
  const ids = [...new Set(result.rows.map(row => row.enterpriseId))]
  const aliases = ids.length ? db.select({
    enterpriseId: schema.enterpriseAlias.enterpriseId,
    name: schema.enterpriseAlias.name,
    verificationStatus: schema.enterpriseAlias.verificationStatus,
  }).from(schema.enterpriseAlias).where(inArray(schema.enterpriseAlias.enterpriseId, ids)).all() : []
  const aliasesByEnterprise = new Map<number, typeof aliases>()
  for (const alias of aliases) {
    const bucket = aliasesByEnterprise.get(alias.enterpriseId) ?? []
    bucket.push(alias)
    aliasesByEnterprise.set(alias.enterpriseId, bucket)
  }

  // Match the legacy inclusion union: related enterprise OR its own query key.
  // Neither a candidate relation nor an own-key match confirms identity.
  if (ids.length) identityFunctions(db)
  const memberships = readComparisonTargetMemberships(db, ids)
  const queriesByEnterprise = new Map<number, number[]>()
  for (const member of memberships) {
    const bucket = queriesByEnterprise.get(member.enterpriseId) ?? []
    bucket.push(member.queryId)
    queriesByEnterprise.set(member.enterpriseId, bucket)
  }

  // Select no reason/measure notes or JSON actor/basis/history fields.
  const dispositions = ids.length ? db.select({
    enterpriseId: schema.differenceReason.enterpriseId,
    titleCode: schema.differenceReason.titleCode,
    direction: schema.differenceReason.direction,
    explanationId: schema.differenceReason.id,
    status: schema.differenceReason.status,
    reasonCode: schema.differenceReason.reasonCode,
    measureCode: schema.differenceReason.measureCode,
    verificationStatus: schema.differenceReason.verificationStatus,
    recordedAt: schema.differenceReason.recordedAt,
    ...differenceEvidenceColumns(db),
  }).from(schema.differenceReason).where(inArray(schema.differenceReason.enterpriseId, ids)).all() : []
  const { scoped, selected } = selectComparisonSummaryPage(result, filter, page, pageSize, aliasesByEnterprise)
  const assessments = readQueryAssessmentSummaries(db, selected.map(row => ({
    enterpriseId: row.enterpriseId, titleCode: row.titleCode, direction: row.direction,
  })))
  const selectedQueryIds = [...new Set(selected.flatMap(row => queriesByEnterprise.get(row.enterpriseId) ?? []))]
  const relationCounts = new Map<number, number>()
  // Bound bind parameters even for an enterprise with a long query history.
  for (let start = 0; start < selectedQueryIds.length; start += 500) {
    const qa = target.platformLegacyQueryAlias, o = target.platformBusinessObservation
    const counts = db.select({ queryId: qa.oldId, count: sql<number>`count(*)` })
      .from(o).innerJoin(qa, sql`${qa.collectionId}=${o.collectionId}`)
      .where(inArray(qa.oldId, selectedQueryIds.slice(start, start + 500))).groupBy(qa.oldId).all()
    for (const row of counts) relationCounts.set(row.queryId, row.count)
  }
  return projectComparisonSummary(result, reconcile, scoped, selected, dispositions, queriesByEnterprise, relationCounts, assessments)
}
