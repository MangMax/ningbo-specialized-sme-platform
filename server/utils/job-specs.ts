import { getAppModules } from '../../lib/app-modules'
import { getJobSpec, registerJob } from '../../layers/core/server/utils/job-spec-registry'
import type { JobSpec } from '../../layers/core/server/utils/job-contract'

let installedSpecs: readonly JobSpec[] = []

export function installJobSpecs(moduleSpecs: ReadonlyMap<string, Readonly<Record<string, JobSpec>>>): void {
  installedSpecs = getAppModules().flatMap(({ id, jobKinds }) => (jobKinds ?? []).map(({ kind, spec: reference, schedule }) => {
    const spec = moduleSpecs.get(id)?.[reference]
    if (spec?.kind !== kind) throw new Error(`模块「${id}」的任务「${kind}」引用了无效的 JobSpec「${reference}」`)
    if (schedule && !spec.deduplicateRequest) throw new Error(`定时任务「${kind}」必须支持同一计划时间重复提交`)
    return spec
  }))
}

export function registerJobSpecs(): void {
  for (const spec of installedSpecs) {
    if (!getJobSpec(spec.kind)) registerJob(spec)
  }
}
