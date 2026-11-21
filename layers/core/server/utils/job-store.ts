import { appLog, type LogContext } from '../../lib/logging'
import { jobLogModule } from '../../lib/logging/module'
import { and, desc, eq, inArray, sql, type SQL } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { getTaskKind } from '../../lib/task-catalog'
import { getAppModules } from '../../../../lib/app-modules'
import { compact } from 'es-toolkit'
import * as schema from '../../../../db/schema'
import {
  isTerminalJobState,
  makeProgress,
  progressPercent,
  type JobProgress,
  type JobState,
  type JobSummaryDto,
} from '../../lib/job'

type Db = BetterSQLite3Database<typeof schema>

/** 任务行(直接取表的推断类型,免得手写一份会漂移的镜像)。 */
export type JobRow = typeof schema.job.$inferSelect

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

/**
 * **还能被推进的状态** —— `queued` 与 `running`。
 *
 * 抽成一个常量是因为它在下面出现四次(写进度、收尾、重启对账),而它的含义
 * (「任务还活着」)比字面量本身重要:四处各写一份 `['queued','running']` 时,
 * 将来多一个非终态,就会漏改其中一处 —— 那处的表现是「悄悄不再更新那个状态」。
 */
const ACTIVE_JOB_STATES = ['queued', 'running'] as const

// ---------------------------------------------------------------------------
// 建 / 读
// ---------------------------------------------------------------------------

/**
 * 插入一条**排队中**的任务。`id` 由调用方(路由)先生成 —— 生成后要立刻放进响应里
 * (`202 { jobId }`),先插库再回读 id 会多一次查询,也没有任何好处。
 *
 * `progress.total` 由 kind 在提交时算好(render-pages 就是 `files.length`):
 * 让轮询方从第一眼就能看到「一共几份」,不用等到 100% 才知道分母。
 */
export function createJob(
  db: Db,
  input: {
    id: string
    kind: string
    params: Record<string, unknown>
    progress?: JobProgress
    logContext?: LogContext
  },
): JobRow {
  const progress = makeProgress(input.progress?.done ?? 0, input.progress?.total ?? 1)
  db.insert(schema.job)
    .values({
      id: input.id,
      kind: input.kind,
      params: input.params,
      state: 'queued',
      progress,
      createdAt: new Date().toISOString(),
    })
    .run()
  appLog({ module: jobLogModule(input.kind), source: 'task', operation: 'task.queued', outcome: 'started', taskId: input.id }, input.logContext)
  return getJob(db, input.id)!
}

export function getJob(db: Db, id: string): JobRow | null {
  return db.select().from(schema.job).where(eq(schema.job.id, id)).get() ?? null
}

function jobWhere(query: JobQuery): SQL | undefined {
  const conds: (SQL | undefined)[] = []
  if (query.kind?.length) conds.push(inArray(schema.job.kind, query.kind))
  if (query.state?.length) conds.push(inArray(schema.job.state, query.state))
  const filtered = compact(conds)
  return filtered.length ? and(...filtered) : undefined
}

/**
 * 列出任务,**新的在前**。
 *
 * 排序用 `created_at` 倒序 + `id` 倒序兜底。第二把键不是装饰:同一毫秒提交的两个任务
 * `created_at` 一模一样,不加兜底键的话顺序由 SQLite 的实现决定 —— 分页时会时有时无地
 * 漏行/重复。id 是 ULID(时间前缀),所以兜底键仍然与提交序一致。
 */
export function listJobs(db: Db, query: JobQuery = {}): { rows: JobRow[]; total: number } {
  const where = jobWhere(query)
  const limit = Math.min(MAX_JOB_LIMIT, Math.max(1, Math.floor(query.limit ?? DEFAULT_JOB_LIMIT)))

  const total = db.select({ n: sql<number>`count(*)` }).from(schema.job).where(where).get()?.n ?? 0
  const rows = db
    .select()
    .from(schema.job)
    .where(where)
    .orderBy(desc(schema.job.createdAt), desc(schema.job.id))
    .limit(limit)
    .all()

  return { rows, total }
}

