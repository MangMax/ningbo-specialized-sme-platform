import { Cron } from 'croner'
import type { AppModuleManifest } from '../layers/core/lib/core/module-registry'

export function jobSchedules(modules: readonly AppModuleManifest[]) {
  return modules.flatMap(module => (module.jobKinds ?? []).flatMap(job => job.schedule
    ? [{ kind: job.kind, label: job.label, ...job.schedule }]
    : []))
}

export function nitroJobSchedules(modules: readonly AppModuleManifest[], handler: string) {
  const tasks: Record<string, { handler: string; description: string }> = {}
  const scheduledTasks: Record<string, string[]> = {}
  for (const job of jobSchedules(modules)) {
    new Cron(job.cron, { paused: true })
    tasks[job.kind] = { handler, description: job.label }
    const group = scheduledTasks[job.cron] ??= []
    group.push(job.kind)
  }
  return { tasks, scheduledTasks }
}
