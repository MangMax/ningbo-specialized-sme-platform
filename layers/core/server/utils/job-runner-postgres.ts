import { isDeepStrictEqual } from 'node:util'
import { sql } from 'drizzle-orm'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import type { Pool } from 'pg'
import { appLog, type LogContext } from '../../lib/logging'
import { jobLogModule } from '../../lib/logging/module'
import { makeProgress, newJobId } from '../../lib/job'
import { getJobSpec, jobSpecs } from './job-spec-registry'
import {
  claimNextPostgresJob, completePostgresJob, createPostgresJob, postgresJobCancellationRequested, recoverPostgresJobs,
  countActivePostgresJobs, findPostgresJobRequest, lockPostgresJobAdmission, queuedPostgresJobIds,
  setPostgresJobProgress, setPostgresJobResult, type PostgresJobSnapshot,
} from './job-store-postgres'
import type { JobCompletion, JobDto, JobParseResult } from './job-contract'
import type { TaskSummary, TaskSummaryProjection } from '../../lib/task-center'

export type PostgresJobDb = NodePgDatabase & { $client: Pool }
export type PostgresJobTransaction = Parameters<Parameters<NodePgDatabase['transaction']>[0]>[0]
interface SubmitPostgresJobInput {
  kind: string
  params: Record<string, unknown>
  id?: string
  /** Captured IDs only. They are never persisted in params or receipts. */
  logContext?: LogContext
}
type QueuedJob = { id: string; kind: string }
type TrackSubmissions<T> = (remember: (jobs: readonly QueuedJob[]) => void) => Promise<T>

export interface PostgresJobContext {
  readonly db: NodePgDatabase
  readonly jobId: string
  readonly filesDir: string
  readonly signal: AbortSignal
  readonly logContext: Readonly<LogContext>
  progress(done: number, total: number): Promise<void>
  checkpoint(result: unknown, transaction?: NodePgDatabase): Promise<void>
  cancelled(): Promise<boolean>
  trackSubmissions<T>(run: TrackSubmissions<T>): Promise<T>
}

export interface TaskSummaryAccess {
  authorized: boolean
  writable: boolean
}

export interface PostgresJobSpec {
  allowBrowserCancel?: boolean
  parse?: (raw: Record<string, unknown>) => JobParseResult
  validateSubmission?(tx: PostgresJobTransaction, params: Record<string, unknown>): Promise<void>
  projectResult?(db: NodePgDatabase, job: JobDto): Promise<unknown>
  taskCenter?: {
    summaries(db: NodePgDatabase, ids: string[], detail: boolean, access: TaskSummaryAccess): Promise<Map<string, TaskSummaryProjection>>
    retry?(db: NodePgDatabase, task: TaskSummary, context: LogContext): Promise<unknown>
  }
  prepare?(tx: PostgresJobTransaction, params: Record<string, unknown>): Promise<unknown>
  run(ctx: PostgresJobContext, params: Record<string, unknown>, inputSnapshot: unknown): Promise<JobCompletion>
}

export function postgresJobHandler(kind: string) {
  const spec = getJobSpec(kind)
  return spec?.status === 'ready' ? spec.postgres : undefined
}

function admissionError(statusCode: number, message: string) {
  return Object.assign(new Error(message), { statusCode })
}

/** Stage with the originating command's read-committed transaction. The runner
 * can only see the job after commit, and polls even without a local wakeup. */
