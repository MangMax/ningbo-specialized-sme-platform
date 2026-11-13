/** Capture-time authentication. Never an online completeness fallback. */
import { createHash } from 'node:crypto'
import type { platformQuery, platformRelation } from '../../db/schema'
import { readCompleteLegacySlot } from './client'
import type { PlatformRow } from './types'

export const RECONCILE_SLOT_RULE = 'legacy-reconcile-slot-v1'
export const RECONCILE_SLOT_T04 = 't04-collection-reconcile-slot-v2'
export const RECONCILE_SLOT_COMPLETION = 'reconcile-slot-capture-v1'
type Query = Pick<typeof platformQuery.$inferSelect, 'id'|'interface'|'rdjb'|'queryKey'|'queriedAt'|'status'>
export type SlotRelation = Omit<Pick<typeof platformRelation.$inferSelect, 'id'|'sequenceNo'|'relationKey'|'nameRaw'|'usccRaw'|'province'|'status'|'batch'|'declareKind'|'appliedAt'|'awardBatchLabel'|'year'|'rawFields'>, 'status'|'declareKind'> & { status: string|Buffer|null; declareKind: string|null }
export type SlotCell = { name: string; storageClass: string; hex: string }
export type SlotBytes = { storageClass: string; byteLength: number|null; sha256: string|null }
export const slotFallbackColumns = ['relation_key','name_raw','uscc_raw','province','status','batch','declare_kind','applied_at','award_batch_label','year'] as const
export type SlotInput = {
  query: Query
  rawResponse: SlotBytes | { missing: true }
  relations: { id: number; sequenceNo: number; rawFields: SlotBytes; fallbackCells: SlotCell[] }[]
}
type Bound = { rule: typeof RECONCILE_SLOT_RULE; rawArchiveId: number; inputSha256: string }
export type ReconcileSlotCapture =
  | { state: 'uncaptured'; rule: null; rawArchiveId: null; rowCount: null; inputSha256: null; reason: string }
  | (Bound & { state: 'verified'; rowCount: number; reason: null })
  | (Bound & { state: 'miss'|'error'; rowCount: number|null; reason: string })

export function slotInputDigest(input: SlotInput) {
  const { id, interface: source, rdjb, queryKey, queriedAt } = input.query
  return createHash('sha256').update(JSON.stringify({
    rule: RECONCILE_SLOT_RULE,
    query: { id, interface: source, rdjb, queryKey, queriedAt },
    rawResponse: input.rawResponse,
    relations: input.relations,
  })).digest('hex')
}

/** Matches the old service's truthiness, key order and year conversion exactly. */
export function slotPayloadRow(row: SlotRelation): Record<string, unknown> {
  if (row.rawFields && Object.keys(row.rawFields).length > 0) return row.rawFields
  const out: Record<string, unknown> = {}
  if (row.relationKey) out.id = row.relationKey
  if (row.nameRaw) out.qymc = row.nameRaw
  if (row.usccRaw) out.tyshxydm = row.usccRaw
  if (row.province) out.szsfmc = row.province
  if (row.status) out.cszt = row.status
  if (row.batch) out.whpc = row.batch
  if (row.declareKind) out.sblx = row.declareKind
  if (row.appliedAt) out.sqsj = row.appliedAt
  if (row.awardBatchLabel) out.personuuid = row.awardBatchLabel
  if (row.year != null) out.year = String(row.year)
  return out
}
export function slotLegacyRow(row: SlotRelation): PlatformRow {
  const out: PlatformRow = {}
  for (const [key, value] of Object.entries(slotPayloadRow(row))) {
    out[key] = value == null ? '' : typeof value === 'string' ? value
      : typeof value === 'number' || typeof value === 'boolean' ? String(value) : JSON.stringify(value)
  }
  return out
}
/** Decode errors are supplied by the original ORM boundary, separately from misses. */
export function captureReconcileSlot(input: SlotInput, archiveId: number|null, raw: string|null, decoded: { rows: SlotRelation[] } | { error: string }): ReconcileSlotCapture {
  if (input.query.interface === 'recognized_list') return { state:'uncaptured',rule:null,rawArchiveId:null,rowCount:null,inputSha256:null,reason:'not_legacy_slot' }
  if (archiveId === null || 'missing' in input.rawResponse) return { state:'uncaptured',rule:null,rawArchiveId:null,rowCount:null,inputSha256:null,reason:'missing_raw_ref' }
  const bound: Bound = { rule:RECONCILE_SLOT_RULE,rawArchiveId:archiveId,inputSha256:slotInputDigest(input) }
  if (input.query.status !== 'success' && input.query.status !== 'no_record') return { ...bound,state:'miss',rowCount:input.relations.length,reason:'legacy_slot_not_complete' }
  if ('error' in decoded) return { ...bound,state:'error',rowCount:null,reason:decoded.error }
  const rows = decoded.rows.map(slotLegacyRow)
  if (!readCompleteLegacySlot(raw,input.query,rows)
    || (input.query.status === 'no_record') !== (rows.length === 0)) {
    return { ...bound,state:'miss',rowCount:rows.length,reason:'legacy_slot_not_complete' }
  }
  return { ...bound,state:'verified',rowCount:rows.length,reason:null }
}
