import { sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { isDeepStrictEqual } from 'node:util'
import { platformCollection } from '../../../../db/schema'
import { writePostgresArchiveValue } from '../../lib/platform/postgres-archive-write'
import { legacyEnvelopeCollection, readPlatformArchiveBytes, type PostgresPlatformArchive } from '../../lib/platform/postgres-evidence-read'
import { rejectLegacyProvenance as reject, type originalLegacyProvenanceInput } from '../../lib/platform/legacy-provenance-command'
import type { LegacyPlatformProvenanceInput } from '../../lib/platform/legacy-provenance'
import { snapshotSchema } from '../../lib/platform/target-evidence-read'
import { postgresRosterRow } from '../../lib/roster/postgres-rows'
import { legacyProvenanceFingerprint } from './platform-legacy-provenance'

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
  const { rows:[entry] } = await tx.execute<{ collection:typeof platformCollection.$inferSelect;
    raw:Buffer | null; storage:string; evidence:Buffer | null }>(sql`
    SELECT ${postgresRosterRow(platformCollection,'p')} AS collection,a.bytes AS raw,a.storage_class AS storage,v.bytes AS evidence
    FROM platform_legacy_query_alias q JOIN platform_collection p ON p.id=q.collection_id
    JOIN platform_collection_archive_ref s ON s.owner_id=p.id AND s.field='rawResponse' AND s.sealed=1
    JOIN platform_archive_value a ON a.id=s.archive_id
    JOIN platform_collection_archive_ref r ON r.owner_id=p.id AND r.field='collectionEvidence' AND r.sealed=1
    JOIN platform_archive_value v ON v.id=r.archive_id WHERE q.old_id=${queryId}`)
  if (!entry) return reject('legacy_query_missing','Original query does not exist')
  const c = entry.collection
  const query:Original['query'] = { id:queryId,interface:c.interface,queryKey:c.queryKey,rdjb:c.rdjb,titleCode:c.titleCode,
    queriedAt:c.queriedAt,lastCollectedAt:c.lastCollectedAt,status:c.status,failureReason:c.failureReason,
    rawResponse:originalValue({storage:entry.storage,bytes:entry.raw}),
    collectionEvidence:entry.evidence ? JSON.parse(entry.evidence.toString('utf8')) : null,createdAt:c.createdAt }
  const { rows:observed } = await tx.execute<{ id:number; sequenceNo:number; key:string | null;
    raw:Buffer | null; storage:string; snapshot:Buffer | null }>(sql`
    SELECT a.old_id::float8 AS id,o.sequence_no::float8 AS "sequenceNo",o.source_relation_key AS key,
      v.bytes AS raw,v.storage_class AS storage,s.bytes AS snapshot
    FROM platform_business_observation o
    LEFT JOIN platform_legacy_relation_alias a ON a.observation_id=o.id
    LEFT JOIN platform_observation_archive_ref r ON r.owner_id=o.id AND r.field='rawFields' AND r.sealed=1
    LEFT JOIN platform_archive_value v ON v.id=r.archive_id
    LEFT JOIN platform_observation_archive_ref b ON b.owner_id=o.id AND b.field='legacyRowSnapshot' AND b.sealed=1
    LEFT JOIN platform_archive_value s ON s.id=b.archive_id AND s.storage_class='blob'
    WHERE o.collection_id=${c.id} ORDER BY o.sequence_no,a.old_id LIMIT 5001`)
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
  const { rows:[row] } = await tx.execute<PostgresPlatformArchive & { origin:string; identity:string; sha256:string;
    segment:number; fingerprint:string }>(sql`
    SELECT a.id,a.storage_class AS "storageClass",a.byte_length AS "byteLength",p.origin,p.source_identity AS identity,
      p.source_sha256 AS sha256,p.segment_index::float8 AS segment,p.input_fingerprint AS fingerprint,
      EXISTS(SELECT 1 FROM platform_collection_archive_ref r WHERE r.owner_id=p.collection_id
        AND r.field='legacyProvenance' AND r.archive_id=a.id AND r.sealed=1) AS sealed
    FROM platform_collection_legacy_provenance p JOIN platform_archive_value a ON a.id=p.archive_id WHERE p.collection_id=${collectionId}`)
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
  const { rows:[owner] } = await tx.execute<{ id:number }>(sql`SELECT collection_id::float8 AS id FROM platform_collection_legacy_provenance
    WHERE source_sha256=${input.sourceSha256} AND segment_index=${input.segmentIndex}`)
  if (owner && owner.id!==original.collectionId) return reject('legacy_source_identity_conflict','Original source file/segment already belongs to another query')
  return { input,fingerprint,collectionId:original.collectionId,relationCount:original.rows.length,exists:!!stored }
}

export async function writePostgresLegacyProvenance(tx: Tx,plan:Awaited<ReturnType<typeof inspectPostgresLegacyProvenance>>,batchId:number) {
  if (!plan.exists) {
    const now = new Date().toISOString()
    const { input } = plan
    const archive = await writePostgresArchiveValue(tx,JSON.stringify(input.collection),now)
    await tx.execute(sql`INSERT INTO platform_collection_legacy_provenance
      (collection_id,origin,source_identity,source_sha256,segment_index,input_fingerprint,import_batch_id,created_at,archive_id)
      VALUES(${plan.collectionId},'supplement',${input.sourceIdentity},${input.sourceSha256},${input.segmentIndex},${plan.fingerprint},
        ${batchId},${now},${archive.id})`)
  }
  return { queryId:plan.input.queryId,provenanceKind:'legacy_pagination',typedState:'unknown',
    relationCount:plan.relationCount,rowsWritten:plan.exists ? 0 : 1 }
}
