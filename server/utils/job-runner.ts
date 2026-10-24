import { appLog, type LogContext } from '../../lib/logging'
import { cleanupCurrentExports } from './current-export-artifact'
import { and, eq, sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../../db/schema'
import { isTerminalJobState, makeProgress, newJobId, type JobState } from '../../lib/job'
import {
  createJob,
  finishJob,
  getJob,
  markJobRunning,
  reconcileInterruptedJobs,
  reopenJob,
  setJobProgress,
  type JobRow,
} from './job-store'

type Db = BetterSQLite3Database<typeof schema>

/**
 * 异步任务的**执行面**:kind → handler 的注册表,加一条进程内队列。
 *
 * 见 `.scratch/ingest-pipeline/issues/19-openapi.md`。
 *
 * ── 为什么是「队列 + 轮询」而不是同步 ──────────────────────────────────────
 * 97 页 OCR、700+ 家平台核查这类活是**分钟到小时**级的。同步接口下一个请求要挂到
 * 天荒地老,代理也只能一次干等一件 —— 而代理要在技能里 `curl`,没有后台线程可用。
 * `POST` 立刻回 `202 + jobId`、之后 `GET /api/jobs/:id` 轮询,批量才跑得动。
 *
 * ── 并发语义───────────────────────────────────────────────────────────
 * OCR job 最多 4 个同时运行,让独立 PDF 任务能并行推进;OCR 页图请求另由共享信号量限制。
 * 非 OCR 任务仍保持先进先出、一次只跑一个,且不会和 OCR 任务交错运行:
 *  1. `submitJob` 只**入队**并立刻返回,HTTP 请求不等它;
 *  2. 非 OCR handler 不与任何其他 handler 并行,保护 `render-pages` 同文件页图清单与
 *     暂存文件的原子性;这些任务仍按 FIFO 串行;
 *  3. OCR handler 彼此最多同时 4 个,由 `ocrImageFile` 再统一限制最多 8 个未完成的
 *     Paddle 单页 job;多文件和多页展开后也不会无上限地打到远端。
 *  4. 单进程语义。多实例部署(两个 node 进程指向同一个 db 文件)不在本票范围内 ——
 *     那需要一把跨进程的锁,**不是**现在这个内存队列能保证的事,写在这里免得误以为能。
 *
 * ── 任务不跨重启续跑 ────────────────────────────────────────────────────
 * 队列在内存里,进程一没就没了。启动时 `ensureJobRunnerReady` 把上一个进程留下的
 * `queued` / `running` 一律标 `failed`(原因见 `job-store.ts` 的
 * `reconcileInterruptedJobs`)——**任务史保留,任务本身重开**。
 */

// ---------------------------------------------------------------------------
// kind → handler 的注册表
// ---------------------------------------------------------------------------

/**
 * handler 拿到的上下文。**`filesDir` 由这里传,handler 不自己去读 nitro 全局** ——
 * 这样 handler 是纯异步函数,能在测试里直接跑,不依赖请求上下文。
 */
export interface JobContext {
  readonly logContext?: Readonly<LogContext>
  readonly jobId: string
  /** 文件库根(绝对路径)。 */
  readonly filesDir: string
  /**
   * 已打开的库。
   *
   * 票 19 定 `filesDir` 由这里传、handler 不自己去读 nitro 全局 —— 同一个道理,库也传:
   * `ocr`(票 14)要把结果写进 `ocr_result`、还要按 `rel_path` 查到 `stored_file.id`,
   * 而 handler 里现写 `useDb()` 会让它**只能在请求上下文里跑**(单测起不来库)。
   * 传进来的库是同一个实例(`submitJob` 手上就有一份),没有第二套连接。
   */
  readonly db: Db
  /** 写进度(`done` / `total` 都是份数,不是百分比)。 */
  progress(done: number, total: number): void
  /**
   * 是否已被请求取消。批量任务在**每一份之前**问一次就够了 —— 这就是「尽力而为」的
   * 检查点。看到了就 `return { result, cancelled: true }` 收尾(见 `JobCompletion`)。
   *
   * 只有这一个取消出口(没有「抛出去」那种写法):抛出会让已经做完的那部分明细
   * 跟着异常一起丢,而调用方最想知道的恰恰是「停在哪、做完了哪些」。
   */
  cancelled(): boolean
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
   * 未接入的 kind)根本不走这个接口 —— 它们由 runner 直接 `finishJob`,而 `finishJob`
   * 对"没给 result"保留上一次的检查点(见 `job-store.ts`)。
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
  parse: (raw: Record<string, unknown>) => JobParseResult
  /** 提交时就能算出的**分母**(进度条的 total)。默认 1。 */
  total?: (params: Record<string, unknown>) => number
  /** Capture submission-time dependencies in a closure, retained only in the process queue.
   * Never put credentials in params, progress or the business database. */
  prepare?: (params: Record<string, unknown>, db: Db) => NonNullable<JobSpec['run']>
  run?: (ctx: JobContext, params: Record<string, unknown>) => Promise<JobCompletion>
}

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

