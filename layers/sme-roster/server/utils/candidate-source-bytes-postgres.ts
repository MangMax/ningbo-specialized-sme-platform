import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { and, eq, inArray, sum } from 'drizzle-orm'
import { platformArchiveValue as archive, platformCollectionArchiveRef as collectionRef, platformObservationArchiveRef as observationRef } from '../../../../db/postgresql/platform-archive-tables'
import { platformBusinessObservation as observation, platformLegacyRelationAlias as relation } from '../../../../db/postgresql/platform-tables'

export async function readPostgresCandidateSourceBytes(db: Pick<NodePgDatabase, 'select'>, relationId: number) {
  const collectionBytes = db.select({ bytes: sum(archive.byteLength).as('collection_bytes') })
    .from(collectionRef).innerJoin(archive, eq(archive.id, collectionRef.archiveId))
    .where(and(eq(collectionRef.ownerId, observation.collectionId), inArray(collectionRef.field, ['rawResponse', 'collectionEvidence'])))
    .as('collection_totals')
  const observationBytes = db.select({ bytes: sum(archive.byteLength).as('observation_bytes') })
    .from(observationRef).innerJoin(archive, eq(archive.id, observationRef.archiveId))
    .where(and(eq(observationRef.ownerId, observation.id), eq(observationRef.field, 'rawFields')))
    .as('observation_totals')
  const [row] = await db.select({ collection: collectionBytes.bytes, observation: observationBytes.bytes })
    .from(relation).innerJoin(observation, eq(observation.id, relation.observationId))
    .crossJoinLateral(collectionBytes).crossJoinLateral(observationBytes).where(eq(relation.oldId, relationId))
  return row ? Number(row.collection) + Number(row.observation) : undefined
}