export async function stagePostgresJob(tx: PostgresJobTransaction, input: SubmitPostgresJobInput) {
  const spec = getJobSpec(input.kind)
  const handler = postgresJobHandler(input.kind)
  if (!spec || !handler) throw admissionError(501, `任务种类尚未接入 PostgreSQL:${input.kind}`)
  const params = JSON.parse(JSON.stringify(input.params)) as Record<string, unknown>
  if (spec.deduplicateRequest || spec.maxPending) await lockPostgresJobAdmission(tx, input.kind)
  let requestKey: string | undefined
  if (spec.deduplicateRequest) {
    if (typeof params.clientRequestId !== 'string' || !params.clientRequestId.trim()) {
      throw admissionError(400, '任务需要有效的 clientRequestId')
    }
    requestKey = params.clientRequestId
    const existing = await findPostgresJobRequest(tx, input.kind, requestKey)
    if (existing) {
      if (!isDeepStrictEqual(existing.row.params, params)) throw admissionError(409, '请求标识已用于不同参数')
      return { row: existing.row, inserted: false }
    }
  }
  await handler.validateSubmission?.(tx, params)
  if (spec.maxPending && await countActivePostgresJobs(tx, input.kind) >= spec.maxPending) {
    throw admissionError(429, '导出执行/排队容量已满，请稍后重试')
  }
  const inputSnapshot = await handler.prepare?.(tx, params)
  const { row } = await createPostgresJob(tx, {
    id: input.id ?? newJobId(), kind: input.kind, params, requestKey, inputSnapshot,
    progress: { done: 0, total: spec.total?.(params) ?? 1 },
  })
  return { row, inserted: true }
}

const pollIntervalMs = 500
const schedulerLock = [144814, 1] as const