// ---------------------------------------------------------------------------
// 队列
// ---------------------------------------------------------------------------

interface QueueEntry {
  logContext: Readonly<LogContext>
  run: NonNullable<JobSpec['run']>
  jobId: string
  kind: string
  db: Db
  filesDir: string
}

const queue: QueueEntry[] = []
const activeJobs = new Map<string, string>()
const activeLogContexts = new Map<string, Readonly<LogContext>>()
const MAX_CONCURRENT_OCR_JOBS = 4

/**
 * 已收到取消请求、但**正在跑**的任务 id。
 *
 * 取消不写库(`state` 仍留 `running`):写库的话,handler 正常跑完再写 `done` 就变成
 * 「先 cancelled 后 done」的回退,读的人会看到状态跳来跳去。这里用内存标记,
 * 由 runner 在检查点读 —— 也正是「尽力而为」的落点:marker 只有在 handler **去看**的时候
 * 才有效,已经陷在原生调用里的那一步不会被它打断。
 */
const cancelRequested = new Set<string>()

let dispatching = false
let idleWaiters: Array<() => void> = []

/** 队列清空且没有在跑的任务时 resolve(测试与验收用,业务代码不需要)。 */
export function whenIdle(): Promise<void> {
  if (activeJobs.size === 0 && queue.length === 0) return Promise.resolve()
  return new Promise((resolve) => idleWaiters.push(resolve))
}

function notifyIdle(): void {
  const waiters = idleWaiters
  idleWaiters = []
  for (const resolve of waiters) resolve()
}

/** 重置进程内状态(测试用)。库里的历史**不动**。 */
export function __resetJobRunner(): void {
  queue.length = 0
  cancelRequested.clear()
  dispatching = false
  notifyIdleIfReady()
}

// ---------------------------------------------------------------------------
// 提交
// ---------------------------------------------------------------------------

export interface SubmitInput {
  kind: string
  params: Record<string, unknown>
  /** 文件库根。由路由从 `runtimeConfig.filesDir` 传进来。 */
  filesDir: string
  /** 显式指定 id(测试用)。默认现生成一个 ULID。 */
  id?: string
  /** Captured IDs only; never persisted in job params or receipts. */
  logContext?: LogContext
}

/**
 * 建一条任务行并入队,**立刻返回**。
 *
 * 调用方(路由)必须**先**用 `getJobSpec` 判过 kind 与参数 —— 这里只做落库与排队,
 * 不做校验:校验的结果要变成 HTTP 状态码,那是路由的事。
 */
export function submitJob(db: Db, input: SubmitInput): JobRow {
  const spec = getJobSpec(input.kind)
  if (!spec) throw new Error(`任务种类未登记:${input.kind}`)
  if (spec.status !== 'ready' || !spec.run) throw new Error(`任务种类尚未接入:${input.kind}`)

  if (spec.deduplicateRequest) {
    const existing = db.select().from(schema.job).where(and(eq(schema.job.kind,input.kind),sql`json_extract(${schema.job.params}, '$.clientRequestId') = ${input.params.clientRequestId}`)).get()
    if (existing) {
      if (JSON.stringify(existing.params) !== JSON.stringify(input.params)) throw Object.assign(new Error('请求标识已用于不同参数'),{statusCode:409})
      return existing
    }
    if (input.params.regenerateOf) {
      const previous = getJob(db,String(input.params.regenerateOf))
      if (!previous || previous.kind !== input.kind || previous.params.titleCode !== input.params.titleCode || !isTerminalJobState(previous.state)) throw Object.assign(new Error('重新生成需要同称号已结束任务'),{statusCode:409})
    }
  }
  if (spec.maxPending) {
    const n = db.select({n:sql<number>`count(*)`}).from(schema.job).where(and(eq(schema.job.kind,input.kind),sql`${schema.job.state} in ('queued','running')`)).get()!.n
    if (n >= spec.maxPending) throw Object.assign(new Error('导出执行/排队容量已满，请稍后重试'),{statusCode:429})
  }
  const run = spec.prepare?.(input.params, db) ?? spec.run
  const total = spec.total?.(input.params) ?? 1
  const row = createJob(db, {
    id: input.id ?? newJobId(),
    kind: input.kind,
    params: input.params,
    progress: { done: 0, total },
    logContext: input.logContext,
  })

  queue.push({ run, jobId: row.id, kind: input.kind, db, filesDir: input.filesDir, logContext: Object.freeze({ ...input.logContext, taskId: row.id }) })
  drainQueue()
  return row
}

