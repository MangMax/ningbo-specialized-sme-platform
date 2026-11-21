import type { JobState } from '../../lib/job'
import { getTaskKind } from '../../lib/task-catalog'
import type { TaskSummary } from '../../lib/task-center'

export type TaskErrorFacts = {
  state: JobState
  hasError: number | boolean
  restarted: number | boolean
}

export function taskSummaryError(row: TaskErrorFacts, failed?: string, restarted?: string) {
  if (!row.hasError || row.state !== 'failed') return null
  if (row.restarted) return restarted ?? '服务重启，任务中断；请从业务入口重新提交。'
  return failed ?? '任务失败；原始错误可能含敏感信息，摘要不展示。请核对业务入口与配置。'
}

export function taskSummaryCapabilities(
  state: JobState,
  authorized: boolean,
  writable: boolean,
  retry = false,
  retryItemIds: string[] = [],
  reason = '此任务不支持安全重试，请从原业务入口核对后重新提交。',
): TaskSummary['capabilities'] {
  if (!writable) return { cancel: false, retry: false, retryItemIds: [], reason: '当前任务中心只读。' }
  const active = state === 'queued' || state === 'running'
  return {
    cancel: authorized && active,
    retry: authorized && retry,
    retryItemIds: retry ? retryItemIds : [],
    reason: !authorized ? '当前请求仅可查看任务。' : active ? '可请求取消；实际状态以服务端终态为准。' : reason,
  }
}

export function taskSummaryBase(row: Pick<TaskSummary, 'id' | 'kind' | 'state' | 'createdAt' | 'startedAt' | 'finishedAt'>
  & { done: number; total: number }) {
  const kind = getTaskKind(row.kind)
  const group = kind?.group.id ?? 'all'
  const kindName = row.kind.slice(0, 100)
  return {
    id: row.id, kind: kindName, label: kind?.label ?? kindName, module: kind?.module ?? null, group, state: row.state,
    createdAt: row.createdAt, startedAt: row.startedAt, finishedAt: row.finishedAt,
    progress: {
      done: Number.isFinite(row.done) ? row.done : 0,
      total: kind && row.total > 0 ? row.total : null,
      unit: kind?.module === 'core' && group === 'ocr' ? '份文件' : '项',
      stage: row.state === 'queued' ? '等待执行' : row.state === 'running' ? kind?.label ?? '执行中（阶段未知）' : '执行结束',
    },
  } satisfies Pick<TaskSummary, 'id' | 'kind' | 'label' | 'module' | 'group' | 'state' | 'createdAt' | 'startedAt' | 'finishedAt' | 'progress'>
}
