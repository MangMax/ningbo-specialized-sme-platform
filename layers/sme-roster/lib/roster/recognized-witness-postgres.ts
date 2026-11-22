import { and, desc, eq, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import {
  platformBusinessObservation as observation, platformBusinessRecord as record, platformCollection as collection,
  platformObservationAssignment as assignment, platformRecognizedProjection as projection,
} from '../../../../db/postgresql/platform-tables'
import { projectRecognizedWitness } from './recognized-witness-projection'
import type { RecognizedWitnessReader } from './recognized-witness-reader'

type Reader = Pick<NodePgDatabase, 'select'>

function readWitnessRows(db: Reader, ids: readonly number[]) {
  const owner = db.select({
    observationId: assignment.observationId, enterpriseId: assignment.enterpriseId,
    usccRaw: assignment.usccRaw, verificationStatus: assignment.verificationStatus,
  }).from(assignment).where(eq(assignment.observationId, observation.id))
    .orderBy(desc(assignment.revision)).limit(1).as('owner')
  return db.select({
    relationId: observation.publicId, queryId: collection.publicId, titleCode: collection.titleCode,
    rdjb: collection.rdjb, interface: collection.interface, status: collection.status,
    identity: observation.identityState, content: observation.contentState, recordInterface: record.interface,
    assignmentId: owner.observationId, enterpriseId: owner.enterpriseId, uscc: owner.usccRaw, verification: owner.verificationStatus,
    projectionId: projection.id, rawValid: projection.sourceValidityDate, rawMaintenanceBatch: projection.sourceMaintenanceBatch,
    yearAbsent: projection.sourceMaintenanceYearAbsent, scope: collection.recognizedScope, position: observation.recognizedPosition,
  }).from(observation).innerJoin(collection, eq(collection.id, observation.collectionId))
    .leftJoinLateral(owner, eq(owner.observationId, observation.id))
    .leftJoin(record, eq(record.id, observation.recordId))
    .leftJoin(projection, and(eq(projection.versionId, observation.versionId), eq(projection.recordId, observation.recordId)))
    // Drizzle inArray binds one parameter per witness. Keep one bound array.
    .where(sql`${observation.publicId} = ANY(${sql.param(ids)}::bigint[])`)
}

export type RecognizedWitnessRow = Awaited<ReturnType<typeof readWitnessRows>>[number]

export async function readPostgresRecognizedWitnesses(db: Reader, ids: readonly number[]): Promise<RecognizedWitnessReader['readMany']> {
  const rows = ids.length ? await readWitnessRows(db, ids) : []
  const byRelation = new Map(rows.map(row => [row.relationId, row]))
  return input => new Map([...new Set(input.relationIds)].map(id => [id, projectRecognizedWitness(input, byRelation.get(id))]))
}
