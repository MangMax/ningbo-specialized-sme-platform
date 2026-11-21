import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { and, desc, eq, getTableName, isNull, sql } from 'drizzle-orm'
import { z } from 'zod'
import type * as schema from '../../../../db/schema'
import type { PlatformLiveQueryResult } from '../../lib/platform/live-query'
import { platformQueryResultShape } from '../../lib/platform/live-query'
import { platformResultToImport } from '../../lib/platform/recognized-evidence'
import { targetSchema as s } from '../../lib/platform/target-schema'
import { sqliteConnection } from '../../lib/platform/target-connection'
import { currentDifferenceAssignment, readDifferenceCollectionScope } from '../../lib/platform/difference-sources'
import { targetReplaySource } from '../../lib/platform/collection-target-replay'
import { canonicalPlatformJson } from './platform-business-record'
import { postgresRosterRow } from '../../lib/roster/postgres-rows'
import { readPostgresCollectionScopes } from '../../lib/roster/query-coverage-postgres'
import { readPostgresFingerprintQueries } from './postgres-platform-fingerprint'

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

export async function reusePostgresCollectedPlatformResult(db: Pick<NodePgDatabase,'execute'>, result: PlatformLiveQueryResult, enterpriseId: number) {
  const content = contents(result)
  if (content === null) return false
  const query = platformResultToImport(result)
  const { rows: [row] } = await db.execute<{ id:number; collection:typeof s.platformCollection.$inferSelect }>(sql`
    SELECT a.old_id::float8 AS id,${postgresRosterRow(s.platformCollection,'p')} AS collection
    FROM platform_collection p JOIN platform_legacy_query_alias a ON a.collection_id=p.id
    WHERE p.interface=${query.interface} AND p.query_key=${query.queryKey}
      AND p.rdjb=${query.rdjb ?? ''} AND p.title_code IS NOT DISTINCT FROM ${query.titleCode ?? null}
    ORDER BY p.queried_at DESC,a.old_id DESC LIMIT 1 FOR UPDATE OF p`)
  if (!row || row.collection.status !== query.status) return false
  const { collection } = row
  const { metadata,pages } = (await readPostgresCollectionScopes(db,[collection])).get(collection.id)!
  if (!metadata || metadata.completeness !== 'complete' || !metadata.fullRange ||
    metadata.source !== result.source || metadata.status !== result.status ||
    !pages.length || pages.some((p,index)=>p.pageNo!==index+1 || p.status!=='success') ||
    canonicalPlatformJson(metadata.effectiveConditions)!==canonicalPlatformJson(result.effectiveConditions) ||
    metadata.titleScope.mode!==result.titleScope.mode ||
    canonicalPlatformJson(metadata.titleScope.rdjb.toSorted())!==canonicalPlatformJson(result.titleScope.rdjb.toSorted())) return false
  const table = query.interface === 'apply_list' ? s.platformApplyProjection
    : query.interface === 'business_list' ? s.platformBusinessProjection : s.platformRecognizedProjection
  const { rows: incomplete } = await db.execute(sql`
    SELECT 1 FROM platform_business_observation o
    LEFT JOIN LATERAL (SELECT enterprise_id FROM platform_observation_assignment
      WHERE observation_id=o.id ORDER BY revision DESC LIMIT 1) a ON true
    LEFT JOIN ${sql.identifier(getTableName(table))} p ON p.version_id=o.version_id
    WHERE o.collection_id=${collection.id} AND (a.enterprise_id IS DISTINCT FROM ${enterpriseId}
      OR o.record_id IS NULL OR o.version_id IS NULL OR p.version_id IS NULL) LIMIT 1`)
  if (incomplete.length) return false
  const original = (await readPostgresFingerprintQueries(db,[row.id],false)).get(row.id)?.query.collectionEvidence
  if (!evidenceShape.safeParse(original).success || contents(original!)!==content) return false
  if (Date.parse(result.queriedAt)>Date.parse(collection.lastCollectedAt ?? collection.queriedAt)) {
    await db.execute(sql`UPDATE platform_collection SET last_collected_at=${result.queriedAt} WHERE id=${collection.id}`)
  }
  return true
}