// Presence checks run in SQLite: neither JSON body nor error text crosses the
// driver boundary. In particular, do not replace this with select() + deletion.
const jobSummaryColumns = () => ({
  id: schema.job.id,
  kind: schema.job.kind,
  state: schema.job.state,
  progress: schema.job.progress,
  createdAt: schema.job.createdAt,
  startedAt: schema.job.startedAt,
  finishedAt: schema.job.finishedAt,
  hasResult: sql<number>`${schema.job.result} is not null and ${schema.job.result} != 'null'`,
  hasError: sql<number>`${schema.job.error} is not null`,
  phaseAvailable: progressPhaseMatch(sql`json_extract(${schema.job.result}, '$.phase')`),
})

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

export function listJobSummaries(db: Db, query: JobQuery = {}): { rows: JobSummaryDto[]; total: number } {
  const where = jobWhere(query)
  const limit = Math.min(MAX_JOB_LIMIT, Math.max(1, Math.floor(query.limit ?? DEFAULT_JOB_LIMIT)))
  const total = db.select({ n: sql<number>`count(*)` }).from(schema.job).where(where).get()?.n ?? 0
  const rows = db.select(jobSummaryColumns()).from(schema.job).where(where)
    .orderBy(desc(schema.job.createdAt), desc(schema.job.id)).limit(limit).all()
  return { rows: rows.map(toJobSummary), total }
}

export function getJobSummary(db: Db, id: string): JobSummaryDto | null {
  const row = db.select(jobSummaryColumns()).from(schema.job).where(eq(schema.job.id, id)).get()
  return row ? toJobSummary(row) : null
}

// ---------------------------------------------------------------------------
// 状态迁移
// ---------------------------------------------------------------------------

/**
 * `queued → running`,并记 `started_at`。
 *
 * **只从 `queued` 出发**:拿到的行已不是 queued(重启对账已标失败、或被取消)时返回 null,
 * 调用方据此放弃执行 —— 这条守卫防的是「任务已被取消,runner 却还在把它捡起来跑」。
 */
export function markJobRunning(db: Db, id: string, logContext?: LogContext): JobRow | null {
  const row = getJob(db, id)
  if (!row || row.state !== 'queued') return null
  const updated = db.update(schema.job)
    .set({ state: 'running', startedAt: new Date().toISOString() })
    .where(and(eq(schema.job.id, id), eq(schema.job.state, 'queued')))
    .run()
  if (updated.changes) appLog({ module: jobLogModule(row.kind), source: 'task', operation: 'task.started', outcome: 'started', taskId: id }, logContext)
  return getJob(db, id)
}

/** 写进度。终态的任务不再改 —— 否则取消之后进度还会往回跳。 */
export function setJobProgress(db: Db, id: string, progress: JobProgress): void {
  db.update(schema.job)
    .set({ progress: progress.done === 0 && progress.total === 0 ? {done:0,total:0} : makeProgress(progress.done, progress.total) })
    .where(and(eq(schema.job.id, id), inArray(schema.job.state, [...ACTIVE_JOB_STATES])))
    .run()
}

/**
 * 终态收尾:`done` / `failed` / `cancelled` + `finished_at`。**只从非终态**出发。
 *
 * `result` 有**三种**语义,别合并:
 *  - 省略(`undefined`)= 这次执行没有新产出 → **保留**库里已有的检查点结果,连
 *    `result` 列都不碰。一次失败的重试不该抹掉上一次已经落库的已完成/部分证据。
 *    走这条的是 runner 自己发起的收尾:执行抛异常、排队时被取消、kind 尚未接入。
 *  - `null` = 调用方**显式**要求清空。
 *  - 其它值 = 写入这次的新产出(handler 正常返回必带 `result`,见 `JobCompletion`)。
 */
