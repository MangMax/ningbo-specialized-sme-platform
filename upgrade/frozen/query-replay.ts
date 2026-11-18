/** Historical offline command fixture from ab503081dae3e24680afc9b07395a7e3ff21fc9f. */
/** Immutable replay comparison shared by public planning and explicit target commands. */
import { isDeepStrictEqual } from 'node:util'
import type { PlatformInterface } from '../../layers/sme-roster/lib/labels'
import type { RosterImportPlatformQuery, RosterImportRelation, RosterImportItemResult } from '../../lib/roster-import-client'
import { normalizePlatformRelation } from '../../layers/sme-roster/lib/platform/normalization'
import { platformObservationPayload } from '../../layers/sme-roster/lib/platform/observation-plan'
import { PlatformProjectionError } from '../../layers/sme-roster/lib/platform/projection-error'
export const replayOptionalString = (value: unknown) => typeof value === 'string' ? value.trim() || null : null
const optionalInt = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : null
function failure(kind: string, ref: string, code: string, message: string, field?: string): RosterImportItemResult {
  return { ok: false, kind, ref, error: { code, ...(field ? { field } : {}), message } }
}
/** Legacy reconcile used null as an omitted-response sentinel, never as a clear command. */
export function queryUsesReference(query: RosterImportPlatformQuery): boolean {
  return query.reuseExisting === true || (query.interface !== 'recognized_list' && query.collectionEvidence == null && query.rawResponse == null)
}

export function relationSourceConflict(source: PlatformInterface, original: RosterImportRelation, input: RosterImportRelation): string | null {
  const normalized = normalizePlatformRelation(source, input)
  const archived = normalizePlatformRelation(source, original)
  // Ownership/verification decisions belong to their existing workflows.
  for (const field of ['nameRaw', 'usccRaw', 'aliasNameRaw', 'sourceText', 'province', 'status', 'batch', 'declareKind', 'appliedAt', 'awardBatchLabel', 'year'] as const) {
    if (!Object.hasOwn(input, field)) continue
    const value = field === 'year' ? optionalInt(normalized[field]) : replayOptionalString(normalized[field])
    const stored = field === 'year' ? optionalInt(archived[field]) : replayOptionalString(archived[field])
    if (value !== stored) return field
  }
  return null
}

type QueryReplayMetadata = Required<Pick<RosterImportPlatformQuery, 'titleCode' | 'status' | 'failureReason' | 'rawResponse' | 'collectionEvidence'>>
interface QueryReplayRow {
  values: RosterImportRelation
  ref: string
  id?: number
  assertOriginal?: (input: { relationKey: string | null; rawFields: unknown }) => void
}
/** Only the source lifetime differs: the first staged insert or a persisted archive. */
export interface PlatformQueryReplaySource {
  ref: string
  metadata: QueryReplayMetadata
  relationCount: number
  relationAt(sequenceNo: number): QueryReplayRow | undefined
  /** Persisted target capture is certified only after the original assertions agree. */
  authenticateOriginal?: () => void
}

export function platformQueryInsertMetadata(query: RosterImportPlatformQuery): QueryReplayMetadata {
  return { titleCode: replayOptionalString(query.titleCode), status: query.status ?? 'not_queried', failureReason: replayOptionalString(query.failureReason), rawResponse: query.rawResponse ?? null, collectionEvidence: query.collectionEvidence ?? null }
}

export function stagedPlatformQuerySource(query: RosterImportPlatformQuery, ref: string): PlatformQueryReplaySource {
  const rows = new Map<number, QueryReplayRow>()
  for (const relation of query.relations ?? []) {
    if (!rows.has(relation.sequenceNo)) rows.set(relation.sequenceNo, { values: relation, ref: `${ref}/r${relation.sequenceNo}` })
  }
  return {
    ref,
    // These are the actual insert defaults, not assertions supplied by a replay.
    metadata: platformQueryInsertMetadata(query),
    relationCount: rows.size,
    relationAt: sequenceNo => rows.get(sequenceNo),
  }
}

/** One immutable comparison for staged planning, archive preflight and transaction rechecks. */
export function platformQuerySourceConflict(query: RosterImportPlatformQuery, source: PlatformQueryReplaySource): RosterImportItemResult | null {
  const seen = new Set<number>()
  for (const input of query.relations ?? []) {
    const row = source.relationAt(input.sequenceNo)
    if (!row) return failure('platform_query', source.ref, 'query_relation_set_conflict', 'An existing collection cannot acquire new sequence numbers', 'relations')
    seen.add(input.sequenceNo)
    const original = row.values
    const claimed = { relationKey: Object.hasOwn(input, 'relationKey') ? replayOptionalString(input.relationKey) : replayOptionalString(original.relationKey), rawFields: Object.hasOwn(input, 'rawFields') ? input.rawFields : original.rawFields }
    try {
      if (platformObservationPayload({ interface: query.interface, relationKey: replayOptionalString(original.relationKey), rawFields: original.rawFields }) !== platformObservationPayload({ interface: query.interface, ...claimed })) {
        throw new PlatformProjectionError('observation_payload_conflict', 'Collection row has a different key/raw payload')
      }
      row.assertOriginal?.(claimed)
    } catch (error) {
      if (!(error instanceof PlatformProjectionError)) throw error
      return failure('platform_relation', row.ref, error.code, error.message, 'relations')
    }
    const field = relationSourceConflict(query.interface, original, input)
    if (field) return failure('platform_relation', row.ref, 'relation_payload_conflict', `Existing source row has different ${field}`, `relations.${field}`)
  }
  for (const field of ['titleCode', 'status', 'failureReason', 'rawResponse', 'collectionEvidence'] as const) {
    if (!Object.hasOwn(query, field)) continue
    if (field === 'rawResponse' && query.rawResponse == null && query.interface !== 'recognized_list' && query.collectionEvidence == null && source.metadata.collectionEvidence == null) continue
    const value = field === 'collectionEvidence' || field === 'rawResponse' ? query[field] ?? null : replayOptionalString(query[field])
    if (!isDeepStrictEqual(source.metadata[field], value)) return failure('platform_query', source.ref,
      field === 'collectionEvidence' && query.interface === 'recognized_list' ? 'collection_evidence_conflict' : 'query_payload_conflict',
      `Existing query has different ${field}; use the actual new observation time`, field)
  }
  if (Object.hasOwn(query, 'relations') && !queryUsesReference(query) && seen.size !== source.relationCount) {
    return failure('platform_query', source.ref, 'query_relation_set_conflict', 'Replay must retain the original collection row set', 'relations')
  }
  source.authenticateOriginal?.()
  return null
}
