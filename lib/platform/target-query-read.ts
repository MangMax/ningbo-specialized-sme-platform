/** Generic history selection. Archives are display/budget inputs only after SQL pagination. */
import { and, desc, eq, exists, inArray, max, or, sql, type SQL } from 'drizzle-orm'
import { alias } from 'drizzle-orm/sqlite-core'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { z } from 'zod'
import * as schema from '../../db/schema'
import { targetSchema as s } from './target-schema'
import { MAX_PAGE_SIZE } from '../query'
import { RDJB_TITLE_CODES } from './recognized-evidence'
import { readTargetRelationDisplay } from './target-relation-display'
import { readTargetCollectionDisplay, targetLegacyCollectionExpression } from './target-query-display'
import type { PlatformQueryFilter, PlatformQueriesResult, PlatformRelationRow } from './read'
import { MAX_FULL_QUERY_BYTES, MAX_FULL_PAGE_BYTES } from './evidence-contract'

const c = s.platformCollection, qa = s.platformLegacyQueryAlias, o = s.platformBusinessObservation
const a = s.platformObservationAssignment, original = alias(a, 'history_original'), newer = alias(a, 'history_newer')
type Db = BetterSQLite3Database<typeof schema>
const text = z.string().nullable()
const relationShape = z.object({
  id: z.number(), queryId: z.number(), sequenceNo: z.number(), relationKey: text,
  enterpriseId: z.number().nullable(), sourceText: text, usccRaw: text, nameRaw: text, aliasNameRaw: text,
  province: text, status: text, batch: text, declareKind: text, appliedAt: text, awardBatchLabel: text,
  year: z.number().nullable(), matchBasis: z.string(), verificationStatus: z.string(),
  rawFields: z.record(z.string(), z.unknown()).nullable(),
  sourceRdjb: text.optional(), sourcePage: z.number().nullable().optional(),
  normalizationConflicts: z.array(z.object({
    field: z.enum(['province', 'status', 'batch', 'declareKind', 'appliedAt', 'awardBatchLabel', 'year']),
    storedValue: z.union([z.string(), z.number()]), rawValue: z.union([z.string(), z.number()]),
  })).optional(),
})
function clamp(value: number | undefined, fallback: number, max = Number.MAX_SAFE_INTEGER) {
  const n = Number(value)
  return !Number.isFinite(n) || n < 1 ? fallback : Math.min(Math.floor(n), max)
}
export function listTargetPlatformQueries(db: Db, filter: PlatformQueryFilter): PlatformQueriesResult {
  return db.transaction(tx => {
    if (filter.view === 'summary' && filter.includeRawResponse) throw Object.assign(new Error('Invalid view or includeRawResponse combination'), { statusCode: 400 })
    const conditions: SQL[] = []
    if (filter.queryId != null) conditions.push(eq(qa.oldId, filter.queryId))
    if (filter.interface) conditions.push(eq(c.interface, filter.interface))
    if (filter.queryKey) conditions.push(eq(c.queryKey, filter.queryKey))
    if (filter.status) conditions.push(eq(c.status, filter.status))
    if (filter.uscc) conditions.push(or(eq(c.queryKey, filter.uscc), exists(tx.select({ id: o.id }).from(o)
      .innerJoin(original, and(eq(original.observationId, o.id), eq(original.revision, 1)))
      .where(and(eq(o.collectionId, c.id), eq(original.usccRaw, filter.uscc)))))!)
    if (filter.enterpriseId != null) conditions.push(exists(tx.select({ id: o.id }).from(o)
      .innerJoin(a, and(eq(a.observationId, o.id), eq(a.revision, tx.select({ n: max(newer.revision) }).from(newer).where(eq(newer.observationId, o.id)))))
      .where(and(eq(o.collectionId, c.id), eq(a.enterpriseId, filter.enterpriseId)))))
    if (filter.titleCode) {
      // Preserve the old malformed-membership error in exactly the pre-title filter scope.
      const error = s.platformQueryTitleScopeError, r = s.platformCollectionArchiveRef, v = s.platformArchiveValue
      const marked = tx.select({ id: c.id }).from(c).innerJoin(qa, eq(qa.collectionId, c.id))
        .innerJoin(error, eq(error.collectionId, c.id)).where(and(...conditions, sql`(${c.titleCode} is null or ${c.titleCode} <> ${filter.titleCode})`)).limit(1).get()
      if (marked) tx.all(sql`select value from json_each(json_extract((select cast(${v.bytes} as text) from ${r}
        inner join ${v} on ${v.id}=${r.archiveId} where ${r.ownerId}=${marked.id} and ${r.field}='collectionEvidence'), '$.titleScope.rdjb'))`)
      const scope = s.platformQueryTitleScope
      const rdjb = Object.keys(RDJB_TITLE_CODES).find(key => RDJB_TITLE_CODES[key] === filter.titleCode) ?? ''
      conditions.push(or(eq(c.titleCode, filter.titleCode), exists(tx.select({ id: scope.collectionId }).from(scope)
        .where(and(eq(scope.collectionId, c.id), eq(scope.rdjb, rdjb)))))!)
    }
    const where = and(...conditions)
    const countRows = tx.select({ status: c.status, count: sql<number>`count(*)` }).from(c)
      .innerJoin(qa, eq(qa.collectionId, c.id)).where(where).groupBy(c.status).all()
    const counts = Object.fromEntries(countRows.map(row => [row.status, row.count]))
    const page = clamp(filter.page, 1), pageSize = clamp(filter.pageSize, 25, MAX_PAGE_SIZE)
    const selected = tx.select({ collection: c, id: qa.oldId }).from(c).innerJoin(qa, eq(qa.collectionId, c.id))
      .where(where).orderBy(desc(c.queriedAt), desc(qa.oldId)).limit(pageSize)
      .offset(Math.min(Number.MAX_SAFE_INTEGER, (page - 1) * pageSize)).all()
    const ids = selected.map(row => row.collection.id), summary = filter.view === 'summary'
    const relationCounts = ids.length ? tx.select({ id: o.collectionId, count: sql<number>`count(*)` }).from(o)
      .where(inArray(o.collectionId, ids)).groupBy(o.collectionId).all() : []
    const countById = new Map(relationCounts.map(row => [row.id, row.count]))
    if (!summary) {
      // The same original cell-byte budget as schema0, evaluated inside SQLite.
      // Snapshot JSON is a selected evidence owner, never a membership/order/count input.
      const r = s.platformCollectionArchiveRef, v = s.platformArchiveValue
      const budget = selected.map(row => {
        const legacy = targetLegacyCollectionExpression(tx, row.collection.id)
        const bytes = tx.get<{ n: number }>(sql`select
          coalesce((select ${v.byteLength} from ${r} join ${v} on ${v.id}=${r.archiveId}
            where ${r.ownerId}=${row.collection.id} and ${r.field}='collectionEvidence'),0) +
          coalesce(length(cast(json_remove(${legacy}, '$.rows') as blob)),0) +
          ${filter.includeRawResponse ? sql`coalesce((select ${v.byteLength} from ${r} join ${v} on ${v.id}=${r.archiveId}
            where ${r.ownerId}=${row.collection.id} and ${r.field}='rawResponse'),0)` : sql`0`} +
          coalesce((select sum(1024 + coalesce(length(cast(e.name as blob)),0) +
            coalesce((select sum(length(json_extract(cell.value,'$.hex')) / 2)
              from platform_observation_archive_ref ar join platform_archive_value av on av.id=ar.archive_id,
                json_each(cast(av.bytes as text),'$.fields') cell
              where ar.owner_id=ob.id and ar.field='legacyRowSnapshot'
                and json_extract(cell.value,'$.name') in ('raw_fields','source_text','name_raw','alias_name_raw',
                  'uscc_raw','relation_key','province','status','batch','declare_kind','applied_at','award_batch_label')),0))
            from platform_business_observation ob
            join platform_observation_assignment ca on ca.observation_id=ob.id
              and ca.revision=(select max(na.revision) from platform_observation_assignment na where na.observation_id=ob.id)
            left join enterprise e on e.id=ca.enterprise_id where ob.collection_id=${row.collection.id}),0) as n`)!.n
        return bytes
      })
      if (budget.some(n => n > MAX_FULL_QUERY_BYTES) || budget.reduce((n, b) => n + b, 0) > MAX_FULL_PAGE_BYTES) {
        const message = 'Platform evidence exceeds full-read budget; use view=summary and /api/platform/queries/{queryId}/evidence (get_platform_query_evidence)'
        throw Object.assign(new Error(message), { statusCode: 413, statusMessage: message })
      }
    }
    const relationIds = !summary && ids.length ? tx.select({ id: s.platformLegacyRelationAlias.oldId, collectionId: o.collectionId })
      .from(o).innerJoin(s.platformLegacyRelationAlias, eq(s.platformLegacyRelationAlias.observationId, o.id))
      .where(inArray(o.collectionId, ids)).orderBy(o.collectionId, o.sequenceNo).all() : []
    const displays = readTargetRelationDisplay(tx, relationIds.map(row => ({ relationId: row.id })), { fullCollectionEvidence: true })
    const byCollection = new Map<number, PlatformRelationRow[]>()
    const names = !summary && ids.length ? tx.select({ id: s.platformLegacyRelationAlias.oldId, name: s.enterprise.name })
      .from(o).innerJoin(s.platformLegacyRelationAlias, eq(s.platformLegacyRelationAlias.observationId, o.id))
      .innerJoin(a, and(eq(a.observationId, o.id), eq(a.revision, tx.select({ n: max(newer.revision) }).from(newer).where(eq(newer.observationId, o.id)))))
      .leftJoin(s.enterprise, eq(s.enterprise.id, a.enterpriseId)).where(inArray(o.collectionId, ids)).all() : []
    const namesById = new Map(names.map(row => [row.id, row.name]))
    for (const row of relationIds) {
      const relation = { ...relationShape.parse(displays.sources.get(row.id)), matchedName: namesById.get(row.id) ?? null }
      const bucket = byCollection.get(row.collectionId) ?? []
      bucket.push(relation); byCollection.set(row.collectionId, bucket)
    }
    // Collections without observations still have their own original evidence.
    const displayByCollection = summary ? new Map() : readTargetCollectionDisplay(tx, selected, displays.sources, filter.includeRawResponse === true)
    return { total: Object.values(counts).reduce((sum, n) => sum + n, 0), page, pageSize, counts,
      rows: selected.map(({ collection, id }) => ({
        ...(summary ? { relationsIncluded: false as const } : {}),
        query: { id, interface: collection.interface, queryKey: collection.queryKey, rdjb: collection.rdjb,
          titleCode: collection.titleCode, queriedAt: collection.queriedAt, status: collection.status,
          failureReason: collection.failureReason, createdAt: collection.createdAt, lastCollectedAt: collection.lastCollectedAt,
          relationCount: countById.get(collection.id) ?? 0, ...displayByCollection.get(collection.id) },
        relations: byCollection.get(collection.id) ?? [],
      })) }
  })
}
