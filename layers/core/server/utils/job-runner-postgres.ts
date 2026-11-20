import { isDeepStrictEqual } from 'node:util'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import type { Pool } from 'pg'
import { appLog, type LogContext } from '../../lib/logging'
import { jobLogModule } from '../../lib/logging/module'
import { isTerminalJobState, makeProgress, newJobId } from '../../lib/job'
import { getJobSpec, jobSpecs, type JobCompletion, type JobSpec, type SubmitInput } from './job-runner'
import {
  claimNextPostgresJob, completePostgresJob, createPostgresJob, postgresJobCancellationRequested, recoverPostgresJobs,
  countActivePostgresJobs, findPostgresJobRequest, getPostgresJob, lockPostgresJobAdmission,
  setPostgresJobProgress, setPostgresJobResult, type PostgresJobSnapshot,
} from './job-store-postgres'
import type { JobDto } from './job-store'

export type PostgresJobDb = NodePgDatabase & { $client: Pool }
export type PostgresJobTransaction = Parameters<Parameters<NodePgDatabase['transaction']>[0]>[0]
export type SubmitPostgresJobInput = Omit<SubmitInput, 'filesDir'>

export interface PostgresJobContext {
  /** The execution connection. Await all its work before returning. */
  readonly db: NodePgDatabase
  readonly jobId: string
  readonly filesDir: string
  readonly signal: AbortSignal
  readonly logContext: Readonly<LogContext>
  progress(done: number, total: number): Promise<void>
  checkpoint(result: unknown): Promise<void>
  cancelled(): Promise<boolean>
}

export interface PostgresJobSpec {
  allowBrowserCancel?: boolean
  parse?: JobSpec['parse']
  /** E.g. refresh a download receipt against the module’s current artifact state. */
  projectResult?(db: NodePgDatabase, job: JobDto): Promise<unknown>
  validateSubmission?(tx: PostgresJobTransaction, params: Record<string, unknown>): Promise<void>
  /** Resolve dependencies when claimed. Persist only non-secret, replayable parameters. */
  run(ctx: PostgresJobContext, params: Record<string, unknown>): Promise<JobCompletion>
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
    if (typeof params.clientRequestId !== 'string' || !params.clientRequestId.trim() || params.clientRequestId.includes('\0')) {
      throw admissionError(400, '任务需要有效的 clientRequestId')
    }
    requestKey = params.clientRequestId
    const existing = await findPostgresJobRequest(tx, input.kind, requestKey)
    if (existing) {
      if (!isDeepStrictEqual(existing.row.params, params)) throw admissionError(409, '请求标识已用于不同参数')
      return { row: existing.row, inserted: false }
    }
    if (params.regenerateOf) {
      const previous = await getPostgresJob(tx, String(params.regenerateOf))
      if (!previous || previous.row.kind !== input.kind || previous.row.params.titleCode !== params.titleCode || !isTerminalJobState(previous.row.state)) {
        throw admissionError(409, '重新生成需要同称号已结束任务')
      }
    }
  }
  if (spec.maxPending && await countActivePostgresJobs(tx, input.kind) >= spec.maxPending) {
    throw admissionError(429, '导出执行/排队容量已满，请稍后重试')
  }
  await handler.validateSubmission?.(tx, params)
  const { row } = await createPostgresJob(tx, {
    id: input.id ?? newJobId(), kind: input.kind, params, requestKey,
    progress: { done: 0, total: spec.total?.(params) ?? 1 },
  })
  return { row, inserted: true }
}

const pollIntervalMs = 500
// A dedicated session owns execution across instances. No transaction spans
// handler I/O. Row locks still serialize claims, cancellations and completion.
const schedulerLock = [144814, 1]

export function createPostgresJobRunner(db: PostgresJobDb, filesDir: string) {
  let inFlight: Promise<void> | undefined
  let timer: ReturnType<typeof setInterval> | undefined
  let stopping = false

  async function runJob(connection: NodePgDatabase, job: PostgresJobSnapshot, signal: AbortSignal) {
    const { row, claimToken } = job
    if (!claimToken) throw new Error('缺少 PostgreSQL 任务领取令牌')
    const { id, kind, params } = row
    const logContext = Object.freeze({ module: jobLogModule(kind), taskId: id })
    const expected = { state: 'running', claimToken } as const
    let lastProgress = -Infinity
    const ctx: PostgresJobContext = {
      db: connection, jobId: id, filesDir, signal, logContext,
      async progress(done, total) {
        if (!await setPostgresJobProgress(connection, id, expected, { done, total })) throw new Error('任务领取已失效')
        if (performance.now() - lastProgress >= 1000) {
          lastProgress = performance.now()
          appLog({ source: 'task', operation: 'task.progress', outcome: 'started', taskId: id,
            counts: done === 0 && total === 0 ? { done, total } : makeProgress(done, total) }, logContext)
        }
      },
      async checkpoint(result) {
        if (!await setPostgresJobResult(connection, id, expected, result)) throw new Error('任务领取已失效')
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
      const completion = await handler.run(ctx, params)
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
    const abort = new AbortController()
    const onError = (error: Error) => abort.abort(error)
    client.on('error', onError)
    let locked = false
    let discard = false
    try {
      const acquired = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1, $2) AS locked', schedulerLock)
      locked = acquired.rows[0]!.locked
      if (!locked) return
      const connection = drizzle({ client })
      for (const row of await recoverPostgresJobs(connection)) {
        appLog({ module: jobLogModule(row.kind), source: 'task', operation: 'task.recovered', outcome: 'failure', taskId: row.id, errorCode: 'job_interrupted' })
      }
      while (!stopping && !abort.signal.aborted) {
        const kinds = jobSpecs().filter(spec => postgresJobHandler(spec.kind)).map(spec => spec.kind)
        const job = await claimNextPostgresJob(connection, kinds)
        if (!job) return
        await runJob(connection, job, abort.signal)
      }
    } finally {
      if (locked && !abort.signal.aborted) {
        try {
          await client.query('SELECT pg_advisory_unlock($1, $2)', schedulerLock)
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
      await inFlight
    },
    async submit(input: SubmitPostgresJobInput) {
      const { row, inserted } = await db.transaction(tx => stagePostgresJob(tx, input))
      if (inserted) appLog({ module: jobLogModule(row.kind), source: 'task', operation: 'task.queued', outcome: 'started', taskId: row.id }, input.logContext)
      nudge()
      return row
    },
  }
}
