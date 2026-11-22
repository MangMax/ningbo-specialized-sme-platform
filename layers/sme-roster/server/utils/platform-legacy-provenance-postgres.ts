import { and, eq, exists, getTableColumns } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { isDeepStrictEqual } from 'node:util'
import { alias } from 'drizzle-orm/pg-core'
import { platformBusinessObservation, platformCollection, platformLegacyQueryAlias, platformLegacyRelationAlias } from '../../../../db/postgresql/platform-tables'
import { platformArchiveValue, platformCollectionArchiveRef, platformCollectionLegacyProvenance as provenance, platformObservationArchiveRef } from '../../../../db/postgresql/platform-archive-tables'
import { writePostgresArchiveValue } from '../../lib/platform/postgres-archive-write'
import { legacyEnvelopeCollection, readPlatformArchiveBytes } from '../../lib/platform/postgres-evidence-read'
import { rejectLegacyProvenance as reject } from '../../lib/platform/legacy-provenance-error'
import type { originalLegacyProvenanceInput } from '../../lib/platform/legacy-provenance-command'
import type { LegacyPlatformProvenanceInput } from '../../lib/platform/legacy-provenance'
import { snapshotSchema } from '../../lib/platform/evidence-snapshot-model'
import { legacyProvenanceFingerprint } from './platform-legacy-provenance-fingerprint'

type Tx = Parameters<Parameters<NodePgDatabase['transaction']>[0]>[0]
type Original = ReturnType<typeof originalLegacyProvenanceInput>
type ArchiveValue = { storage: string; bytes: Buffer | null }

function originalValue({storage,bytes}: ArchiveValue) {
  if (bytes === null || storage === 'blob') return bytes
  const value = bytes.toString('utf8')
  return storage === 'integer' || storage === 'real' ? Number(value) : value
}
const sourceDrift = (message: string): never => reject('legacy_source_drift',message)

async function readOriginal(tx: Tx, queryId: number): Promise<Original> {
  const rawRef = alias(platformCollectionArchiveRef, 'raw_ref')
  const evidenceRef = alias(platformCollectionArchiveRef, 'evidence_ref')
  const rawValue = alias(platformArchiveValue, 'raw_value')
  const evidenceValue = alias(platformArchiveValue, 'evidence_value')
  const [entry] = await tx.select({
    collection: getTableColumns(platformCollection), raw: rawValue.bytes, storage: rawValue.storageClass, evidence: evidenceValue.bytes,
  }).from(platformLegacyQueryAlias).innerJoin(platformCollection, eq(platformCollection.id, platformLegacyQueryAlias.collectionId))
    .innerJoin(rawRef, and(eq(rawRef.ownerId, platformCollection.id), eq(rawRef.field, 'rawResponse'), eq(rawRef.sealed, 1)))
    .innerJoin(rawValue, eq(rawValue.id, rawRef.archiveId))
    .innerJoin(evidenceRef, and(eq(evidenceRef.ownerId, platformCollection.id), eq(evidenceRef.field, 'collectionEvidence'), eq(evidenceRef.sealed, 1)))
    .innerJoin(evidenceValue, eq(evidenceValue.id, evidenceRef.archiveId))
    .where(eq(platformLegacyQueryAlias.oldId, queryId))
  if (!entry) return reject('legacy_query_missing','Original query does not exist')
  const c = entry.collection
  const query:Original['query'] = { id:queryId,interface:c.interface,queryKey:c.queryKey,rdjb:c.rdjb,titleCode:c.titleCode,
    queriedAt:c.queriedAt,lastCollectedAt:c.lastCollectedAt,status:c.status,failureReason:c.failureReason,
    rawResponse:originalValue({storage:entry.storage,bytes:entry.raw}),
    collectionEvidence:entry.evidence ? JSON.parse(entry.evidence.toString('utf8')) : null,createdAt:c.createdAt }
  const o = platformBusinessObservation
  const a = platformLegacyRelationAlias
  const rawRowRef = alias(platformObservationArchiveRef, 'raw_row_ref')
  const snapshotRef = alias(platformObservationArchiveRef, 'snapshot_ref')
  const snapshot = alias(platformArchiveValue, 'snapshot_value')
  const observed = await tx.select({
    id: a.oldId, sequenceNo: o.sequenceNo, key: o.sourceRelationKey, raw: rawValue.bytes,
    storage: rawValue.storageClass, snapshot: snapshot.bytes,
  }).from(o).leftJoin(a, eq(a.observationId, o.id))
    .leftJoin(rawRowRef, and(eq(rawRowRef.ownerId, o.id), eq(rawRowRef.field, 'rawFields'), eq(rawRowRef.sealed, 1)))
    .leftJoin(rawValue, eq(rawValue.id, rawRowRef.archiveId))
    .leftJoin(snapshotRef, and(eq(snapshotRef.ownerId, o.id), eq(snapshotRef.field, 'legacyRowSnapshot'), eq(snapshotRef.sealed, 1)))
    .leftJoin(snapshot, and(eq(snapshot.id, snapshotRef.archiveId), eq(snapshot.storageClass, 'blob')))
    .where(eq(o.collectionId, c.id)).orderBy(o.sequenceNo, a.oldId).limit(5001)
  const rows = observed.map(row=>{
    if (row.id==null) return reject('legacy_query_missing','Original relation alias missing')
    if (!row.snapshot || !row.storage) return sourceDrift('Missing sealed original relation cells')
    const cells = new Map(snapshotSchema.parse(JSON.parse(row.snapshot.toString('utf8'))).fields.map(cell=>[cell.name,cell]))
    const cell = (name:string) => cells.get(name) ?? sourceDrift('Missing original cell: '+name)
    const raw = cell('raw_fields')
    const bytes = (name:string) => Buffer.from(cell(name).hex,'hex').toString('utf8')
    const relationKey = cell('relation_key').storageClass==='null' ? null : bytes('relation_key')
    if (raw.storageClass!==row.storage || (row.raw?.toString('hex') ?? '')!==raw.hex.toLowerCase()) {
      return sourceDrift('Original rawFields archive and cells disagree')
    }
    if (Number(bytes('id'))!==row.id || Number(bytes('query_id'))!==queryId || Number(bytes('sequence_no'))!==row.sequenceNo
      || relationKey!==row.key) return sourceDrift('Original relation cells and observation/aliases disagree')
    const rawBytes = originalValue({storage:row.storage,bytes:row.raw})
    return { id:row.id,sequenceNo:row.sequenceNo,relationKey,rawFields:rawBytes===null ? null : JSON.parse(String(rawBytes)),rawBytes }
  })
  return { collectionId:c.id,query,rows }
}

