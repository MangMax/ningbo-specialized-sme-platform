import type { JobState } from './job'
export const TASK_STATES: Record<JobState, string> = { queued: '排队中', running: '运行中', done: '已完成', failed: '失败', cancelled: '已取消' }
export interface TaskSummary {
  id: string; kind: string; label: string; module: string | null; group: string; state: JobState
  createdAt: string; startedAt: string | null; finishedAt: string | null
  progress: { done: number; total: number | null; unit: string; stage: string }
  error: string | null
  outcome: { complete: number; partial: number; failed: number; notQueried: number; unfinished: number | null; attempt: number } | null
  reconcile?: { targets: number | null; needsReview: number | null; queryFailed: number | null; notQueried: number | null }
  /** Reconcile-only collection coverage, counted in slots/ranges, separate from target decisions.
   * Historical reports without coverage retain null counts (unknown), never inferred completion. */
  reconcileCollection?: {
    complete: number | null; partial: number | null; failed: number | null; unknown: number | null
    unfinished: number | null
    positions: { source: 'businessList' | 'queryList'; rdjb: string | null; page: number }[]
    positionsTruncated: boolean
  }
  export?: {
    titleCode: string | null; regenerateOf: string | null; phase: string
    generatedAt: string | null; snapshotStartedAt: string | null; ruleVersion: string | null; dataVersion: string | null
    counts: { eligible: number; pending: number; excluded: number } | null
    artifact: { id: string; downloadUrl: string; filename: string; size: number; sha256: string; generatedAt: string; expiresAt: string; availability: 'available' | 'expired' | 'missing' } | null
    canDownload: boolean; canRegenerate: boolean
  }
  snapshot?: { sources?: { source: string; requests: number | null; rows: number | null; failed: number | null; unfinished: number | null }[]; enterprises: number | null; requests: number | null; rows: number | null; unfinished: number | null
    positions: { enterpriseId: number | null; source: string; rdjb: string | null; rows: number | null; page: number | null }[]; truncated: boolean }
  annual?: { total: number | null; done: number; failed: number; unfinished: number | null; attempt: number | null }
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
export interface TaskList { rows: TaskSummary[]; total: number; page: number; pageSize: number; counts: { all: number } & Record<string, number>; exportReady: boolean; authorized: boolean }

export function taskArtifactExpiry(task: TaskSummary): number {
  const artifact = task.export?.artifact
  if (artifact?.availability !== 'available') return Infinity
  const expiry = Date.parse(artifact.expiresAt)
  return Number.isFinite(expiry) ? expiry : Infinity
}
