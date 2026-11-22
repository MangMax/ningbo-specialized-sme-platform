import { decodePostgresExactCell } from '../../../../db/postgresql/exact-cell'
import { and, desc, eq, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { platformBusinessObservation as o, platformBusinessRecord as b, platformCollection as c,
  platformObservationAssignment as assignment,
  platformRecognizedProjection as p } from '../../../../db/postgresql/platform-tables'
import type { CollectionConditionWitness } from '../../../../db/postgresql/platform-collection-scope'
import { projectRecognizedWitnesses } from './recognized-witness-projection'
import type { RecognizedWitnessReader } from './recognized-witness-reader'

type Reader = Pick<NodePgDatabase, 'select'>
type WitnessInput = Parameters<RecognizedWitnessReader['readMany']>[0]
const decodeWitness = (cell: CollectionConditionWitness | null) =>
  cell ? decodePostgresExactCell(cell.bytes === null ? null : Buffer.from(cell.bytes, 'base64'), cell.storage) : null

async function readWitnessRows(db: Reader, ids: readonly number[]) {
  const owner = db.select({ observationId: assignment.observationId, enterpriseId: assignment.enterpriseId,
    usccRaw: assignment.usccRaw, verificationStatus: assignment.verificationStatus }).from(assignment)
    .where(eq(assignment.observationId, o.id)).orderBy(desc(assignment.revision)).limit(1).as('owner')
  const conditions = sql`${c.conditionFacts} -> 'witnesses'`
  const rows = await db.select({
    relationId: o.publicId, observationId: o.id, collectionId: c.id, queryId: c.publicId,
    titleCode: c.titleCode, rdjb: c.rdjb, interface: c.interface, status: c.status, sequenceNo: o.sequenceNo,
    identity: o.identityState, content: o.contentState, recordInterface: b.interface,
    assignmentId: owner.observationId, enterpriseId: owner.enterpriseId, uscc: owner.usccRaw, verification: owner.verificationStatus,
    projectionId: p.id, rawValid: p.sourceValidityDate, rawMaintenanceBatch: p.sourceMaintenanceBatch,
    yearAbsent: p.sourceMaintenanceYearAbsent, state: c.witnessState, rule: c.witnessRule, gate: c.witnessGate,
    archiveId: c.witnessArchiveId, sha: c.witnessSha256, errorName: c.witnessErrorName, error: c.witnessError,
    refId: c.evidenceArchiveId, sealed: c.evidenceSealed, archiveOwner: c.evidenceArchiveId, archiveSha: c.evidenceSha256,
    positionState: o.witnessState, positionRule: o.witnessRule, positionCollection: o.witnessCollectionId,
    positionSequence: o.witnessSequenceNo, positionArchive: o.witnessArchiveId, positionSha: o.witnessSha256,
    ordinal: o.witnessOrdinal, key: o.witnessRdjbKey, pageKind: o.witnessPageKind,
    positionErrorName: o.witnessErrorName, positionError: o.witnessError,
    valid: sql<CollectionConditionWitness | null>`${conditions} -> 'rddqrq'`,
    year: sql<CollectionConditionWitness | null>`${conditions} -> 'whpcyear'`,
    batch: sql<CollectionConditionWitness | null>`${conditions} -> 'whpc'`,
  }).from(o).innerJoin(c, eq(c.id, o.collectionId))
    .leftJoinLateral(owner, eq(owner.observationId, o.id))
    .leftJoin(b, eq(b.id, o.recordId))
    .leftJoin(p, and(eq(p.versionId, o.versionId), eq(p.recordId, o.recordId)))
    // Drizzle inArray would bind one parameter per witness. Preserve the single-bound array.
    .where(sql`${o.publicId} = ANY(${sql.param(ids)}::bigint[])`)
  return rows.map(({ valid, year, batch, ...row }) => ({
    ...row,
    refId: row.refId === null ? null : Number(row.refId),
    archiveOwner: row.archiveOwner === null ? null : Number(row.archiveOwner),
    validKind: valid?.kind ?? null,
    yearKind: year?.kind ?? null,
    batchKind: batch?.kind ?? null,
    valid: decodeWitness(valid),
    year: decodeWitness(year),
    batch: decodeWitness(batch),
  }))
}

export type RecognizedWitnessRow = Awaited<ReturnType<typeof readWitnessRows>>[number]

export async function readPostgresRecognizedWitnesses(db: Reader, ids: readonly number[]) {
  const rows = ids.length ? await readWitnessRows(db, ids) : []
  const target = new Map(rows.map(row => [row.relationId, row]))
  return (input: WitnessInput) => projectRecognizedWitnesses(input, input.relationIds.flatMap(id => {
    const row = target.get(id)
    return row ? [row] : []
  }))
}
