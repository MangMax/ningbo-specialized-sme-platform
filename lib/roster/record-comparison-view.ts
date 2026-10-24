import type { getRecordComparison, listRecordComparisonSources } from '../../server/utils/record-comparison'
import type { OfficialEvidence, CurrentEvidence } from '../../server/utils/comparison-scope-proof-source'
import type { RecordComparisonInput } from './record-comparison'

export type RecordComparisonResult = ReturnType<typeof getRecordComparison>
export type ComparisonSourceCatalog = ReturnType<typeof listRecordComparisonSources>
export type ComparisonSource = ComparisonSourceCatalog['rows'][number]
export type ComparisonSourceKind = ComparisonSource['kind']
export interface ComparisonSelection { queryIds: number[]; exportBatchIds: number[]; officialSourceDocumentIds: number[]; proofIds: number[] }
export interface ComparisonRouteState {
  selection: ComparisonSelection
  page: number
  pageSize: number
  classification: NonNullable<RecordComparisonInput['classification']> | 'all'
  asOf: string
  businessPage?: number
  businessPageSize?: number
}

/** Public #72 read row; decision basis is read from its audit endpoint. */
interface ComparisonProofBase {
  id: number
  status: 'candidate' | 'confirmed' | 'revoked'
  valid: boolean
  createdAt: string
  revision: number
  decidedAt: string | null
  invalidReason: 'source_drift_or_missing' | null
  sourceSummary: unknown
}
export type ComparisonProof =
  | ComparisonProofBase & { kind: 'official_coverage'; evidence: OfficialEvidence }
  | ComparisonProofBase & { kind: 'current_source_equivalence'; evidence: CurrentEvidence }
export interface ComparisonProofCatalog { rows: ComparisonProof[]; total: number; page: number; pageSize: number }
export interface ComparisonProofAudit { rows: Array<{ basis: string; decidedAt: string }>; total: number; page: number; pageSize: number }

export const COMPARISON_CLASSES: Record<string, string> = {
  historical_aligned: '历史事件与对应原行相符',
  historical_conflict: '同一事件原行陈述冲突',
  official_without_correspondence: '完整查询范围未见对应原行',
  unresolved: '证据不足 · 待核',
}

export const COMPARISON_REASONS: Record<string, string> = {
  official_event_year_unknown: '正式事件年份未确定', candidate_not_confirmed: '存在候选但尚未确认',
  official_coverage_unproved: '正式来源覆盖范围未获证明', official_source_not_selected: '该事件正式文件未在所选来源中',
  confirmed_same_event_status_conflict: '已确认同一事件的原办理状态与公布结论冲突',
  recognized_row_has_no_verified_event_version: '平台认定行与事件版本尚未核实',
  selected_process_row_missing: '所选归档查询中没有对应流程原行',
  event_process_fact_or_timing_unknown: '流程类型、年份或时序不足以判断',
  process_status_or_role_not_decisive: '现有平台记录不足以确认这条认定或复核记录',
  official_review_outcome_unknown: '正式复核结论未知',
  complete_selected_interface_scope_no_confirmed_edge: '所选完整接口查询范围内未登记已确认对应',
  collection_evidence_missing: '旧查询未保留采集范围证据', query_partial: '查询仅有部分结果',
  query_failed: '查询失败', query_not_queried: '尚未查询', incomplete_or_continuation: '页范围未完整采集',
  version_equivalence_unknown: '接口与导出版本是否相同未知', export_scope_equivalence_unknown: '接口与导出查询范围是否相同未知',
  query_conditions_or_completeness_not_comparable: '查询条件或完整性不足以比较',
  row_identity_or_title_unknown: '原行主体或称号未确定',
  official_source_completeness_not_persisted: '正式文件完整覆盖证明尚未入库',
  row_identity_unverified: '接口原行主体身份尚未核实',
  post_cutoff_decision_state_unavailable: '截止时点后的对应决定状态不可还原',
}
export function comparisonReasonText(reason: string): string { return COMPARISON_REASONS[reason] ?? '待核原因（详见来源）' }

