import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { and, desc, eq, isNotNull, isNull, ne, or } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import {
  platformApplyProjection, platformBusinessObservation, platformBusinessProjection, platformCollection,
  platformLegacyQueryAlias, platformObservationAssignment, platformRecognizedProjection,
} from '../../../../db/postgresql/platform-tables'
import { z } from 'zod'
import type * as s from '../../../../db/schema'
import type { PlatformLiveQueryResult } from '../../lib/platform/live-query'
import { platformQueryResultShape } from '../../lib/platform/live-query'
import { platformResultToImport } from '../../lib/platform/recognized-evidence'
import { canonicalPlatformJson } from './platform-business-record'
import { readPostgresCollectionScopes } from '../../lib/roster/query-coverage-postgres'
import { readPostgresFingerprintQueries } from './postgres-platform-fingerprint'

export const collectionEvidenceShape = z.object(platformQueryResultShape)
export function reusableCollectionContent(result: PlatformLiveQueryResult) {
  const rows = result.dataRows ?? result.rawData?.rows
  if (!result.pages.length || result.pages.some((page, index) => page.page !== index + 1 || page.status !== 'success')) return null
  if (!rows || result.completeness !== 'complete' || !result.fullRange || !['success', 'no_record'].includes(result.status)) return null
  return canonicalPlatformJson({
    source: result.source, conditions: result.effectiveConditions, scope: result.titleScope,
    status: result.status, rows: rows.map(canonicalPlatformJson).sort(),
  })
}
export async function reusePostgresCollectedPlatformResult(db: Pick<NodePgDatabase, 'select' | 'update'>, result: PlatformLiveQueryResult, enterpriseId: number) {
  const content = reusableCollectionContent(result)
  if (content === null) return false
  const query = platformResultToImport(result)
  // FOR UPDATE OF accepts the unqualified relation alias even though FROM uses business.
  const c = alias(platformCollection, 'collection')
  const qa = platformLegacyQueryAlias
  const [row] = await db.select({ id: qa.oldId, collection: c }).from(c).innerJoin(qa, eq(qa.collectionId, c.id))
    .where(and(eq(c.interface, query.interface), eq(c.queryKey, query.queryKey), eq(c.rdjb, query.rdjb ?? ''),
      query.titleCode == null ? isNull(c.titleCode) : eq(c.titleCode, query.titleCode)))
    .orderBy(desc(c.queriedAt), desc(qa.oldId)).limit(1).for('update', { of: c })
  if (!row || row.collection.status !== query.status) return false
  const { collection } = row
  const { metadata,pages } = (await readPostgresCollectionScopes(db, [collection as typeof s.platformCollection.$inferSelect])).get(collection.id)!
  if (!metadata || metadata.completeness !== 'complete' || !metadata.fullRange ||
    metadata.source !== result.source || metadata.status !== result.status ||
    !pages.length || pages.some((p,index)=>p.pageNo!==index+1 || p.status!=='success') ||
    canonicalPlatformJson(metadata.effectiveConditions)!==canonicalPlatformJson(result.effectiveConditions) ||
    metadata.titleScope.mode!==result.titleScope.mode ||
    canonicalPlatformJson(metadata.titleScope.rdjb.toSorted())!==canonicalPlatformJson(result.titleScope.rdjb.toSorted())) return false
  const p = query.interface === 'apply_list' ? platformApplyProjection
    : query.interface === 'business_list' ? platformBusinessProjection : platformRecognizedProjection
  const o = platformBusinessObservation
  const a = platformObservationAssignment
  const latest = db.select({ enterpriseId: a.enterpriseId, observationId: a.observationId }).from(a)
    .where(eq(a.observationId, o.id)).orderBy(desc(a.revision)).limit(1).as('latest_assignment')
  const incomplete = await db.select({ id: o.id }).from(o)
    .leftJoinLateral(latest, isNotNull(latest.observationId)).leftJoin(p, eq(p.versionId, o.versionId))
    .where(and(eq(o.collectionId, collection.id), or(isNull(latest.enterpriseId), ne(latest.enterpriseId, enterpriseId),
      isNull(o.recordId), isNull(o.versionId), isNull(p.versionId)))).limit(1)
  if (incomplete.length) return false
  const original = (await readPostgresFingerprintQueries(db,[row.id],false)).get(row.id)?.query.collectionEvidence
  if (!collectionEvidenceShape.safeParse(original).success || reusableCollectionContent(original!)!==content) return false
  if (Date.parse(result.queriedAt)>Date.parse(collection.lastCollectedAt ?? collection.queriedAt)) {
    await db.update(platformCollection).set({ lastCollectedAt: result.queriedAt }).where(eq(platformCollection.id, collection.id))
  }
  return true
}
