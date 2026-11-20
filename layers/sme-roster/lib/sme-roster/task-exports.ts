import type { TaskSummary } from '../../../core/lib/task-center'

export const TASK_EXPORTS = [
  { titleCode: 'little_giant', label: '专精特新“小巨人”', path: '/api/roster/exports/current/little-giant' },
  { titleCode: 'specialized_sme', label: '专精特新中小企业', path: '/api/roster/exports/current/specialized-sme' },
  { titleCode: 'innovative_sme', label: '创新型中小企业', path: '/api/roster/exports/current/innovative-sme' },
] as const
export type TaskExportTitle = typeof TASK_EXPORTS[number]['titleCode']

export function taskArtifactExpiry(task: TaskSummary): number {
  const artifact = task.export?.artifact
  if (artifact?.availability !== 'available') return Infinity
  const expiry = Date.parse(artifact.expiresAt)
  return Number.isFinite(expiry) ? expiry : Infinity
}
