import { sql, type SQL } from 'drizzle-orm'
import { getTaskKind } from '../../lib/task-catalog'
import { getAppModules } from '../../../../lib/app-modules'
import { isTerminalJobState, progressPercent, type JobProgress, type JobState, type JobSummaryDto } from '../../lib/job'
import type { job } from '../../../../db/schema'

/** 任务行(直接取表的推断类型,免得手写一份会漂移的镜像)。 */
export type JobRow = typeof job.$inferSelect

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