export function createPostgresJobRunner(db: PostgresJobDb, filesDir: string) {
  let inFlight: Promise<void> | undefined
  let timer: ReturnType<typeof setInterval> | undefined
  let stopping = false
  let admissionSequence = 0
  const admitted = new Map<string, { context: Readonly<LogContext>; committedAt?: number }>()

  async function runJob(connection: NodePgDatabase, job: PostgresJobSnapshot, signal: AbortSignal) {
    const { row, claimToken } = job
    if (!claimToken) throw new Error('缺少 PostgreSQL 任务领取令牌')
    const { id, kind, params } = row
    const admission = admitted.get(id)
    admitted.delete(id)
    const logContext = Object.freeze({ ...admission?.context, module: jobLogModule(kind), taskId: id })
    const expected = { state: 'running', claimToken } as const
    let lastProgress = -Infinity
    const ctx: PostgresJobContext = {
      db: connection, jobId: id, filesDir, signal, logContext,
      trackSubmissions: run => trackSubmission(run, logContext),
      async progress(done, total) {
        if (!await setPostgresJobProgress(connection, id, expected, { done, total })) throw new Error('任务领取已失效')
        if (performance.now() - lastProgress >= 1000) {
          lastProgress = performance.now()
          appLog({ source: 'task', operation: 'task.progress', outcome: 'started', taskId: id,
            counts: done === 0 && total === 0 ? { done, total } : makeProgress(done, total) }, logContext)
        }
      },
      async checkpoint(result, transaction = connection) {
        if (!await setPostgresJobResult(transaction, id, expected, result)) throw new Error('任务领取已失效')
      },
      async cancelled() { return signal.aborted || postgresJobCancellationRequested(connection, id, claimToken) },
    }

    appLog({ source: 'task', operation: 'task.started', outcome: 'started', taskId: id }, logContext)
    const finish = async (outcome: Parameters<typeof completePostgresJob>[2]) => {
      const finished = await completePostgresJob(connection, job, outcome)
      if (finished) appLog({
        source: 'task', operation: 'task.finished', taskId: id,
        outcome: finished.row.state === 'done' ? 'success' : finished.row.state === 'cancelled' ? 'cancelled' : 'failure',
        counts: finished.row.progress,
        errorCode: finished.row.state === 'failed' ? 'job_failed' : undefined,
      }, logContext)
    }
    try {
      const handler = postgresJobHandler(kind)
      if (!handler) throw new Error('任务种类尚未接入 PostgreSQL')
      const completion = await handler.run(ctx, params, job.inputSnapshot)
      if (completion.result === undefined) throw new TypeError('Job completion requires a result')
      await finish({
        state: completion.cancelled ? 'cancelled' : completion.error ? 'failed' : 'done',
        result: completion.result,
        error: completion.error,
        progress: completion.progress,
      })
    } catch (error) {
      if (signal.aborted) throw error
      await finish({ state: 'failed', error: '任务执行失败，请检查执行日志' })
    }
  }

  async function drain() {
    const client = await db.$client.connect()
    const connection = drizzle({ client })
    const abort = new AbortController()
    const onError = (error: Error) => abort.abort(error)
    client.on('error', onError)
    let locked = false
    let discard = false
    try {
      // Both lock calls and all work use the same pinned PostgreSQL session.
      const acquired = await connection.execute<{ locked: boolean }>(sql`
        SELECT pg_try_advisory_lock(${schedulerLock[0]}, ${schedulerLock[1]}) AS locked`)
      locked = acquired.rows[0]!.locked
      if (!locked) return
      for (const row of await recoverPostgresJobs(connection)) {
        appLog({ module: jobLogModule(row.kind), source: 'task', operation: 'task.recovered', outcome: 'failure', taskId: row.id, errorCode: 'job_interrupted' })
      }
      while (!stopping && !abort.signal.aborted) {
        const kinds = jobSpecs().filter(spec => postgresJobHandler(spec.kind)).map(spec => spec.kind)
        const visibleAdmissions = admissionSequence
        const job = await claimNextPostgresJob(connection, kinds)
        if (!job) {
          // SKIP LOCKED can miss a queued row. A snapshot read distinguishes
          // those rows from jobs cancelled or already handled by another instance.
          const visibleIds = [...admitted].filter(([, entry]) =>
            entry.committedAt !== undefined && entry.committedAt <= visibleAdmissions).map(([id]) => id)
          const queued = await queuedPostgresJobIds(connection, visibleIds)
          for (const id of visibleIds) if (!queued.has(id)) admitted.delete(id)
          return
        }
        await runJob(connection, job, abort.signal)
      }
    } finally {
      if (locked && !abort.signal.aborted) {
        try {
          await connection.execute(sql`SELECT pg_advisory_unlock(${schedulerLock[0]}, ${schedulerLock[1]})`)
        } catch {
          discard = true
        }
      }
      client.removeListener('error', onError)
      client.release(discard || abort.signal.aborted)
    }
  }

  function wake() {
    if (stopping) return Promise.resolve()
    if (!inFlight) {
      inFlight = drain().finally(() => { inFlight = undefined })
    }
    return inFlight
  }

  function nudge() {
    if (inFlight || stopping) return
    void wake().catch(() => {
      appLog({ source: 'task', operation: 'task.scheduler', outcome: 'failure', errorCode: 'job_scheduler_failed' })
    })
  }

  async function trackSubmission<T>(run: TrackSubmissions<T>, context?: LogContext) {
    let queued: readonly QueuedJob[] = []
    const forget = () => { for (const { id } of queued) admitted.delete(id) }
    try {
      const receipt = await run(jobs => {
        forget()
        queued = jobs
        // Register before commit so a local poll cannot claim first. A retry
        // clears the rolled-back admissions before recording new jobs.
        if (context) for (const { id } of jobs) admitted.set(id, { context: Object.freeze({ ...context }) })
      })
      for (const { id, kind } of queued) {
        const admission = admitted.get(id)
        if (admission) admission.committedAt = ++admissionSequence
        appLog({ module: jobLogModule(kind), source: 'task', operation: 'task.queued', outcome: 'started', taskId: id }, context)
      }
      nudge()
      return receipt
    } catch (error) {
      forget()
      throw error
    }
  }

  return {
    start() {
      if (!timer && !stopping) {
        timer = setInterval(nudge, pollIntervalMs)
        timer.unref()
        nudge()
      }
    },
    wake,
    async stop() {
      stopping = true
      clearInterval(timer)
      try { await inFlight }
      finally { admitted.clear() }
    },
    trackSubmission,
    async submit(input: SubmitPostgresJobInput) {
      return trackSubmission(remember => db.transaction(async tx => {
        const { row, inserted } = await stagePostgresJob(tx, input)
        if (inserted) remember([row])
        return row
      }), input.logContext)
    },
  }
}
