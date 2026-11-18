import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { legacyPlatformProvenanceSchema, type LegacyPlatformProvenanceInput } from '../../lib/platform/legacy-provenance'
import { recognizedStoredStatus } from '../../lib/platform/recognized-evidence'
import { legacySourcePositionForSequence } from '../../lib/platform/legacy-provenance'
import type { Executor } from './roster-import'
import { LegacyProvenanceError, rejectLegacyProvenance as reject, originalLegacyProvenanceInput,
  existingTargetLegacyProvenance, targetLegacySourceOwner, insertTargetLegacyProvenance } from '../../lib/platform/legacy-provenance-command'
export { legacySourcePositionForSequence }
export { LegacyProvenanceError }

/** Both planning and execution read the original rows. No projection or normalized fallback. */
export function inspectLegacyPlatformProvenance(db: Executor, input: LegacyPlatformProvenanceInput, expectedFingerprint?: string) {
  return db.transaction(tx => inspectInSnapshot(tx, input, expectedFingerprint))
}
function inspectInSnapshot(db: Executor, input: LegacyPlatformProvenanceInput, expectedFingerprint?: string) {
  const parsed = legacyPlatformProvenanceSchema.safeParse(input)
  if (!parsed.success) reject('legacy_provenance_invalid', parsed.error.issues.map(issue => issue.message).join('; '))
  const target = originalLegacyProvenanceInput(db, input.queryId)
  const query = target.query
  if (!query) reject('legacy_query_missing', 'Original query does not exist')
  if (query.interface !== input.interface || query.queryKey !== input.queryKey || query.rdjb !== input.rdjb || query.queriedAt !== input.queriedAt)
    reject('legacy_query_identity_conflict', 'queryId and complete original natural key must agree')
  if (query.collectionEvidence !== null) reject('legacy_query_not_legacy', 'Only queries with null collectionEvidence can receive separate legacy metadata')
  const collection = input.collection
  if (collection.queriedAt !== query.queriedAt || collection.effectiveConditions.uscc !== query.queryKey
    || collection.titleScope.rdjb.join(',') !== query.rdjb || recognizedStoredStatus(collection) !== query.status)
    reject('legacy_collection_identity_conflict', 'Original collection conditions, time, title scope and status must agree with the query')
  const rows = target.rows
  if (rows.length !== input.relations.length || rows.length !== collection.rows.length)
    reject('legacy_relation_set_conflict', 'Supplement must cover every original relation and original collection row')
  for (const [index, row] of rows.entries()) {
    const witness = input.relations[index]!
    const original = collection.rows[index]!
    if (row.sequenceNo !== index + 1 || witness.sequenceNo !== row.sequenceNo || witness.relationKey !== row.relationKey
      || witness.relationKey !== (original.id ?? null) || !isDeepStrictEqual(witness.rawFields, row.rawFields)
      || !isDeepStrictEqual(original, row.rawFields))
      reject('legacy_relation_payload_conflict', `Original relation identity/order/rawFields conflict at sequence ${index + 1}`)
    const page = legacySourcePositionForSequence(collection, row.sequenceNo)
    if (page.sourcePage === null || (original.rdjb?.trim() && original.rdjb.trim() !== page.sourceRdjb))
      reject('legacy_page_title_conflict', `Original page and row rdjb conflict at sequence ${index + 1}`)
  }
  // Include original serialized raw bytes, IDs and immutable query fields. Review/decision tables are never written.
  const inputFingerprint = createHash('sha256').update(JSON.stringify({ query, rows })).digest('hex')
  if (expectedFingerprint && expectedFingerprint !== inputFingerprint)
    reject('legacy_source_drift', 'Original query or relations changed since preflight')
  const existing = existingTargetLegacyProvenance(db, target.collectionId)
  if (existing && (existing.sourceIdentity !== input.sourceIdentity || existing.sourceSha256 !== input.sourceSha256
    || existing.segmentIndex !== input.segmentIndex || existing.inputFingerprint !== inputFingerprint
    || !isDeepStrictEqual(existing.collection, collection))) reject('legacy_provenance_conflict', 'Query already has different immutable legacy provenance')
  const sourceOwner = targetLegacySourceOwner(db, input)
  if (sourceOwner && sourceOwner.collectionId !== target.collectionId)
    reject('legacy_source_identity_conflict', 'Original source file/segment already belongs to another query')
  return { inputFingerprint, exists: !!existing, relationCount: rows.length }
}

export function writeLegacyPlatformProvenance(db: Executor, input: LegacyPlatformProvenanceInput, batchId: number, expectedFingerprint: string) {
  return db.transaction(tx => {
    const state = inspectInSnapshot(tx, input, expectedFingerprint)
    if (!state.exists) {
      insertTargetLegacyProvenance(tx, input, batchId, state.inputFingerprint)
    }
    return { queryId: input.queryId, provenanceKind: 'legacy_pagination', typedState: 'unknown', relationCount: state.relationCount, rowsWritten: state.exists ? 0 : 1 }
  })
}
