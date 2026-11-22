import { and, desc, eq, exists, isNotNull, sql, type SQLWrapper } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import {
  platformBusinessObservation as observation,
  platformCollection as collection,
} from '../../../../db/postgresql/platform-tables'

type Reader = Pick<NodePgDatabase, 'select'>
type CaptureTime = { lastCollectedAt: SQLWrapper; queriedAt: SQLWrapper }

// Drizzle does not expose COALESCE or COLLATE operators.
export function platformCaptureTime(source: CaptureTime) {
  return sql<string>`coalesce(${source.lastCollectedAt}, ${source.queriedAt}) COLLATE "C"`
}

export function currentPlatformObservation(db: Reader, recordId: SQLWrapper) {
  const candidate = alias(observation, 'current_observation')
  const source = alias(collection, 'current_collection')
  return db.select({ id: candidate.id, collectionId: candidate.collectionId, recordId: candidate.recordId, versionId: candidate.versionId,
    collectedAt: platformCaptureTime(source).as('current_collected_at') })
    .from(candidate).innerJoin(source, eq(source.id, candidate.collectionId))
    .where(and(eq(candidate.recordId, recordId), eq(candidate.contentState, 'verified'), isNotNull(candidate.versionId)))
    .orderBy(desc(platformCaptureTime(source)), desc(source.publicId), desc(candidate.publicId)).limit(1)
}

export function isCurrentPlatformObservation(db: Reader, row: { collectionId: SQLWrapper; recordId: SQLWrapper } = observation) {
  const current = currentPlatformObservation(db, row.recordId).as('current_platform_row')
  const active = db.select({ collectionId: current.collectionId }).from(current)
  const source = alias(collection, 'unkeyed_collection')
  const currentUnkeyed = db.select({ id: source.id }).from(source)
    .where(and(eq(source.id, row.collectionId), isCurrentPlatformCollection(db, source, true)))
  return eq(row.collectionId, sql`coalesce((${active}), (${currentUnkeyed}))`)
}

type ScopeCoordinate = CaptureTime & Record<'id' | 'interface' | 'queryKey' | 'rdjb' | 'conditionFacts' | 'fullRange', SQLWrapper>

export function isCurrentPlatformCollection(db: Reader, row: ScopeCoordinate = collection, hasRows = false) {
  const source = alias(collection, 'scoped_collection')
  // Drizzle does not expose null-safe equality.
  const current = db.select({ id: source.id }).from(source).where(and(
    eq(source.interface, row.interface), eq(source.queryKey, row.queryKey), eq(source.rdjb, row.rdjb),
    sql`${source.conditionFacts} IS NOT DISTINCT FROM ${row.conditionFacts}`,
    sql`${source.fullRange} IS NOT DISTINCT FROM ${row.fullRange}`,
    hasRows ? exists(db.select({ id: observation.id }).from(observation).where(eq(observation.collectionId, source.id))) : undefined,
  )).orderBy(desc(platformCaptureTime(source)), desc(source.publicId)).limit(1)
  return eq(row.id, current)
}
