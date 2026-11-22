import { and, count, desc, eq, exists, gt, ne, notExists, or, sql, type SQL } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import {
  platformCollection as collection,
  platformBusinessObservation as observation,
  platformObservationAssignment as assignment,
} from '../../../../db/postgresql/platform-tables'
import {
  platformQueryTitleScope as titleScope,
} from '../../../../db/postgresql/platform-query-scope-tables'
import { MAX_PAGE_SIZE } from '../query-limits'
import type { PlatformQueriesResult, PlatformQueryFilter } from './read'
import { RDJB_TITLE_CODES } from './recognized-evidence'
import { readPostgresQueryDisplays } from './postgres-query-display'

function conditionsOf(db: NodePgDatabase, filter: PlatformQueryFilter) {
  const conditions: SQL[] = []
  if (filter.queryId != null) conditions.push(eq(collection.publicId, filter.queryId))
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
  const page = Math.min(filter.page ?? 1, Number.MAX_SAFE_INTEGER)
  const pageSize = Math.min(filter.pageSize ?? 25, MAX_PAGE_SIZE)
  const offset = (BigInt(page) - BigInt(1)) * BigInt(pageSize)

  return db.transaction(async tx => {
    const conditions = conditionsOf(tx, filter)
    if (filter.titleCode) {
      const rdjb = Object.keys(RDJB_TITLE_CODES).find(key => RDJB_TITLE_CODES[key] === filter.titleCode) ?? ''
      const matchesTitle = tx.select({ id: titleScope.collectionId }).from(titleScope)
        .where(and(eq(titleScope.collectionId, collection.id), eq(titleScope.rdjb, rdjb)))
      conditions.push(or(eq(collection.titleCode, filter.titleCode), exists(matchesTitle))!)
    }
    const predicate = and(...conditions)
    const countRows = await tx.select({ status: collection.status, count: count() }).from(collection).where(predicate).groupBy(collection.status)
    const counts = Object.fromEntries(countRows.map(row => [row.status, row.count]))
    const total = Object.values(counts).reduce((sum, n) => sum + n, 0)
    const rows = offset >= BigInt(total) ? [] : await tx.select({
      id: collection.publicId,
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
    }).from(collection).where(predicate)
      // Drizzle 0.45 has no collation operator. Preserve bytewise chronological ordering.
      .orderBy(desc(sql`${collection.queriedAt} COLLATE "C"`), desc(collection.publicId))
      .limit(pageSize).offset(Number(offset))
    const owners = rows.map(({ collectionId, provenanceState, ...query }) => ({
      collectionId: String(collectionId), provenanceState, query,
    }))
    return { rows: summary ? owners.map(({ query }) => ({ relationsIncluded: false, query, relations: [] }))
      : await readPostgresQueryDisplays(tx, owners), total, page, pageSize, counts }
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' })
}