async function existing(tx: Tx, collectionId: number, queryId: number) {
  const a = platformArchiveValue
  const r = platformCollectionArchiveRef
  const [stored] = await tx.select({
    id: a.id, storageClass: a.storageClass, byteLength: a.byteLength, origin: provenance.origin,
    identity: provenance.sourceIdentity, sha256: provenance.sourceSha256, segment: provenance.segmentIndex,
    fingerprint: provenance.inputFingerprint,
    sealed: exists(tx.select({ id: r.archiveId }).from(r).where(and(eq(r.ownerId, provenance.collectionId),
      eq(r.field, 'legacyProvenance'), eq(r.archiveId, a.id), eq(r.sealed, 1)))).mapWith(Boolean),
  }).from(provenance).innerJoin(a, eq(a.id, provenance.archiveId)).where(eq(provenance.collectionId, collectionId))
  const row = stored ? { ...stored, id: String(stored.id), byteLength: stored.byteLength === null ? null : String(stored.byteLength) } : null
  if (!row) return null
  if (row.byteLength===null || (row.origin==='t04_envelope' ? !row.sealed || row.storageClass!=='blob' : row.storageClass!=='text')) {
    return sourceDrift('Original provenance index owner conflict')
  }
  const {start,size} = row.origin==='t04_envelope' ? await legacyEnvelopeCollection(tx,row,queryId) : {start:0,size:Number(row.byteLength)}
  const collection = size===null ? null : JSON.parse((await readPlatformArchiveBytes(tx,row.id,start,size)).toString('utf8'))
  return { ...row,collection }
}

export async function inspectPostgresLegacyProvenance(tx: Tx,input:LegacyPlatformProvenanceInput,expected?:string) {
  const original = await readOriginal(tx,input.queryId)
  const fingerprint = legacyProvenanceFingerprint(input,original,expected)
  const stored = await existing(tx,original.collectionId,input.queryId)
  if (stored && (stored.identity!==input.sourceIdentity || stored.sha256!==input.sourceSha256 || stored.segment!==input.segmentIndex
    || stored.fingerprint!==fingerprint || !isDeepStrictEqual(stored.collection,input.collection))) {
    return reject('legacy_provenance_conflict','Query already has different immutable legacy provenance')
  }
  const [owner] = await tx.select({ id: provenance.collectionId }).from(provenance)
    .where(and(eq(provenance.sourceSha256, input.sourceSha256), eq(provenance.segmentIndex, input.segmentIndex)))
  if (owner && owner.id!==original.collectionId) return reject('legacy_source_identity_conflict','Original source file/segment already belongs to another query')
  return { input,fingerprint,collectionId:original.collectionId,relationCount:original.rows.length,exists:!!stored }
}

export async function writePostgresLegacyProvenance(tx: Tx,plan:Awaited<ReturnType<typeof inspectPostgresLegacyProvenance>>,batchId:number) {
  if (!plan.exists) {
    const now = new Date().toISOString()
    const { input } = plan
    const archive = await writePostgresArchiveValue(tx,JSON.stringify(input.collection),now)
    await tx.insert(provenance).values({
      collectionId: plan.collectionId, origin: 'supplement', sourceIdentity: input.sourceIdentity,
      sourceSha256: input.sourceSha256, segmentIndex: input.segmentIndex, inputFingerprint: plan.fingerprint,
      importBatchId: batchId, createdAt: now, archiveId: BigInt(archive.id),
    })
  }
  return { queryId:plan.input.queryId,provenanceKind:'legacy_pagination',typedState:'unknown',
    relationCount:plan.relationCount,rowsWritten:plan.exists ? 0 : 1 }
}
