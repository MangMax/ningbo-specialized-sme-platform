import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import { z } from 'zod'
import type * as schema from '../../db/schema'
import type { PlatformLiveQueryResult } from '../../lib/platform/live-query'
import { platformQueryResultShape } from '../../lib/platform/live-query'
import { platformResultToImport } from '../../lib/platform/recognized-evidence'
import { targetSchema as s } from '../../lib/platform/target-schema'
import { sqliteConnection } from '../../lib/platform/target-connection'
import { currentDifferenceAssignment, readDifferenceCollectionScope } from '../../lib/platform/difference-sources'
import { targetReplaySource } from '../../lib/platform/collection-target-replay'
import { canonicalPlatformJson } from './platform-business-record'

type Db = BetterSQLite3Database<typeof schema>
const evidenceShape = z.object(platformQueryResultShape)
function contents(result: PlatformLiveQueryResult) {
  const rows = result.dataRows ?? result.rawData?.rows
  if (!result.pages.length || result.pages.some((page, index) => page.page !== index + 1 || page.status !== 'success')) return null
  if (!rows || result.completeness !== 'complete' || !result.fullRange || !['success', 'no_record'].includes(result.status)) return null
  return canonicalPlatformJson({
    source: result.source, conditions: result.effectiveConditions, scope: result.titleScope,
    status: result.status, rows: rows.map(canonicalPlatformJson).sort(),
  })
}
/** Typed facts admit the candidate; sealed originals serve content equality only.
 * The caller's connection/savepoint owns recency and its checkpoint together. */
function reuseTarget(db: Db, result: PlatformLiveQueryResult, enterpriseId: number, content: string, query: ReturnType<typeof platformResultToImport>) {
  return db.transaction(tx => {
    const c = s.platformCollection, qa = s.platformLegacyQueryAlias
    const previous = tx.select({ collection: c }).from(c).innerJoin(qa, eq(qa.collectionId, c.id))
      .where(and(eq(c.interface, query.interface), eq(c.queryKey, query.queryKey), eq(c.rdjb, query.rdjb ?? ''),
        query.titleCode == null ? isNull(c.titleCode) : eq(c.titleCode, query.titleCode)))
      .orderBy(desc(c.queriedAt), desc(qa.oldId)).limit(1).get()?.collection
    // Select latest first: an ineligible latest collection must not expose an older one.
    if (!previous || previous.status !== query.status) return false
    const { metadata, pages } = readDifferenceCollectionScope(tx, previous.id)
    if (!metadata || metadata.completeness !== 'complete' || !metadata.fullRange ||
      metadata.source !== result.source || metadata.status !== result.status ||
      !pages.length || pages.some((p, index) => p.pageNo !== index + 1 || p.status !== 'success') ||
      canonicalPlatformJson(metadata.effectiveConditions) !== canonicalPlatformJson(result.effectiveConditions) ||
      metadata.titleScope.mode !== result.titleScope.mode ||
      canonicalPlatformJson(metadata.titleScope.rdjb.toSorted()) !== canonicalPlatformJson(result.titleScope.rdjb.toSorted())) return false
    const o = s.platformBusinessObservation, a = s.platformObservationAssignment
    const p = query.interface === 'apply_list' ? s.platformApplyProjection
      : query.interface === 'business_list' ? s.platformBusinessProjection : s.platformRecognizedProjection
    const incomplete = tx.select({ id: o.id }).from(o)
      .leftJoin(a, currentDifferenceAssignment(tx)).leftJoin(p, eq(p.versionId, o.versionId))
      .where(and(eq(o.collectionId, previous.id),
        sql`(${a.enterpriseId} is not ${enterpriseId} or ${o.recordId} is null or ${o.versionId} is null or ${p.versionId} is null)`)).limit(1).get()
    if (incomplete) return false
    // This existing owner authenticates sealed archive bytes. Unknown/missing
    // evidence is a reuse miss, never an invitation to reconstruct raw rows.
    try {
      const original = targetReplaySource(tx, sqliteConnection(tx), previous).source.metadata.collectionEvidence
      if (!evidenceShape.safeParse(original).success || contents(original as PlatformLiveQueryResult) !== content) return false
    } catch { return false }
    if (Date.parse(result.queriedAt) > Date.parse(previous.lastCollectedAt ?? previous.queriedAt)) {
      tx.update(c).set({ lastCollectedAt: result.queriedAt }).where(eq(c.id, previous.id)).run()
    }
    return true
  })
}
/** Reuse only the latest complete result in this exact query scope. Partial
 * segments and unresolved identities still need normal import validation. */
export function reuseCollectedPlatformResult(db: Db, result: PlatformLiveQueryResult, enterpriseId: number): boolean {
  const content = contents(result)
  if (content === null) return false
  const query = platformResultToImport(result)
  return reuseTarget(db, result, enterpriseId, content, query)
}
