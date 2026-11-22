import type { JobSpec } from './job-contract'

const specs = new Map<string, JobSpec>()

/** 登记一个 kind。同名重复登记**抛错** —— 静默覆盖会让「注册了但跑的是另一个」很难查。 */
export function registerJob(spec: JobSpec): void {
  if (specs.has(spec.kind)) throw new Error(`任务种类重复登记:${spec.kind}`)
  specs.set(spec.kind, spec)
}

export function getJobSpec(kind: string): JobSpec | undefined {
  return specs.get(kind)
}

/** 已登记的全部 kind(按名字排序,便于文档与断言比对)。 */
export function jobSpecs(): JobSpec[] {
  return [...specs.values()].sort((a, b) => a.kind.localeCompare(b.kind))
}

/** 清空注册表(测试用 —— 每个用例都要从干净状态起)。 */
export function clearJobSpecs(): void {
  specs.clear()
}
