import { isDeepStrictEqual } from 'node:util'
import { legacyPlatformProvenanceSchema, type LegacyPlatformProvenanceInput } from '../../lib/platform/legacy-provenance'
import { legacySourcePositionForSequence } from '../../lib/platform/legacy-provenance'
import type { Executor } from './roster-import'
import { LegacyProvenanceError, rejectLegacyProvenance as reject, originalLegacyProvenanceInput,
  existingTargetLegacyProvenance, targetLegacySourceOwner, insertTargetLegacyProvenance } from '../../lib/platform/legacy-provenance-command'
import { legacyProvenanceFingerprint } from './platform-legacy-provenance-fingerprint'
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
  const inputFingerprint = legacyProvenanceFingerprint(input,target,expectedFingerprint)
  const collection = input.collection, rows = target.rows
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
