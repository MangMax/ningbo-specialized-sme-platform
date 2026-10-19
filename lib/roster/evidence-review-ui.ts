/** Frontend contracts consumed from frozen #109/#114; no parallel backend behavior. */
import type { QueryAssessment } from './query-assessment'
export type ReviewAssessment = Omit<QueryAssessment, 'explanationValidity'> & {
  explanationValidity: Omit<QueryAssessment['explanationValidity'], 'status'> & { status: string }
}
export type DecisionVersion = NonNullable<QueryAssessment['currentDecision']['current']>
export type ReviewScope = { enterpriseId: number; titleCode: string; direction: string }
export interface ImpactRow extends ReviewScope {
  id: number; decisionId: number; latestRevisionId: number; reviewedRevisionId: number | null
  classification: string; pending: boolean; lineage: string; oldDecision: DecisionVersion
}
export interface ImpactDetail extends ImpactRow {
  currentDecision: QueryAssessment['currentDecision'] | null
  evidenceToken: ReviewScope & { decisionId: number | null; latestRevisionId: number; projectionReady: boolean }
  queryCoverage: QueryAssessment['queryCoverage'] | null
  gaps: { coverageStatus: string; truncated: boolean; subjectUnknown: boolean; projectionReady: boolean }
}
export interface CursorPage<T> { rows: T[]; nextCursor: string | null; asOf: unknown; projectionReady?: boolean }
export const coverageLabels: Record<string, string> = { complete: '覆盖完整', partial: '覆盖不完整', failed: '查询失败', unknown: '覆盖未知', not_queried: '未查询' }
export const validityLabels: Record<string, string> = { premise_invalid: '前提已失效 · 待复核', evidence_changed: '证据已变化 · 待复核', unknown: '解释有效性未知', valid: '已复核', not_applicable: '暂无解释需复核' }
