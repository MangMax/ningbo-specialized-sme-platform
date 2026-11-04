import type { EventSource } from './correspondence-view'

export interface EventArchiveCandidate {
  edge: { type: string; eventId: number; relationId: number; role: string }
  status: 'candidate'
  ruleId: string
  ruleVersion: string
  evidence: {
    identity: { enterpriseId: number; officialUsccRaw: string | null; rowUsccRaw: string | null; rawUscc?: string | null }
    title: { official: string; row: string; rawRdjb?: string | null }
    process: { eventType: string; declareKind: string | null; appliedAt: string | null; status?: string | null; normalizationConflicts?: unknown[] }
    temporal: { eventYear: number | null; eventBatchSeq: number | null; relationYear: number | null; relationBatch: string | null; awardBatchLabel: string | null; awardYear?: number | null; decisionYear?: number | null; comparisonYear?: number | null }
    source: { interface: string; sourceRdjb: string | null; sourcePage: number | null; queryId: number; relationId: number; sequenceNo: number; queriedAt: string; status: string }
  }
  conflicts: string[]
  existingCorrespondenceId: number | null
  revision: number | null
  existingStatus: string | null
  recommendation: 'candidate' | 'existing_decision'
}
export interface EventArchivePage {
  event: EventSource
  ruleVersion: string
  rows: EventArchiveCandidate[]
  total: number
  page: number
  pageSize: number
  coverage: { rows: Array<{ id: number; interface: string; queryKey: string; titleCode: string | null; rdjb: string; queriedAt: string; status: string; outcome: string; failureReason: string | null; relationCount: number; candidateCount: number; collectionEvidence: unknown }>; total: number; page: number; pageSize: number }
  interfaces: Array<{ interface: string; queried: boolean; states: Array<{ status: string; count: number }> }>
}
export const ARCHIVE_CONFLICT_LABELS: Record<string, string> = {
  official_year_missing: '公布年份缺失', official_decision_year_missing: '复核结论年缺失', platform_year_missing: '平台年份缺失', official_batch_missing: '公布批次缺失', platform_batch_missing: '平台批次缺失',
  year_mismatch: '年份不同', batch_mismatch: '批次不同', process_type_unknown: '事项未记录', process_type_mismatch: '事项不同', application_after_decision: '申报时间晚于公布决定', multiple_candidate_rows: '存在多条候选，需逐条核对',
}
export const ARCHIVE_OUTCOME_LABELS: Record<string, string> = {
  not_queried: '未查询', failed: '查询失败', partial: '部分结果', no_record: '完整查询无记录', candidates: '有对应候选', no_candidate: '有记录但无对应候选', empty_unproven: '无归档原行，完整性未证明',
}
