import type { JobState } from './job'
export const TASK_TABS = ['all', 'ocr', 'platform', 'export'] as const
export type TaskTab = typeof TASK_TABS[number]
/** Exclusive groups: unknown/new kinds remain visible in All until explicitly adapted. */
export const TASK_GROUPS = { ocr: ['ocr', 'render-pages'], platform: ['platform-query-batch', 'reconcile'], export: [] as string[] }
export const TASK_LABELS: Record<string, string> = { ocr: 'OCR 识别', 'render-pages': 'PDF 转图', 'platform-query-batch': '平台批量查询', reconcile: '平台核查' }
export const TASK_STATES: Record<JobState, string> = { queued: '排队中', running: '运行中', done: '已完成', failed: '失败', cancelled: '已取消' }
export interface TaskSummary {
  id: string; kind: string; label: string; group: TaskTab; state: JobState
  createdAt: string; startedAt: string | null; finishedAt: string | null
  progress: { done: number; total: number | null; unit: string; stage: string }
  error: string | null
  outcome: { complete: number; partial: number; failed: number; notQueried: number; unfinished: number; attempt: number } | null
  capabilities: { cancel: boolean; retry: boolean; retryItemIds: string[]; reason: string }
  items?: { id: string; status: string; completeness: string; positions: { source: string; rdjb: string | null; page: number }[] }[]
  links: { label: string; to: string }[]
}
export interface TaskList { rows: TaskSummary[]; total: number; page: number; pageSize: number; counts: Record<TaskTab, number>; exportReady: boolean; authorized: boolean }
