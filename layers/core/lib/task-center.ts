import type { JobState } from './job'
export const TASK_STATES: Record<JobState, string> = { queued: '排队中', running: '运行中', done: '已完成', failed: '失败', cancelled: '已取消' }
interface TaskSummaryBase {
  id: string; kind: string; label: string; module: string | null; group: string; state: JobState
  createdAt: string; startedAt: string | null; finishedAt: string | null
  progress: { done: number; total: number | null; unit: string; stage: string }
  error: string | null
  outcome: { complete: number; partial: number; failed: number; notQueried: number; unfinished: number | null; attempt: number } | null
  capabilities: { cancel: boolean; retry: boolean; retryItemIds: string[]; reason: string }
  links: { label: string; to: string }[]
}
export interface TaskSummaryExtensions {}
export type TaskSummary = TaskSummaryBase & TaskSummaryExtensions

type ProjectableTaskFields = Pick<TaskSummaryBase, 'label' | 'outcome' | 'links' | 'capabilities' | 'error'> & {
  progress: Partial<Pick<TaskSummaryBase['progress'], 'total' | 'unit' | 'stage'>>
}
export type TaskSummaryProjection = Partial<ProjectableTaskFields & TaskSummaryExtensions> & {
  [Key in Exclude<keyof TaskSummaryBase, keyof ProjectableTaskFields>]?: never
}

export interface TaskList { rows: TaskSummary[]; total: number; page: number; pageSize: number; counts: { all: number } & Record<string, number>; exportReady: boolean; authorized: boolean }