/** Explicit retry reuses the existing scheduler and ID; captures fresh dependencies
 * before reopening. Callers validate bounded retry policy before reaching this seam.
 *
 * 依赖捕获（`prepare`）抛错时**不重开**：重开就是丢掉旧终态与旧 `result`，
 * 而这一次执行连开始都没开始。调用方拿到异常（带它的 `statusCode`）后如实拒绝，
 * 已完成/部分结果原样留在任务里。 */
export function requeueFinishedJob(db: Db, input: { id: string; kind: string; params: Record<string, unknown>; filesDir: string; logContext?: LogContext }): boolean {
  const spec = getJobSpec(input.kind)
  if (!spec?.run) return false
  const run = spec.prepare?.(input.params, db) ?? spec.run
  const row = reopenJob(db, input.id, input.kind, input.params)
  if (!row) return false
  appLog({ source: 'task', operation: 'task.requeued', outcome: 'started', taskId: row.id }, input.logContext)
  queue.push({ run, jobId: row.id, kind: row.kind, db, filesDir: input.filesDir, logContext: Object.freeze({ ...input.logContext, taskId: row.id }) })
  drainQueue()
  return true
}

// ---------------------------------------------------------------------------
// 执行
// ---------------------------------------------------------------------------

/** 启动队首可运行的任务;OCR 并发槽和非 OCR 独占槽共用同一 FIFO 队列。 */
function drainQueue(): void {
  if (dispatching) return
  dispatching = true
  try {
    while (queue.length) {
      const next = queue[0]!
      const activeKinds = [...activeJobs.values()]
      const canRunAlongsideActiveOcr =
        next.kind === 'ocr' &&
        activeKinds.length > 0 &&
        activeKinds.every((kind) => kind === 'ocr') &&
        activeKinds.length < MAX_CONCURRENT_OCR_JOBS
      if (activeKinds.length > 0 && !canRunAlongsideActiveOcr) break

      const entry = queue.shift()!
      activeJobs.set(entry.jobId, entry.kind)
      activeLogContexts.set(entry.jobId, entry.logContext)
      void runOne(entry).finally(() => {
        activeJobs.delete(entry.jobId)
        activeLogContexts.delete(entry.jobId)
        notifyIdleIfReady()
        drainQueue()
      })
    }
  } finally {
    dispatching = false
    notifyIdleIfReady()
  }
}

function notifyIdleIfReady(): void {
  if (queue.length === 0 && activeJobs.size === 0) notifyIdle()
}

async function runOne(entry: QueueEntry): Promise<void> {
  const { db, jobId, filesDir, logContext } = entry
  try {
    // 入队后被取消:队列里已经没它了(取消时就地摘掉了),这里是兜底。
    if (cancelRequested.has(jobId)) {
      finishJob(db, jobId, { state: 'cancelled', error: '任务在开始前被取消' }, logContext)
      return
    }

    // 只有仍是 queued 才认领。对账标失败 / 被取消的行在这里被挡住,不会白跑。
    const running = markJobRunning(db, jobId, logContext)
    if (!running) return

    const spec = getJobSpec(running.kind)
    if (!spec?.run) {
      finishJob(db, jobId, { state: 'failed', error: `任务种类尚未接入:${running.kind}` }, logContext)
      return
    }

    let lastProgress = -Infinity
    const ctx: JobContext = {
      logContext,
      jobId,
      filesDir,
      db,
      progress: (done, total) => {
        setJobProgress(db, jobId, { done, total })
        if (performance.now() - lastProgress >= 1000) {
          lastProgress = performance.now()
          appLog({ source: 'task', operation: 'task.progress', outcome: 'started', taskId: jobId, counts: done === 0 && total === 0 ? { done, total } : makeProgress(done, total) }, logContext)
        }
      },
      cancelled: () => cancelRequested.has(jobId),
    }

    const completion = await entry.run(ctx, running.params)
    // 默认收尾把进度顶到分母;部分结果任务可显式提供真实完成数。
    // 被取消时不顶:停在 1/4 才是**它真实的进度**,顶成 4/4 就是在说谎。
    if (!completion.cancelled) {
      setJobProgress(db, jobId, completion.progress ?? { done: running.progress.total, total: running.progress.total })
    }
    finishJob(db, jobId, {
      state: completion.cancelled ? 'cancelled' : completion.error ? 'failed' : 'done',
      result: completion.result,
      error: completion.cancelled
        ? '已按取消请求停止(尽力而为:取消在任务的下一个检查点生效),已完成的部分见 result'
        : (completion.error ?? null),
    }, logContext)
  } catch (error) {
    // 抛出的执行没有新产出:保留已检查点的 result,只记失败原因(见 `finishJob`)。
    finishJob(db, jobId, { state: 'failed', error: messageOf(error) }, logContext)
  } finally {
    cancelRequested.delete(jobId)
  }
}

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  return String(error)
}

