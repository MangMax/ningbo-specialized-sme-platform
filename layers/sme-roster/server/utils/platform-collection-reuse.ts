import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { and, desc, eq, count, isNotNull, isNull, ne, not, or } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import {
  platformApplyProjection, platformBusinessObservation, platformBusinessProjection, platformCollection,
  platformObservationAssignment, platformRecognizedProjection,
} from '../../../../db/postgresql/platform-tables'
import { isCurrentPlatformObservation } from '../../lib/platform/current-observation-postgres'
import type { DifferenceCollectionScopeRows } from '../../lib/platform/difference-collection-scope'
import type { PlatformLiveQueryResult } from '../../lib/platform/live-query'
import { platformResultToImport } from '../../lib/platform/recognized-evidence'
import { canonicalPlatformJson } from './platform-business-record'
import { readPostgresCollectionScopes } from '../../lib/roster/query-coverage-postgres'
import { platformCollectionReuseSha256 } from '../../lib/platform/collection-reuse-digest'

export async function reusePostgresCollectedPlatformResult(db: Pick<NodePgDatabase, 'select' | 'update'>, result: PlatformLiveQueryResult, enterpriseId: number) {
  const digest = platformCollectionReuseSha256(result)
  if (digest === null) return false
  const query = platformResultToImport(result)
  // FOR UPDATE OF accepts the unqualified relation alias even though FROM uses business.
  const c = alias(platformCollection, 'collection')

  const [row] = await db.select({ id: c.publicId, collection: c }).from(c)
    .where(and(eq(c.interface, query.interface), eq(c.queryKey, query.queryKey), eq(c.rdjb, query.rdjb ?? ''),
      query.titleCode == null ? isNull(c.titleCode) : eq(c.titleCode, query.titleCode)))
    .orderBy(desc(c.queriedAt), desc(c.publicId)).limit(1).for('update', { of: c })
  if (!row || row.collection.status !== query.status || row.collection.reusableContentSha256 !== digest) return false
  const { collection } = row
  const { metadata,pages } = (await readPostgresCollectionScopes(db, [collection as DifferenceCollectionScopeRows['collection']])).get(collection.id)!
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
      isNull(o.recordId), isNull(o.versionId), isNull(p.versionId), not(isCurrentPlatformObservation(db)!)))).limit(1)
  if (incomplete.length) return false
  const [stored] = await db.select({ rows: count() }).from(o).where(eq(o.collectionId, collection.id))
  if (stored!.rows !== (query.relations?.length ?? 0)) return false
  if (Date.parse(result.queriedAt)>Date.parse(collection.lastCollectedAt ?? collection.queriedAt)) {
    await db.update(platformCollection).set({ lastCollectedAt: result.queriedAt }).where(eq(platformCollection.id, collection.id))
  }
  return true
}
