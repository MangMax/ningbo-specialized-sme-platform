import { and, asc, eq, sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../../../../db/schema'
import { readQueryAssessments } from '../../lib/roster/query-assessment'
import { listRosterEnterprises } from '../../lib/roster/enterprise-roster'
import { enterpriseListFilter, pageOf, projectListDifferences, type ListEnterprisesInput, type ListEnterprisesResult, type ListDifferencesInput, type ListDifferencesResult } from './mcp-roster-postgres'

type Db = BetterSQLite3Database<typeof schema>

export * from './mcp-roster-postgres'

/**
 * 企业总表（**跨称号去重**：一行 = 一家企业，`titles` 是它拿过的称号）。
 * 所有筛选、首次认定字段和计数都由 REST 共用读模型计算，避免 MCP 与 UI/HTTP 结果分叉。
 */
export function listEnterprises(db: Db, input: ListEnterprisesInput = {}): ListEnterprisesResult {
  return listRosterEnterprises(db, enterpriseListFilter(input))
}

/**
 * 差异与解释。**当前解释 = `recordedAt` 最新那条**（旧解释不丢，只是不再出现在这里）。
 */
export function listDifferences(db: Db, input: ListDifferencesInput = {}): ListDifferencesResult {
  // Latest-version and evidence summary projection happen in SQL, before pagination.
  // This never materializes unrelated raw_response/collection_evidence or historical notes.
  return db.transaction(tx => {
    const d = schema.differenceReason
    const where = and(
      sql`not exists (select 1 from difference_reason newer where newer.enterprise_id=${d.enterpriseId} and newer.title_code=${d.titleCode} and newer.direction=${d.direction} and (newer.recorded_at > ${d.recordedAt} or (newer.recorded_at = ${d.recordedAt} and newer.id > ${d.id})))`,
      input.title ? eq(d.titleCode, input.title) : undefined,
      input.direction ? eq(d.direction, input.direction) : undefined,
      input.status ? eq(d.status, input.status as typeof schema.differenceReason.$inferSelect.status) : undefined,
    )
    const counts: Record<string, Record<string, number>> = {}
    for (const group of tx.select({ titleCode: d.titleCode, direction: d.direction, n: sql<number>`count(*)` }).from(d).where(where).groupBy(d.titleCode,d.direction).all()) {
      counts[group.titleCode] ??= {}
      counts[group.titleCode]![group.direction] = group.n
    }
    const { page,pageSize } = pageOf(input)
    const rows = tx.select({ enterpriseId: d.enterpriseId, name: schema.enterprise.name, titleCode: d.titleCode, direction: d.direction, status: d.status, reasonCode: d.reasonCode,
      measureCode: d.measureCode, verificationStatus: d.verificationStatus, recordedAt: d.recordedAt, factReferences: d.factReferences,
      movedInCity: d.movedInCity, movedInTitleCode: d.movedInTitleCode, movedInYear: d.movedInYear, movedInBatch: d.movedInBatch,
      queryId: schema.platformLegacyQueryAlias.oldId, queriedAt: schema.platformCollection.queriedAt, queryInterface: schema.platformCollection.interface, queryStatus: schema.platformCollection.status,
    }).from(d).innerJoin(schema.enterprise,eq(schema.enterprise.id,d.enterpriseId)).leftJoin(schema.platformCollection,eq(schema.platformCollection.id,d.evidenceCollectionId)).leftJoin(schema.platformLegacyQueryAlias,eq(schema.platformLegacyQueryAlias.collectionId,schema.platformCollection.id)).where(where)
      .orderBy(asc(d.enterpriseId),asc(d.titleCode),asc(d.direction)).limit(pageSize).offset((page-1)*pageSize).all()
    const assessments = readQueryAssessments(db, rows)
    return { rows: projectListDifferences(rows, assessments), counts }

  })
}