// ---------------------------------------------------------------------------
// 取消(尽力而为)
// ---------------------------------------------------------------------------

export type CancelOutcome =
  /** 还在排队:直接从队列摘掉并落库为 `cancelled`。 */
  | { ok: true; state: 'cancelled'; cancelled: true; note: string }
  /** 正在跑:打了取消标记,handler 在下一个检查点停。 */
  | { ok: true; state: 'running'; cancelled: false; cancelRequested: true; note: string }
  /** 已经结束了。 */
  | { ok: true; state: JobState; cancelled: false; alreadyFinished: true; note: string }
  | { ok: false; message: string }

/**
 * 请求取消。**尽力而为** —— 这个措辞是接口契约的一部分,会原样出现在响应的 `note` 里:
 *
 *  - **排队中**:真能立刻取消(从队列摘掉 + 落库 `cancelled`);
 *  - **运行中**:只能打标记。handler 在检查点(通常是「处理下一份文件之前」)看到标记
 *    才停得下来。已经进到 PDFium 渲染、sharp 编码或一次 HTTP 调用里的那一步**不会被
 *    打断** —— 它跑完,然后 handler 在下一个检查点停。所以一个「已取消」的任务,
 *    它的 `result` 里可能仍带着几份已经做完的产出,这是**正确**的行为,不是漏做。
 *  - **已结束**:取消不生效,如实回报当前状态。
 */
export function requestJobCancel(db: Db, id: string, logContext?: LogContext): CancelOutcome {
  const row = getJob(db, id)
  if (!row) return { ok: false, message: `任务不存在:${id}` }

  if (isTerminalJobState(row.state)) {
    return {
      ok: true,
      state: row.state,
      cancelled: false,
      alreadyFinished: true,
      note: `任务已结束(state=${row.state}),无法取消。`,
    }
  }

  if (row.state === 'queued') {
    // 就地摘掉,免得后台循环还把它捡起来。
    const at = queue.findIndex((e) => e.jobId === id)
    const submissionContext = at >= 0 ? queue[at]!.logContext : logContext
    if (at >= 0) queue.splice(at, 1)
    finishJob(db, id, { state: 'cancelled', error: '任务在开始前被取消,未执行' }, submissionContext)
    return { ok: true, state: 'cancelled', cancelled: true, note: '任务尚在排队,已取消,未执行。' }
  }

  if (!cancelRequested.has(id)) appLog({ source: 'task', operation: 'task.cancel_requested', outcome: 'started', taskId: id }, activeLogContexts.get(id) ?? logContext)
  cancelRequested.add(id)
  return {
    ok: true,
    state: 'running',
    cancelled: false,
    cancelRequested: true,
    note:
      '任务正在运行,已请求取消 —— **尽力而为**:handler 会在下一个检查点停止,' +
      '正在进行的单步(一次渲染 / 一次外部调用)会先跑完。稍后 GET 本任务看是否已变为 cancelled。',
  }
}

// ---------------------------------------------------------------------------
// 启动对账
// ---------------------------------------------------------------------------

/**
 * db 实例 → 是否已对过账。用 `WeakSet` 按**实例**记,而不是一个模块级布尔:
 * 测试里每个用例开一个新库,布尔会让第二个库永远跳过对账;WeakSet 天然随实例走。
 */
const reconciledDbs = new WeakSet<object>()

/**
 * 进程内**第一次**碰到任务库时,把上一个进程留下的半截任务标失败。
 * 返回本次标掉的条数(0 = 不需要或已经对过)。
 */
export function ensureJobRunnerReady(db: Db): number {
  if (reconciledDbs.has(db)) return 0
  reconciledDbs.add(db)
  const interrupted = reconcileInterruptedJobs(db)
  void cleanupCurrentExports(db).catch(() => {})
  return interrupted
}

/** Adopt a durable queued job created by the native import process. Admission
 * and parameters were validated when staged. Never reopen or duplicate work. */
export function enqueuePersistedJob(db: Db, id: string, filesDir: string, logContext?: LogContext): boolean {
  const row = getJob(db, id)
  if (!row || row.state !== 'queued') return false
  if (activeJobs.has(id) || queue.some(entry => entry.jobId === id)) return true
  const spec = getJobSpec(row.kind)
  if (!spec?.run) return false
  const run = spec.prepare?.(row.params, db) ?? spec.run
  queue.push({ run, jobId: id, kind: row.kind, db, filesDir, logContext: Object.freeze({ ...logContext, taskId: id }) })
  drainQueue()
  return true
}