export function finishJob(
  db: Db,
  id: string,
  outcome: { state: Extract<JobState, 'done' | 'failed' | 'cancelled'>; result?: unknown; error?: string | null },
  logContext?: LogContext,
): JobRow | null {
  // 只更新一次:省略 result 时连列都不碰,显式 null 才能清空。
  const changes = outcome.result === undefined
    ? { state: outcome.state, error: outcome.error ?? null, finishedAt: new Date().toISOString() }
    : { state: outcome.state, result: outcome.result, error: outcome.error ?? null, finishedAt: new Date().toISOString() }
  const updated = db.update(schema.job)
    .set(changes)
    .where(and(eq(schema.job.id, id), inArray(schema.job.state, [...ACTIVE_JOB_STATES])))
    .run()
  const row = getJob(db, id)
  if (updated.changes && row) appLog({
    module: jobLogModule(row.kind), source: 'task', operation: 'task.finished',
    outcome: row.state === 'done' ? 'success' : row.state === 'cancelled' ? 'cancelled' : 'failure',
    taskId: id, counts: row.progress,
    durationMs: row.startedAt ? Math.max(0, Date.now() - Date.parse(row.startedAt)) : undefined,
    errorCode: row.state === 'failed' ? 'job_failed' : undefined,
  }, logContext)
  return row
}

/** 判断一个任务是否还能被取消 / 还能推进。 */
export function isActiveJob(row: Pick<JobRow, 'state'>): boolean {
  return !isTerminalJobState(row.state)
}

// ---------------------------------------------------------------------------
// 重启对账
// ---------------------------------------------------------------------------

/**
 * 进程启动时对账:**把上次进程留下的 `queued` / `running` 任务标成 `failed`**。
 *
 * 为什么不留着「接着跑」:任务是**进程内**的东西 —— 队列在内存里,PDFium 的文档句柄、
 * sharp 的中间态也都在内存里。进程一没,`running` 那行的真实进度就是个未知数
 * (可能已经渲染了 60 页、也可能一页没动),接着跑只是**猜**。把 `queued` 也一并标掉
 * 同理:它们是上一个进程的队列,重启后没人会去认领,留着只会永远显示「排队中」,
 * 那是比失败更坏的谎 —— 失败至少告诉调用方「重开一次」。
 *
 * 所以本票的语义是:**任务不跨重启续跑,但任务史跨重启保留**(这正是要表的原因)。
 * 返回被标记的条数(供启动日志与测试断言)。
 */
export function reconcileInterruptedJobs(db: Db): number {
  const stuck = db
    .select({ n: sql<number>`count(*)` })
    .from(schema.job)
    .where(inArray(schema.job.state, [...ACTIVE_JOB_STATES]))
    .get()?.n ?? 0
  if (!stuck) return 0

  const recovered = db.update(schema.job)
    .set({
      state: 'failed',
      error: '服务重启,任务未完成(进行中的任务不跨进程恢复,请重新提交)',
      finishedAt: new Date().toISOString(),
    })
    .where(inArray(schema.job.state, [...ACTIVE_JOB_STATES]))
    .returning({ id: schema.job.id, kind: schema.job.kind })
    .all()
  for (const row of recovered) {
    appLog({ module: jobLogModule(row.kind), source: 'task', operation: 'task.recovered', outcome: 'unknown', taskId: row.id, errorCode: 'job_interrupted' })
    appLog({ module: jobLogModule(row.kind), source: 'task', operation: 'task.finished', outcome: 'failure', taskId: row.id, errorCode: 'job_interrupted' })
  }
  return stuck
}

/** Checkpoint safe partial results without changing lifecycle. */
export function setJobResult(db: Db, id: string, result: unknown): void {
  db.update(schema.job).set({ result }).where(and(eq(schema.job.id, id), inArray(schema.job.state, [...ACTIVE_JOB_STATES]))).run()
}

/** Explicit bounded retry only: preserve checkpointed result, reopen a terminal job.
 * Normal runner transitions and startup reconciliation never auto-requeue jobs. */
export function reopenJob(db: Db, id: string, kind: string, params: Record<string, unknown>): JobRow | null {
  const changed = db.update(schema.job).set({ state: 'queued', params, error: null, startedAt: null, finishedAt: null })
    .where(and(eq(schema.job.id, id), eq(schema.job.kind, kind), inArray(schema.job.state, ['done', 'failed', 'cancelled'])))
    .run()
  return changed.changes ? getJob(db, id) : null
}
