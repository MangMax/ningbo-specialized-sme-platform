import { and, desc, eq, exists, inArray, isNotNull, isNull, or, sql, type SQL, type SQLWrapper } from 'drizzle-orm'
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

type ObservationCoordinate = {
  id: SQLWrapper; collectionId: SQLWrapper; recordId: SQLWrapper; versionId: SQLWrapper; contentState: SQLWrapper
}

function isCurrentUnkeyedObservation(db: Reader, row: ObservationCoordinate) {
  const source = alias(collection, 'unkeyed_collection')
  return exists(db.select({ id: source.id }).from(source)
    .where(and(eq(source.id, row.collectionId), isCurrentPlatformCollection(db, source, 'rows'))))
}

export function isCurrentPlatformObservation(db: Reader, row: ObservationCoordinate = observation) {
  const current = currentPlatformObservation(db, row.recordId).as('current_platform_row')
  const active = db.select({ id: current.id }).from(current)
  return or(eq(row.id, active), and(isNull(row.recordId), isCurrentUnkeyedObservation(db, row)))!
}

// Current query pages can contain several distinct title observations for one business identity.
export function isCurrentPlatformCaptureRow(db: Reader, row: ObservationCoordinate = observation) {
  const current = currentPlatformObservation(db, row.recordId).as('current_platform_capture')
  const active = db.select({ id: current.collectionId }).from(current)
  return or(and(eq(row.collectionId, active), eq(row.contentState, 'verified'), isNotNull(row.versionId)), and(isNull(row.recordId), isCurrentUnkeyedObservation(db, row)))!
}

type ScopeCoordinate = CaptureTime & Record<'id' | 'interface' | 'queryKey' | 'rdjb' | 'conditionFacts' | 'fullRange', SQLWrapper>

export function platformDecisionQueryMode(status: string, reasonCode?: string | null): 'attempt' | 'evidence' {
  const awaitingReview = status === 'confirmed_reason' && reasonCode === 'pending_review'
  return status === 'query_failed' || status === 'needs_review' || awaitingReview ? 'attempt' : 'evidence'
}

export function isCurrentPlatformCollection(db: Reader, row: ScopeCoordinate = collection, eligibility?: 'rows' | 'evidence' | 'attempt'): SQL {
  const source = alias(collection, 'scoped_collection')
  const evidenceRow = alias(observation, 'scoped_evidence')
  const positivePartial = eligibility === 'evidence' ? exists(db.select({ id: evidenceRow.id }).from(evidenceRow)
    .where(and(eq(evidenceRow.collectionId, source.id), isCurrentPlatformCaptureRow(db, evidenceRow)))) : undefined
  // Drizzle does not expose null-safe equality.
  const current = db.select({ id: source.id }).from(source).where(and(
    eq(source.interface, row.interface), eq(source.queryKey, row.queryKey), eq(source.rdjb, row.rdjb),
    sql`${source.conditionFacts} IS NOT DISTINCT FROM ${row.conditionFacts}`,
    sql`${source.fullRange} IS NOT DISTINCT FROM ${row.fullRange}`,
    eligibility === 'rows' ? exists(db.select({ id: observation.id }).from(observation).where(eq(observation.collectionId, source.id))) : undefined,
    eligibility === 'evidence' ? or(inArray(source.status, ['success', 'no_record']), and(eq(source.status, 'partial'), positivePartial)) : undefined,
  )).orderBy(desc(platformCaptureTime(source)), desc(source.publicId)).limit(1)
  return eq(row.id, current)
}
