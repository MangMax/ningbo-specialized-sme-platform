export type { TaskList, TaskSummary } from '../../../core/lib/task-center'

declare module '../../../core/lib/task-center' {
  interface TaskSummaryExtensions {
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
    items?: { id: string; status: string; completeness: string; positions: { source: string; rdjb: string | null; page: number }[] }[]
  }
}
