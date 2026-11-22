export type { TaskList, TaskSummary } from '../../../core/lib/task-center'

declare module '../../../core/lib/task-center' {
  interface TaskSummaryItem {
    id: string; status: string; completeness: string; positions: { source: string; rdjb: string | null; page: number }[]
  }
  interface TaskSummaryExtensions {
    export?: {
      titleCode: string | null; regenerateOf: string | null; phase: string
      generatedAt: string | null; snapshotStartedAt: string | null; ruleVersion: string | null; dataVersion: string | null
      counts: { eligible: number; pending: number; excluded: number } | null
      artifact: { id: string; downloadUrl: string; filename: string; size: number; sha256: string; generatedAt: string; expiresAt: string; availability: 'available' | 'expired' | 'missing' } | null
      canDownload: boolean; canRegenerate: boolean
    }
    snapshot?: { sources?: { source: string; requests: number | null; rows: number | null; failed: number | null; unfinished: number | null }[]; enterprises: number | null; requests: number | null; rows: number | null; unfinished: number | null
      positions: { enterpriseId: number | null; source: string; rdjb: string | null; rows: number | null; page: number | null }[]; truncated: boolean }
  }
}
