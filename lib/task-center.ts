import type { JobState } from './job'
export const TASK_TABS = ['all', 'ocr', 'platform', 'export'] as const
export type TaskTab = typeof TASK_TABS[number]
/** Exclusive groups: unknown/new kinds remain visible in All until explicitly adapted. */
export const TASK_GROUPS = { ocr: ['ocr', 'render-pages'], platform: ['platform-query-batch', 'reconcile', 'event-archive-candidates'], export: ['current-roster-export'] }
export const TASK_EXPORTS = [
  { titleCode: 'little_giant', label: '专精特新“小巨人”', path: '/api/roster/exports/current/little-giant' },
  { titleCode: 'specialized_sme', label: '专精特新中小企业', path: '/api/roster/exports/current/specialized-sme' },
  { titleCode: 'innovative_sme', label: '创新型中小企业', path: '/api/roster/exports/current/innovative-sme' },
] as const
export type TaskExportTitle = typeof TASK_EXPORTS[number]['titleCode']
export const TASK_LABELS: Record<string, string> = { ocr: 'OCR 识别', 'render-pages': 'PDF 转图', 'platform-query-batch': '平台批量查询', reconcile: '平台核查', 'event-archive-candidates': '公布事件候选发现', 'current-roster-export': '当前名录导出' }
export const TASK_STATES: Record<JobState, string> = { queued: '排队中', running: '运行中', done: '已完成', failed: '失败', cancelled: '已取消' }
export interface TaskSummary {
  id: string; kind: string; label: string; group: TaskTab; state: JobState
  createdAt: string; startedAt: string | null; finishedAt: string | null
  progress: { done: number; total: number | null; unit: string; stage: string }
  error: string | null
  outcome: { complete: number; partial: number; failed: number; notQueried: number; unfinished: number; attempt: number } | null
  export?: {
    titleCode: TaskExportTitle | null; regenerateOf: string | null; phase: string
    generatedAt: string | null; snapshotStartedAt: string | null; ruleVersion: string | null; dataVersion: string | null
    counts: { eligible: number; pending: number; excluded: number } | null
    artifact: { id: string; downloadUrl: string; filename: string; size: number; sha256: string; generatedAt: string; expiresAt: string; availability: 'available' | 'expired' | 'missing' } | null
    canDownload: boolean; canRegenerate: boolean
  }
  discovery?: {
    ruleVersion: string | null; scope: string; attempt: number; titleCode: string | null; throughEventId: number | null
    counts: { succeeded: number; needsReview: number; failed: number; created: number; existing: number }
    nextAfterEventId: number | null; continuationJobId: string | null
    items: { eventId: number; enterpriseId: number | null; status: string; created: number; existing: number; errorCode: string | null }[]
  }
  capabilities: { cancel: boolean; retry: boolean; retryItemIds: string[]; reason: string }
  items?: { id: string; status: string; completeness: string; positions: { source: string; rdjb: string | null; page: number }[] }[]
  links: { label: string; to: string }[]
}
export interface TaskList { rows: TaskSummary[]; total: number; page: number; pageSize: number; counts: Record<TaskTab, number>; exportReady: boolean; authorized: boolean }
