import { decodePostgresExactCell } from '../../../../db/postgresql/exact-cell'
import { and, desc, eq, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { platformArchiveValue as archive, platformCollectionArchiveRef as ref } from '../../../../db/postgresql/platform-archive-tables'
import { platformBusinessObservation as o, platformBusinessRecord as b, platformCollection as c, platformCollectionCondition as condition,
  platformLegacyQueryAlias as qa, platformLegacyRelationAlias as ra, platformObservationAssignment as assignment,
  platformRecognizedProjection as p } from '../../../../db/postgresql/platform-tables'
import { projectRecognizedWitnesses, type RecognizedWitnessRow } from './recognized-witness-target'
import type { RecognizedWitnessReader } from './recognized-witness-reader'

type Reader = Pick<NodePgDatabase, 'select'>
type WitnessInput = Parameters<RecognizedWitnessReader['readMany']>[0]
const valid = alias(condition, 'valid')
const year = alias(condition, 'year')
const batch = alias(condition, 'batch')

export async function readPostgresRecognizedWitnesses(db: Reader, ids: readonly number[]) {
  const target = new Map<number, RecognizedWitnessRow>()
  if (ids.length) {
    const owner = db.select({ observationId: assignment.observationId, enterpriseId: assignment.enterpriseId,
      usccRaw: assignment.usccRaw, verificationStatus: assignment.verificationStatus }).from(assignment)
      .where(eq(assignment.observationId, o.id)).orderBy(desc(assignment.revision)).limit(1).as('owner')
    const rows = await db.select({
      relationId: ra.oldId, observationId: o.id, collectionId: c.id, queryId: qa.oldId,
      titleCode: c.titleCode, rdjb: c.rdjb, interface: c.interface, status: c.status, sequenceNo: o.sequenceNo,
      identity: o.identityState, content: o.contentState, recordInterface: b.interface,
      assignmentId: owner.observationId, enterpriseId: owner.enterpriseId, uscc: owner.usccRaw, verification: owner.verificationStatus,
      projectionId: p.id, rawValid: p.sourceValidityDate, rawMaintenanceBatch: p.sourceMaintenanceBatch,
      yearAbsent: p.sourceMaintenanceYearAbsent, state: c.witnessState, rule: c.witnessRule, gate: c.witnessGate,
      archiveId: c.witnessArchiveId, sha: c.witnessSha256, errorName: c.witnessErrorName, error: c.witnessError,
      refId: ref.archiveId, sealed: ref.sealed, archiveOwner: archive.id, archiveSha: archive.sha256,
      positionState: o.witnessState, positionRule: o.witnessRule, positionCollection: o.witnessCollectionId,
      positionSequence: o.witnessSequenceNo, positionArchive: o.witnessArchiveId, positionSha: o.witnessSha256,
      ordinal: o.witnessOrdinal, key: o.witnessRdjbKey, pageKind: o.witnessPageKind,
      positionErrorName: o.witnessErrorName, positionError: o.witnessError,
      validKind: valid.witnessKind, yearKind: year.witnessKind, batchKind: batch.witnessKind,
      validBytes: valid.witnessValue, validStorage: valid.witnessValueSqliteStorage,
      yearBytes: year.witnessValue, yearStorage: year.witnessValueSqliteStorage,
      batchBytes: batch.witnessValue, batchStorage: batch.witnessValueSqliteStorage,
    }).from(ra).innerJoin(o, eq(o.id, ra.observationId)).innerJoin(c, eq(c.id, o.collectionId))
      .leftJoin(qa, eq(qa.collectionId, c.id))
      .leftJoinLateral(owner, eq(owner.observationId, o.id))
      .leftJoin(b, eq(b.id, o.recordId))
      .leftJoin(p, and(eq(p.versionId, o.versionId), eq(p.recordId, o.recordId)))
      .leftJoin(ref, and(eq(ref.ownerId, c.id), eq(ref.field, 'collectionEvidence')))
      .leftJoin(archive, eq(archive.id, ref.archiveId))
      .leftJoin(valid, and(eq(valid.collectionId, c.id), eq(valid.name, 'rddqrq')))
      .leftJoin(year, and(eq(year.collectionId, c.id), eq(year.name, 'whpcyear')))
      .leftJoin(batch, and(eq(batch.collectionId, c.id), eq(batch.name, 'whpc')))
      // Drizzle inArray would bind one parameter per witness. Preserve the single-bound array.
      .where(sql`${ra.oldId} = ANY(${sql.param(ids)}::bigint[])`)
    for (const { validBytes, validStorage, yearBytes, yearStorage, batchBytes, batchStorage, ...row } of rows) {
      target.set(row.relationId, {
        ...row,
        refId: row.refId === null ? null : Number(row.refId),
        archiveOwner: row.archiveOwner === null ? null : Number(row.archiveOwner),
        valid: decodePostgresExactCell(validBytes, validStorage),
        year: decodePostgresExactCell(yearBytes, yearStorage),
        batch: decodePostgresExactCell(batchBytes, batchStorage),
      } as RecognizedWitnessRow)
    }
  }
  return (input: WitnessInput) => projectRecognizedWitnesses(input, input.relationIds.flatMap(id => {
    const row = target.get(id)
    return row ? [row] : []
  }))
}
