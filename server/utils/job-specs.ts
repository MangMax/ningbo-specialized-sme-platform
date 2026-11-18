import { getAppModules } from '../../lib/app-modules'
import * as core from '../../layers/core/server/modules/core/job-specs'
import * as roster from '../modules/sme-roster/job-specs'
import { getJobSpec, registerJob, type JobSpec } from '../../layers/core/server/utils/job-runner'

// Bind the shared manifest references to server-only implementations.
const moduleSpecs: ReadonlyMap<string, Record<string, JobSpec>> = new Map<string, Record<string, JobSpec>>([
  ['core', core],
  ['sme-roster', roster],
])

export function registerJobSpecs(): void {
  for (const { id, jobKinds } of getAppModules()) {
    const specs = moduleSpecs.get(id)
    for (const { kind, spec: reference } of jobKinds ?? []) {
      const spec = specs?.[reference]
      if (spec?.kind !== kind) throw new Error(`模块「${id}」的任务「${kind}」引用了无效的 JobSpec「${reference}」`)
      if (!getJobSpec(kind)) registerJob(spec)
    }
  }
}
