/** Original command input projection. These archives are evidence, never business predicates. */
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { and, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import type { Executor } from '../../server/utils/roster-import'
import { targetSchema as s } from './target-schema'
import { sqliteConnection } from './target-connection'
import { requireLegacyProvenanceReady } from './legacy-provenance-catalog'
import { cellExpression, provenancePresence, snapshotSchema, targetProvenanceCells } from './target-evidence-read'
import { insertArchiveValue } from './target-archive'
import type { LegacyPlatformProvenanceInput } from './legacy-provenance'

export class LegacyProvenanceError extends Error {
  constructor(public code: string, message: string) { super(message) }
}
export function rejectLegacyProvenance(code: string, message: string): never { throw new LegacyProvenanceError(code, message) }
const drift = (message: string): never => rejectLegacyProvenance('legacy_source_drift', message)

export function legacyProvenanceTarget(db: Executor) {
  const connection = sqliteConnection(db)
  const phase = Number(connection.pragma('user_version', { simple: true }))
  if (phase === 0) return false
  requireLegacyProvenanceReady(connection)
  return true
}
const scalar = z.union([z.string(), z.number(), z.instanceof(Buffer), z.null()])
const querySchema = z.object({
  id: z.number(), interface: scalar, queryKey: scalar, rdjb: scalar, titleCode: scalar,
  queriedAt: scalar, lastCollectedAt: scalar, status: scalar, failureReason: scalar,
  rawResponse: scalar, collectionEvidence: z.unknown(), createdAt: scalar,
})
const rowSchema = z.object({ id: z.number(), sequenceNo: z.number(), relationKey: scalar, rawFields: z.unknown(), rawBytes: scalar })
/** Use SQLite/driver decoding, including Buffer and NULL, just as the old JSON-mode column did. */
function jsonCell(value: z.infer<typeof scalar>): unknown {
  return value === null ? null : JSON.parse(Buffer.isBuffer(value) ? value.toString() : String(value))
}
function archive(db: Executor, archiveId: number) {
  const value = db.select().from(s.platformArchiveValue).where(eq(s.platformArchiveValue.id, archiveId)).get()
  if (!value || (value.storageClass === 'null'
    ? value.bytes !== null || value.byteLength !== null || value.sha256 !== null
    : !value.bytes || value.bytes.length !== value.byteLength || createHash('sha256').update(value.bytes).digest('hex') !== value.sha256))
    return drift('Missing or changed original archive')
  return value
}
function collectionArchive(db: Executor, collectionId: number, field: 'rawResponse' | 'collectionEvidence') {
  const ref = db.select().from(s.platformCollectionArchiveRef)
    .where(and(eq(s.platformCollectionArchiveRef.ownerId, collectionId), eq(s.platformCollectionArchiveRef.field, field))).get()
  if (!ref || ref.sealed !== 1) return drift(`Missing original sealed ${field}`)
  const value = archive(db, ref.archiveId)
  return value.storageClass === 'null' ? null : value.storageClass === 'blob' ? value.bytes : value.bytes!.toString()
}

/** Explicit field insertion order is the schema0 ORM order, not the target DTO order. */
export function originalLegacyProvenanceInput(db: Executor, queryId: number) {
  const alias = db.select().from(s.platformLegacyQueryAlias).where(eq(s.platformLegacyQueryAlias.oldId, queryId)).get()
  if (!alias) return rejectLegacyProvenance('legacy_query_missing', 'Original query does not exist')
  const c = db.select().from(s.platformCollection).where(eq(s.platformCollection.id, alias.collectionId)).get()
  if (!c) return drift('Missing original collection')
  try {
    provenancePresence(db, c.id, queryId)
    const query = querySchema.parse({
      id: queryId, interface: c.interface, queryKey: c.queryKey, rdjb: c.rdjb, titleCode: c.titleCode,
      queriedAt: c.queriedAt, lastCollectedAt: c.lastCollectedAt, status: c.status, failureReason: c.failureReason,
      rawResponse: collectionArchive(db, c.id, 'rawResponse'),
      collectionEvidence: jsonCell(collectionArchive(db, c.id, 'collectionEvidence')), createdAt: c.createdAt,
    })
    const o = s.platformBusinessObservation, a = s.platformLegacyRelationAlias, r = s.platformObservationArchiveRef
    const observations = db.select({ observation: o, alias: a.oldId, ref: r })
      .from(o).leftJoin(a, eq(a.observationId, o.id)).leftJoin(r, and(eq(r.ownerId, o.id), eq(r.field, 'legacyRowSnapshot')))
      .where(eq(o.collectionId, c.id)).orderBy(o.sequenceNo, a.oldId).all()
    const rows = observations.map(({ observation, alias, ref }) => {
      if (alias === null) return rejectLegacyProvenance('legacy_query_missing', 'Original relation alias missing')
      if (!ref || ref.sealed !== 1) return drift('Missing sealed original relation cells')
      const value = archive(db, ref.archiveId)
      if (value.storageClass !== 'blob' || !value.bytes) return drift('Invalid original relation snapshot storage')
      const cells = snapshotSchema.parse(JSON.parse(value.bytes.toString())).fields
      const cell = (name: string) => {
        const matches = cells.filter(c => c.name === name)
        if (matches.length !== 1) return drift(`Missing or duplicate original cell: ${name}`)
        return matches[0]!
      }
      const raw = cellExpression(cell('raw_fields'))
      const rawRef = db.select().from(r).where(and(eq(r.ownerId, observation.id), eq(r.field, 'rawFields'))).get()
      if (!rawRef || rawRef.sealed !== 1) return drift('Missing original rawFields archive')
      const rawValue = archive(db, rawRef.archiveId), rawCell = cell('raw_fields')
      if (rawValue.storageClass !== rawCell.storageClass || (rawValue.bytes?.toString('hex') ?? '') !== rawCell.hex.toLowerCase())
        return drift('Original rawFields archive and cells disagree')
      const restored = db.get(sql`SELECT ${cellExpression(cell('id'))} id, ${cellExpression(cell('query_id'))} queryId,
        ${cellExpression(cell('sequence_no'))} sequenceNo, ${cellExpression(cell('relation_key'))} relationKey, ${raw} rawBytes`)
      const identity = z.object({ id: z.number(), queryId: z.number(), sequenceNo: z.number(), relationKey: scalar, rawBytes: scalar }).parse(restored)
      if (identity.id !== alias || identity.queryId !== queryId || identity.sequenceNo !== observation.sequenceNo
        || !isDeepStrictEqual(identity.relationKey, observation.sourceRelationKey)) return drift('Original relation cells and observation/aliases disagree')
      return rowSchema.parse({ id: alias, sequenceNo: identity.sequenceNo, relationKey: identity.relationKey,
        rawFields: jsonCell(identity.rawBytes), rawBytes: identity.rawBytes })
    })
    return { collectionId: c.id, query, rows }
  } catch (error) {
    if (error instanceof LegacyProvenanceError) throw error
    return drift(error instanceof Error ? error.message : 'Unverifiable original input')
  }
}

export function existingTargetLegacyProvenance(db: Executor, collectionId: number) {
  const p = s.platformCollectionLegacyProvenance
  const metadata = db.select().from(p).where(eq(p.collectionId, collectionId)).get()
  const hasEnvelope = db.select().from(s.platformCollectionArchiveRef)
    .where(and(eq(s.platformCollectionArchiveRef.ownerId, collectionId), eq(s.platformCollectionArchiveRef.field, 'legacyProvenance'))).get()
  if (!metadata) {
    if (hasEnvelope) return drift('Original provenance envelope has no metadata index')
    return undefined
  }
  try {
    const value = archive(db, metadata.archiveId)
    let bytes: Buffer
    if (metadata.origin === 't04_envelope') {
      if (!hasEnvelope || hasEnvelope.archiveId !== metadata.archiveId || hasEnvelope.sealed !== 1 || value.storageClass !== 'blob' || !value.bytes)
        return drift('Original provenance index owner conflict')
      const fields = [...targetProvenanceCells(value.bytes)]
      const cells = Object.fromEntries(fields.map(cell => [cell.name, scalar.parse(db.get<{ value: unknown }>(sql`SELECT ${cellExpression(cell)} value`)?.value)]))
      const queryAlias = db.select().from(s.platformLegacyQueryAlias).where(eq(s.platformLegacyQueryAlias.collectionId, collectionId)).get()
      if (cells.query_id !== queryAlias?.oldId || cells.source_identity !== metadata.sourceIdentity || cells.source_sha256 !== metadata.sourceSha256
        || cells.segment_index !== metadata.segmentIndex || cells.input_fingerprint !== metadata.inputFingerprint
        || cells.import_batch_id !== metadata.importBatchId || cells.created_at !== metadata.createdAt)
        return drift('Original provenance index metadata conflict')
      const collection = fields.find(cell => cell.name === 'collection')!
      bytes = Buffer.from(collection.hex, 'hex')
    } else {
      if (hasEnvelope || value.storageClass !== 'text' || !value.bytes) return drift('Supplement archive owner conflict')
      bytes = value.bytes
    }
    return { ...metadata, collection: JSON.parse(bytes.toString()) as unknown }
  } catch (error) {
    if (error instanceof LegacyProvenanceError) throw error
    return drift('Unverifiable original provenance metadata')
  }
}
export function targetLegacySourceOwner(db: Executor, input: LegacyPlatformProvenanceInput) {
  const p = s.platformCollectionLegacyProvenance
  return db.select({ collectionId: p.collectionId }).from(p)
    .where(and(eq(p.sourceSha256, input.sourceSha256), eq(p.segmentIndex, input.segmentIndex))).get()
}
export function insertTargetLegacyProvenance(db: Executor, input: LegacyPlatformProvenanceInput, batchId: number, fingerprint: string) {
  if (sqliteConnection(db).pragma('foreign_keys', { simple: true }) !== 1) throw new Error('Legacy provenance writes require foreign_keys=ON')
  const alias = db.select().from(s.platformLegacyQueryAlias).where(eq(s.platformLegacyQueryAlias.oldId, input.queryId)).get()
  if (!alias) return rejectLegacyProvenance('legacy_query_missing', 'Original query does not exist')
  const createdAt = new Date().toISOString()
  const archiveId = insertArchiveValue(db, { storageClass: 'text', bytes: Buffer.from(JSON.stringify(input.collection)), createdAt })
  try {
    db.insert(s.platformCollectionLegacyProvenance).values({ collectionId: alias.collectionId, origin: 'supplement',
      sourceIdentity: input.sourceIdentity, sourceSha256: input.sourceSha256, segmentIndex: input.segmentIndex,
      inputFingerprint: fingerprint, importBatchId: batchId, createdAt, archiveId }).run()
  } catch (error) {
    const owner = targetLegacySourceOwner(db, input)
    if (owner && owner.collectionId !== alias.collectionId)
      return rejectLegacyProvenance('legacy_source_identity_conflict', 'Original source file/segment already belongs to another query')
    throw error
  }
}
