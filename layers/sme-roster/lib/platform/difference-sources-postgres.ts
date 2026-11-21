import { and, desc, eq, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { alias } from 'drizzle-orm/pg-core'
import {
  platformBusinessObservation as observation,
  platformLegacyQueryAlias as queryAlias,
  platformLegacyRelationAlias as relationAlias,
  platformObservationAssignment as assignment,
} from '../../../../db/postgresql/platform-tables'
import type { readDifferenceObservation } from './difference-sources'

type Observation = NonNullable<ReturnType<typeof readDifferenceObservation>>

export async function readPostgresDifferenceObservations(db: Pick<NodePgDatabase, 'select'>, relationIds: readonly number[]) {
  if (!relationIds.length) return new Map<number, Observation>()
  const original = alias(assignment, 'original')
  const current = db.select({
    enterpriseId: assignment.enterpriseId, verificationStatus: assignment.verificationStatus, matchBasis: assignment.matchBasis,
  }).from(assignment).where(eq(assignment.observationId, observation.id)).orderBy(desc(assignment.revision)).limit(1).as('current_assignment')
  const rows = await db.select({
    id: relationAlias.oldId, observationId: observation.id, collectionId: observation.collectionId,
    queryId: queryAlias.oldId, sequenceNo: observation.sequenceNo, relationKey: observation.sourceRelationKey, versionId: observation.versionId,
    enterpriseId: current.enterpriseId, uscc: original.usccRaw, nameRaw: original.nameRaw,
    aliasNameRaw: original.aliasNameRaw, verificationStatus: current.verificationStatus, matchBasis: current.matchBasis,
  }).from(relationAlias).innerJoin(observation, eq(observation.id, relationAlias.observationId))
    .innerJoin(queryAlias, eq(queryAlias.collectionId, observation.collectionId))
    .innerJoin(original, and(eq(original.observationId, observation.id), eq(original.revision, 1)))
    .crossJoinLateral(current)
    // Drizzle has no scalar = ANY(array) builder. One array keeps legacy batches below the bind limit.
    .where(sql`${relationAlias.oldId} = any(${sql.param(relationIds)}::bigint[])`) as Observation[]
  return new Map(rows.map(row => [row.id, row]))
}
