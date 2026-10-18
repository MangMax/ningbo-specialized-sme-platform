import type { getRecordComparison, listRecordComparisonSources } from '../../server/utils/record-comparison'
import type { OfficialEvidence, CurrentEvidence } from '../../server/utils/comparison-scope-proof-source'
import type { RecordComparisonInput } from './record-comparison'

export type RecordComparisonResult = ReturnType<typeof getRecordComparison>
export type ComparisonSourceCatalog = ReturnType<typeof listRecordComparisonSources>
export type ComparisonSource = ComparisonSourceCatalog['rows'][number]
export type ComparisonSourceKind = ComparisonSource['kind']
export interface ComparisonSelection { queryIds: number[]; exportBatchIds: number[]; officialSourceDocumentIds: number[]; proofIds: number[] }

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
  process_status_or_role_not_decisive: '流程状态或对应角色不足以判断',
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

function ids(value: unknown): number[] {
  if (typeof value !== 'string' || !value) return []
  const parts = value.split(',')
  if (parts.some(part => !/^[1-9]\d*$/.test(part) || !Number.isSafeInteger(Number(part)))) return []
  return [...new Set(parts.map(Number))]
}
export function comparisonSelectionFromQuery(query: Record<string, unknown>): ComparisonSelection {
  return { queryIds: ids(query.queryIds), exportBatchIds: ids(query.exportBatchIds), officialSourceDocumentIds: ids(query.officialSourceDocumentIds), proofIds: ids(query.proofIds) }
}
export function comparisonSelectionQuery(selection: ComparisonSelection): Record<string, string> {
  return { queryIds: selection.queryIds.join(','), exportBatchIds: selection.exportBatchIds.join(','), officialSourceDocumentIds: selection.officialSourceDocumentIds.join(','), ...(selection.proofIds.length ? { proofIds: selection.proofIds.join(',') } : {}) }
}
export function comparisonRequest(selection: ComparisonSelection, page: number, pageSize: number, classification?: RecordComparisonInput['classification']): RecordComparisonInput {
  return { ...selection, page, pageSize, ...(classification ? { classification } : {}) }
}
export function sourceSelectionKey(kind: ComparisonSourceKind): keyof ComparisonSelection {
  const keys: Record<ComparisonSourceKind, keyof ComparisonSelection> = { query: 'queryIds', export_batch: 'exportBatchIds', official_document: 'officialSourceDocumentIds' }
  return keys[kind]
}