function ids(value: unknown, official = false): number[] {
  if (typeof value !== 'string' || !value) return []
  const parts = value.split(',')
  if (parts.some(part => !(official ? /^-?[1-9]\d*$/ : /^[1-9]\d*$/).test(part) || !Number.isSafeInteger(Number(part)))) return []
  return [...new Set(parts.map(Number))]
}
export function comparisonSelectionFromQuery(query: Record<string, unknown>): ComparisonSelection {
  return { queryIds: ids(query.queryIds), exportBatchIds: ids(query.exportBatchIds), officialSourceDocumentIds: ids(query.officialSourceDocumentIds, true), proofIds: ids(query.proofIds) }
}
export function comparisonSelectionQuery(selection: ComparisonSelection): Record<string, string> {
  return { queryIds: selection.queryIds.join(','), exportBatchIds: selection.exportBatchIds.join(','), officialSourceDocumentIds: selection.officialSourceDocumentIds.join(','), ...(selection.proofIds.length ? { proofIds: selection.proofIds.join(',') } : {}) }
}
export function comparisonRequest(selection: ComparisonSelection, page: number, pageSize: number, classification?: RecordComparisonInput['classification']): RecordComparisonInput {
  return { ...selection, page, pageSize, ...(classification ? { classification } : {}) }
}
function positivePage(value: unknown, fallback: number, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) return fallback
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed <= maximum ? parsed : fallback
}
export function comparisonRouteFromQuery(query: Record<string, unknown>): ComparisonRouteState {
  const cutoff = typeof query.asOf === 'string' && /T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(query.asOf) && Number.isFinite(Date.parse(query.asOf))
    ? new Date(query.asOf).toISOString() : ''
  return {
    selection: comparisonSelectionFromQuery(query),
    page: positivePage(query.page, 1),
    pageSize: positivePage(query.pageSize, 25, 200),
    classification: typeof query.classification === 'string' && Object.hasOwn(COMPARISON_CLASSES, query.classification)
      ? query.classification as NonNullable<RecordComparisonInput['classification']> : 'all',
    asOf: cutoff,
    ...(query.businessPage === undefined ? {} : { businessPage: positivePage(query.businessPage, 1) }),
    ...(query.businessPageSize === undefined ? {} : { businessPageSize: positivePage(query.businessPageSize, 25, 200) }),
  }
}
export function comparisonRouteQuery(state: ComparisonRouteState): Record<string, string> {
  return { ...(state.businessPage === undefined ? {} : { businessPage: String(state.businessPage) }), ...(state.businessPageSize === undefined ? {} : { businessPageSize: String(state.businessPageSize) }), mode: 'record', ...comparisonSelectionQuery(state.selection), page: String(state.page), pageSize: String(state.pageSize), ...(state.classification === 'all' ? {} : { classification: state.classification }), ...(state.asOf ? { asOf: state.asOf } : {}) }
}
export function comparisonRouteKey(state: ComparisonRouteState): string {
  const selection = state.selection
  return JSON.stringify([selection.queryIds.toSorted((a, b) => a - b), selection.exportBatchIds.toSorted((a, b) => a - b), selection.officialSourceDocumentIds.toSorted((a, b) => a - b), selection.proofIds.toSorted((a, b) => a - b), state.page, state.pageSize, state.classification, state.asOf, state.businessPage ?? 1, state.businessPageSize ?? 25])
}
/** The picker uses local wall time; the URL/API cutoff is an instant. */
export function localDateTimeForInstant(instant: string): string {
  if (!instant || !Number.isFinite(Date.parse(instant))) return ''
  const date = new Date(instant)
  const pad = (value: number, width = 2) => String(value).padStart(width, '0')
  return `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`
}
export function instantFromLocalDateTime(local: string, unchangedInstant = ''): string {
  if (!local) return ''
  if (unchangedInstant) {
    const originalLocal = localDateTimeForInstant(unchangedInstant)
    if (local === originalLocal || local === originalLocal.slice(0, 19) && originalLocal.endsWith('.000') || local === originalLocal.slice(0, 16) && originalLocal.endsWith(':00.000')) return unchangedInstant
  }
  const parsed = new Date(local)
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : ''
}
export function sourceSelectionKey(kind: ComparisonSourceKind): keyof ComparisonSelection {
  const keys: Record<ComparisonSourceKind, keyof ComparisonSelection> = { query: 'queryIds', export_batch: 'exportBatchIds', official_document: 'officialSourceDocumentIds' }
  return keys[kind]!
}
