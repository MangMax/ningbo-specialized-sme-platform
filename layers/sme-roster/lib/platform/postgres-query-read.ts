import { and, count, desc, eq, exists, gt, isNull, ne, notExists, or, sql, type SQL } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { createError } from 'h3'
import {
  platformCollection as collection,
  platformBusinessObservation as observation,
  platformLegacyQueryAlias as queryAlias,
  platformObservationAssignment as assignment,
} from '../../../../db/postgresql/platform-tables'
import {
  platformArchiveValue as archive,
  platformCollectionArchiveRef as archiveRef,
  platformQueryTitleScope as titleScope,
  platformQueryTitleScopeError as titleScopeError,
} from '../../../../db/postgresql/platform-archive-tables'
import { MAX_PAGE_SIZE } from '../query-limits'
import type { PlatformQueriesResult, PlatformQueryFilter } from './read'
import { RDJB_TITLE_CODES } from './recognized-evidence'
import { readPostgresQueryDisplays } from './postgres-query-display'

function conditionsOf(db: NodePgDatabase, filter: PlatformQueryFilter) {
  const conditions: SQL[] = []
  if (filter.queryId != null) conditions.push(eq(queryAlias.oldId, filter.queryId))
  if (filter.interface) conditions.push(eq(collection.interface, filter.interface))
  if (filter.status) conditions.push(eq(collection.status, filter.status))
  if (filter.queryKey) conditions.push(filter.queryKey.includes('\0') ? ne(collection.id, collection.id) : eq(collection.queryKey, filter.queryKey))
  if (filter.uscc) {
    const rawAssignment = db.select({ id: observation.id }).from(observation)
      .innerJoin(assignment, and(eq(assignment.observationId, observation.id), eq(assignment.revision, 1)))
      .where(and(eq(observation.collectionId, collection.id), eq(assignment.usccRaw, filter.uscc)))
    conditions.push(filter.uscc.includes('\0') ? ne(collection.id, collection.id)
      : or(eq(collection.queryKey, filter.uscc), exists(rawAssignment))!)
  }
  if (filter.enterpriseId != null) {
    const later = alias(assignment, 'later')
    const laterAssignment = db.select({ id: later.observationId }).from(later)
      .where(and(eq(later.observationId, assignment.observationId), gt(later.revision, assignment.revision)))
    const currentOwner = db.select({ id: observation.id }).from(assignment)
      .innerJoin(observation, eq(observation.id, assignment.observationId))
      .where(and(eq(observation.collectionId, collection.id), eq(assignment.enterpriseId, filter.enterpriseId), notExists(laterAssignment)))
    conditions.push(Number.isSafeInteger(filter.enterpriseId) ? exists(currentOwner) : ne(collection.id, collection.id))
  }
  return conditions
}

export function readPostgresPlatformQueries(db: NodePgDatabase, filter: PlatformQueryFilter): Promise<PlatformQueriesResult> {
  const summary = filter.view === 'summary'
  if (summary && filter.includeRawResponse) throw createError({ statusCode: 400, statusMessage: 'Invalid view or includeRawResponse combination' })
  const page = Math.min(filter.page ?? 1, Number.MAX_SAFE_INTEGER)
  const pageSize = Math.min(filter.pageSize ?? 25, MAX_PAGE_SIZE)
  const offset = (BigInt(page) - BigInt(1)) * BigInt(pageSize)

  return db.transaction(async tx => {
    const conditions = conditionsOf(tx, filter)
    if (filter.titleCode) {
      const [malformed] = await tx.select({ id: collection.id }).from(collection)
        .innerJoin(queryAlias, eq(queryAlias.collectionId, collection.id))
        .innerJoin(titleScopeError, eq(titleScopeError.collectionId, collection.id))
        .innerJoin(archiveRef, and(eq(archiveRef.ownerId, collection.id), eq(archiveRef.field, 'collectionEvidence')))
        .innerJoin(archive, eq(archive.id, archiveRef.archiveId))
        .where(and(...conditions, or(isNull(collection.titleCode), ne(collection.titleCode, filter.titleCode)), ne(archive.storageClass, 'null')))
        .limit(1)
      if (malformed) throw createError({ statusCode: 500, statusMessage: 'Malformed stored platform title scope' })
      const rdjb = Object.keys(RDJB_TITLE_CODES).find(key => RDJB_TITLE_CODES[key] === filter.titleCode) ?? ''
      const matchesTitle = tx.select({ id: titleScope.collectionId }).from(titleScope)
        .where(and(eq(titleScope.collectionId, collection.id), eq(titleScope.rdjb, rdjb)))
      conditions.push(or(eq(collection.titleCode, filter.titleCode), exists(matchesTitle))!)
    }
    const predicate = and(...conditions)
    const countRows = await tx.select({ status: collection.status, count: count() }).from(collection)
      .innerJoin(queryAlias, eq(queryAlias.collectionId, collection.id)).where(predicate).groupBy(collection.status)
    const counts = Object.fromEntries(countRows.map(row => [row.status, row.count]))
    const total = Object.values(counts).reduce((sum, n) => sum + n, 0)
    const rows = offset >= BigInt(total) ? [] : await tx.select({
      id: queryAlias.oldId,
      collectionId: collection.id,
      provenanceState: collection.provenanceState,
      interface: collection.interface,
      queryKey: collection.queryKey,
      rdjb: collection.rdjb,
      titleCode: collection.titleCode,
      queriedAt: collection.queriedAt,
      status: collection.status,
      failureReason: collection.failureReason,
      createdAt: collection.createdAt,
      lastCollectedAt: collection.lastCollectedAt,
      relationCount: tx.$count(observation, eq(observation.collectionId, collection.id)),
    }).from(collection).innerJoin(queryAlias, eq(queryAlias.collectionId, collection.id)).where(predicate)
      // Drizzle 0.45 has no collation operator. Preserve bytewise chronological ordering.
      .orderBy(desc(sql`${collection.queriedAt} COLLATE "C"`), desc(queryAlias.oldId))
      .limit(pageSize).offset(Number(offset))
    const owners = rows.map(({ collectionId, provenanceState, ...query }) => ({
      collectionId: String(collectionId), provenanceState, query,
    }))
    return { rows: summary ? owners.map(({ query }) => ({ relationsIncluded: false, query, relations: [] }))
      : await readPostgresQueryDisplays(tx, owners, filter.includeRawResponse === true), total, page, pageSize, counts }
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' })
}
