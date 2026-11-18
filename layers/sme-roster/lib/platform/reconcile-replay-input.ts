/** Selected-original encoding. The writer authenticates the complete source. */
import type { PlatformStoredQuery } from './read'
import type { RosterImportPlatformQuery } from '../../../../lib/roster-import-client'
import { normalizePlatformRelation } from './normalization'
import { platformQuerySourceConflict, type PlatformQueryReplaySource } from './query-replay'

type QueryCoordinates = Pick<PlatformStoredQuery, 'interface' | 'queryKey' | 'rdjb' | 'queriedAt'>
export interface StoredReplayInput { encode(query: RosterImportPlatformQuery): RosterImportPlatformQuery }

/** Freeze selected source values inside the reader transaction, not writer callbacks. */
export function snapshotStoredReplayInput(
  query: QueryCoordinates,
  source: PlatformQueryReplaySource,
  sequenceNos: readonly number[],
): StoredReplayInput {
  const rows = new Map(sequenceNos.map(sequenceNo => {
    const row = source.relationAt(sequenceNo)
    if (!row) throw new Error('Missing original reconcile sequence')
    return [sequenceNo, { values: row.values, ref: row.ref }] as const
  }))
  const snapshot: PlatformQueryReplaySource = {
    ref: source.ref, metadata: source.metadata, relationCount: source.relationCount,
    relationAt: sequenceNo => rows.get(sequenceNo),
  }
  return { encode: legacyQuery => encodeStoredReplayQuery(query, snapshot, sequenceNos, legacyQuery) }
}

function encodeStoredReplayQuery(
  query: QueryCoordinates,
  source: PlatformQueryReplaySource,
  sequenceNos: readonly number[],
  legacyQuery: RosterImportPlatformQuery,
): RosterImportPlatformQuery {
  if (legacyQuery.interface !== query.interface || legacyQuery.queryKey !== query.queryKey
    || legacyQuery.rdjb !== query.rdjb || legacyQuery.queriedAt !== query.queriedAt) {
    throw new Error('Invalid original reconcile query binding')
  }
  const sequences = new Set(sequenceNos), rows = legacyQuery.relations ?? []
  const complete = rows.length === sequences.size
    && new Set(rows.map(row => row.sequenceNo)).size === sequences.size
    && rows.every(row => sequences.has(row.sequenceNo))
  const compatible = rows.every(row => !Buffer.isBuffer(row.rawFields?.cszt)
    && normalizePlatformRelation(query.interface, row).normalizationConflicts.length === 0)
  if (complete && compatible && !platformQuerySourceConflict(legacyQuery, source)) return legacyQuery
  return {
    interface: query.interface, queryKey: query.queryKey, rdjb: query.rdjb,
    queriedAt: query.queriedAt, reuseExisting: true,
    relations: sequenceNos.map(sequenceNo => ({ sequenceNo })),
  }
}
