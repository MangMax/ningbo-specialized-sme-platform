import { sql, type SQL } from 'drizzle-orm'
import { getTaskKind } from '../../lib/task-catalog'
import { getAppModules } from '../../../../lib/app-modules'
import { isTerminalJobState, progressPercent, type JobProgress, type JobState, type JobSummaryDto } from '../../lib/job'
import type { job } from '../../../../db/postgresql/job-tables'
import type { PostgresJobSpec } from './job-runner-postgres'

/** 任务行，解码持久化的 JSON 字段并排除执行器内部字段。 */
export type JobRow = Pick<typeof job.$inferSelect,
  'id' | 'kind' | 'state' | 'error' | 'createdAt' | 'startedAt' | 'finishedAt'
> & {
  params: Record<string, unknown>
  progress: JobProgress
  result: unknown
}

/** 参数校验结果。失败带一句中文原因,路由直接当 400 的文案。 */
export type JobParseResult =
  | { ok: true; params: Record<string, unknown> }
  | { ok: false; message: string }

/**
 * handler 的收尾:**产出**,外加可选的**部分失败**说明。
 *
 * 为什么要「有 result 的失败」:批量任务里「3 份里第 2 份挂了、第 1/3 份是好的」是个
 * 真实且有用的结果。只抛异常的话,那两份的产出就丢了(失败路径只记 `error`);
 * 只返回 result 又会让任务显示 `done`,调用方以为全成了。所以两样都给:
 * **状态诚实(`failed`),明细完整(`result.files[]`)**。
 */
export interface JobCompletion {
  /**
   * 产出。哪怕是空对象也要给 —— 它表示「跑完了,没有产出」。
   *
   * 必填是有意的:"忘了给产出"要在编译期报错,而不是在运行期悄悄变成"沿用上一次
   * 的结果"。`result: null` 才是**显式清空**。没有产出的执行(抛异常、排队取消、
   * 未接入的 kind)由 runner 直接收尾，保留上一次的检查点。
   */
  result: unknown
  /** Optional truthful progress for partial-result jobs. */
  progress?: { done: number; total: number }
  /** 给了就是部分失败:状态记 `failed`,但 `result` 照样保留。 */
  error?: string
  /**
   * 给了就是**被取消时主动停下**:状态记 `cancelled`,`result` 里带上**已经做完的部分**。
   *
   * 与「让 `throwIfCancelled` 抛出去」的区别就在这半边产出:抛出会让 runner 只记一条
   * 取消说明,已经渲染好的那几份的明细就没了。想要明细的 handler 走这条路
   * (见 `server/utils/jobs/render-pages.ts`),不在乎的照旧抛。
   */
  cancelled?: boolean
}

/** 一个任务种类的**全部元信息**,注册表里一项。
 *
 * `parse` 与 `run` **分开**是有意的:参数校验发生在**提交那一刻**(路由里),
 * 所以参数写错得到的是同步的 `400`,不会先建一个注定失败的任务再让它 `failed`。
 * 这对代理很要紧 —— 它拿到 400 就知道是自己参数写错了,拿到一个 `failed` 的任务
 * 则要先 GET 出来看原因才知道。
 */
export interface JobSpec {
  kind: string
  /** Optional admission policy for resource-heavy persisted export jobs. */
  maxPending?: number
  deduplicateRequest?: boolean
  /** `ready` = 有 `run` 可跑;`todo` = 已登记、尚未接入(提交时明确报 501)。 */
  status: 'ready' | 'todo'
  summary: string
  /** `todo` 的原因与去处(为什么还没接、接在哪张票上)。 */
  note?: string
  /** 参数形状的**一句话**说明。给 `GET /api/jobs/kinds` 用 —— 代理据此知道怎么拼 `params`。 */
  paramsHint?: string
  /** Development OpenAPI contribution; order preserves the published parameter guide. */
  openAPIParams?: { description: string; order?: number }
  parse: (raw: Record<string, unknown>) => JobParseResult
  /** 提交时就能算出的**分母**(进度条的 total)。默认 1。 */
  total?: (params: Record<string, unknown>) => number
  postgres?: PostgresJobSpec
}

/**
 * 任务在 HTTP 面上的形状 —— `GET /api/jobs`、`GET /api/jobs/:id`、`DELETE` 三处
 * 共用一份投影。三处各写一份的话,加一个字段就会漏一个(票 09/17 的 `fileColumns`
 * 已经因为这个理由抽过一次,这里同理)。
 *
 * `percent` 是**派生**的(`progressPercent`,floor 取整),不落库 —— 见 `lib/job.ts`。
 * `result` / `error` 保持可空:排队中与运行中的任务本来就没有它们,
 * 用 `null` 明说「还没有」,而不是省略字段让客户端去猜 undefined。
 */
export interface JobDto {
  id: string
  kind: string
  state: JobState
  progress: JobProgress
  percent: number | null
  params: Record<string, unknown>
  result: unknown
  error: string | null
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
}

function jobPercent(row: { state: JobState; progress: JobProgress }, phaseAvailable: number | boolean | null): number | null {
  if (phaseAvailable !== null) {
    if (row.state === 'done') return 100
    if (row.state === 'queued' || (row.state === 'running' && !phaseAvailable)) return null
  }
  return progressPercent(row.progress)
}

export function progressPhaseMatch(phase: SQL) {
  const cases = getAppModules().flatMap(module => (module.jobKinds ?? []).flatMap(job =>
    job.progressPhase ? [sql`WHEN kind = ${job.kind} THEN CASE WHEN state = 'running' THEN coalesce(${phase} = ${job.progressPhase}, false) ELSE false END`] : []))
  return cases.length ? sql<number | boolean | null>`CASE ${sql.join(cases, sql` `)} END` : sql<number | boolean | null>`NULL`
}

export function toJobDto(row: JobRow): JobDto {
  const progressPhase = getTaskKind(row.kind)?.progressPhase
  return {
    id: row.id,
    kind: row.kind,
    state: row.state,
    progress: row.progress,
    percent: jobPercent(row, progressPhase ? (row.result as { phase?: unknown } | null)?.phase === progressPhase : null),
    params: row.params,
    result: row.result ?? null,
    error: row.error ?? null,
    createdAt: row.createdAt,
    startedAt: row.startedAt ?? null,
    finishedAt: row.finishedAt ?? null,
  }
}

/** 列表查询条件,与 `GET /api/jobs` 的 query 参数一一对应。 */
export interface JobQuery {
  /** 种类(多值命中任一)。 */
  kind?: string[]
  /** 状态(多值命中任一)。 */
  state?: JobState[]
  /** 上限。默认 50,硬上限 200。 */
  limit?: number
}

export const DEFAULT_JOB_LIMIT = 50
export const MAX_JOB_LIMIT = 200

export function toJobSummary(row: {
  id: string; kind: string; state: JobState; progress: JobProgress
  createdAt: string; startedAt: string | null; finishedAt: string | null
  hasResult: number | boolean; hasError: number | boolean; phaseAvailable: number | boolean | null
}): JobSummaryDto {
  return {
    id: row.id, kind: row.kind, state: row.state, progress: row.progress,
    percent: jobPercent(row, row.phaseAvailable),
    error: row.hasError ? '任务有错误，请读取详情' : null,
    createdAt: row.createdAt, startedAt: row.startedAt, finishedAt: row.finishedAt,
    resultSummary: { available: !!row.hasResult },
    detailUrl: `/api/jobs/${row.id}`,
    capabilities: { cancel: !isTerminalJobState(row.state) },
  }
}
