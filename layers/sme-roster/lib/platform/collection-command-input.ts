import { replayOptionalString,platformQueryInsertMetadata } from './query-replay'
import { isDeepStrictEqual } from 'node:util'
import { normalizePlatformRelation } from './normalization'
import type { RosterImportPlatformQuery } from '../roster-import-client'
import { platformQueriesInputSchema } from '../../server/utils/roster-import-platform-schema'
import { platformEvidenceError,PLATFORM_PERSISTED_SOURCE,archiveQueryKey,recognizedStoredStatus,RDJB_TITLE_CODES } from './recognized-evidence'
import type { ApplyTargetInput } from './apply-target-writer'

export type NewCollectionTargetCommand = {
  /** Original UTF-8 JSON query command, retained verbatim. Not a reuse/reference command. */
  queryText: string
  /** Original evidence JSON text, not regenerated from normalized rows. NULL when absent. */
  evidenceText: string | null
  createdAt: string
  /** Existing caller transaction batch; not a second command ledger. */
  batchId?: number
  assignments: ApplyTargetInput['assignment'][]
}
export function positive(value: number) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('Invalid target identity')
  return value
}
export function parseNewCollectionInput(input: NewCollectionTargetCommand): RosterImportPlatformQuery {
  if (input.batchId !== undefined) positive(input.batchId)
  const original: unknown = JSON.parse(input.queryText)
  platformQueriesInputSchema.parse([original])
  // The public Zod schema validates shape; retain original own raw JSON keys and types.
  const q = original as RosterImportPlatformQuery
  if (q.reuseExisting) throw new Error('Only complete new collections; reference reuse is deferred')
  if (!q.queryKey.trim() || !q.queriedAt.trim()) throw new Error('Query key and queriedAt required')
  const e = q.collectionEvidence
  if (!e && q.rawResponse == null && q.interface !== 'recognized_list') throw new Error('Legacy reference sentinel; reference reuse is deferred')
  if (!isDeepStrictEqual(e ?? null, input.evidenceText === null ? null : JSON.parse(input.evidenceText))) throw new Error('Evidence bytes do not match command')
  if (q.interface === 'recognized_list' && !e) throw new Error('Recognized collection requires original evidence')
  if (e) {
    const error = platformEvidenceError(e)
    if (error) throw new Error(error)
    const title = e.titleScope.rdjb.length === 1 ? RDJB_TITLE_CODES[e.titleScope.rdjb[0]!] : null
    const subjectKey = e.effectiveConditions.uscc ?? (e.effectiveConditions.name ? `name:${e.effectiveConditions.name}` : null)
    const keyMismatch = (subjectKey !== null && q.queryKey !== subjectKey) || ((e.rawData || e.dataRows) && q.queryKey !== archiveQueryKey(e))
    if (q.interface !== PLATFORM_PERSISTED_SOURCE[e.source] || keyMismatch || q.queriedAt !== e.queriedAt || (q.rdjb ?? '') !== e.titleScope.rdjb.join(',') || (q.titleCode ?? null) !== title || q.status !== recognizedStoredStatus(e)) throw new Error('Collection identity/status/title/source mismatch')
    if ((q.relations ?? []).length !== e.rows.length) throw new Error('Every original source row requires one relation')
    for (const [i, row] of (q.relations ?? []).entries()) {
      const raw = e.rows[i]!
      const selected = e.dataRows ? e.dataRows[i] : e.rawData ? e.rawData.rows[i] : raw
      if (row.sequenceNo !== i + 1 || !isDeepStrictEqual(row.rawFields, selected) || (row.relationKey ?? null) !== (raw.id ?? null) || (row.nameRaw ?? null) !== (raw.qymc ?? null) || (row.usccRaw ?? null) !== (raw.tyshxydm ?? null)) throw new Error('Relation sequence/raw fields/identity mismatch')
      if (q.interface === 'recognized_list' && [row.aliasNameRaw, row.province, row.status, row.batch, row.declareKind, row.appliedAt, row.awardBatchLabel, row.year].some(v => v != null)) throw new Error('Recognized fields must retain original meanings')
    }
  }
  const rows = q.relations ?? []
  if (rows.length !== input.assignments.length) throw new Error('Explicit assignment required for every row')
  for (const [i, row] of rows.entries()) {
    const normalized = normalizePlatformRelation(q.interface, row)
    if (normalized.normalizationConflicts.length) throw new Error('platform_field_conflict')
    positive(row.sequenceNo)
    if (row.sequenceNo !== i + 1) throw new Error('Complete materialized sequence required')
    const a = input.assignments[i]!
    for (const id of [row.enterpriseId, a.enterpriseId, a.commandReceiptId]) if (id != null) positive(id)
    if (a.origin !== 'command' || !a.actor || !a.basis) throw new Error('Explicit command provenance required')
    for (const field of ['enterpriseId', 'matchBasis', 'verificationStatus'] as const) if (row[field] !== undefined && row[field] !== a[field]) throw new Error('Assignment payload conflict')
  }
  return q
}

export function collectionInsertValues(q: RosterImportPlatformQuery, createdAt: string) {
  const e = q.collectionEvidence, metadata = platformQueryInsertMetadata(q)
  return {
    interface: q.interface,
    queryKey: q.queryKey,
    rdjb: replayOptionalString(q.rdjb) ?? '',
    titleCode: metadata.titleCode,
    queriedAt: q.queriedAt,
    createdAt,
    status: metadata.status,
    failureReason: metadata.failureReason,
    source: e?.source ?? null,
    evidenceStatus: e?.status ?? null,
    completedAt: e?.completedAt ?? null,
    completeness: e?.completeness ?? 'unknown',
    fullRange: e ? Number(e.fullRange) : null,
    fetchedCount: e?.fetchedCount ?? null,
    declaredTotal: e?.declaredTotal ?? null,
    scopeMode: e?.titleScope.mode ?? null,
    provenanceState: e ? 'captured' : 'unknown',
    parseState: e ? 'valid' : 'absent',
    ruleVersion: 'w4a-new-collection-v1',
    errorCode: e?.error?.code ?? null,
    errorMessage: e?.error?.message ?? null,
    maxRequests: e?.limits.maxRequests ?? null,
    maxRows: e?.limits.maxRows ?? null,
    maxDurationMs: e?.limits.maxDurationMs ?? null,
    pageSize: e?.limits.pageSize ?? null
  } as const
}
