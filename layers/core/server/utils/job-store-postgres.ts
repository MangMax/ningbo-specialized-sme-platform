import { appLog, type LogContext } from '../../lib/logging'
import { jobLogModule } from '../../lib/logging/module'
import { and, asc, count, desc, eq, getTableColumns, inArray, isNotNull, isNull, ne, not, or, sql, type SQL } from 'drizzle-orm'
import { job } from '../../../../db/postgresql/job-tables'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { isTerminalJobState, makeProgress, type JobProgress, type JobState } from '../../lib/job'
import { DEFAULT_JOB_LIMIT, MAX_JOB_LIMIT, progressPhaseMatch, toJobDto, toJobSummary, type JobQuery, type JobRow } from './job-store'

type Executor = Pick<NodePgDatabase, 'select' | 'insert' | 'update' | '$with' | 'with' | 'execute'>
type TerminalState = Extract<JobState, 'done' | 'failed' | 'cancelled'>
type ActiveState = Exclude<JobState, TerminalState>

interface PostgresJobExpectation<State extends JobState = JobState> {
  state: State
  claimToken: string | null
}

type JobColumns = Pick<JobRow, 'id' | 'kind' | 'state' | 'createdAt' | 'startedAt' | 'finishedAt'> & {
  progress: string
}

type StoredJob = JobColumns & { params: string; result: string | null; error: string | null; claimToken: string | null; inputSnapshot: string | null }
type StoredJobSummary = JobColumns & { hasResult: boolean; hasError: boolean; phaseAvailable: number | boolean | null }

export interface PostgresJobSnapshot {
  row: JobRow
  claimToken: string | null
  inputSnapshot: unknown
}

const { cancelRequested, requestKey, ...jobColumns } = getTableColumns(job)
const { id, kind, state, progress, createdAt, startedAt, finishedAt } = job
const commonColumns = { id, kind, state, progress, createdAt, startedAt, finishedAt }
const activeStates = ['queued', 'running'] as const
const terminalStates = ['done', 'failed', 'cancelled'] as const

export async function checkPostgresJobStorage(db: Executor) {
  await db.select({ ...jobColumns, cancelRequested, requestKey }).from(job).limit(0)
}

// PostgreSQL rejects escaped NULs and isolated surrogate code units when
// extracting JSON text. Replace those escapes only for this ASCII phase check.
const jsonTextEscapes = String.raw`\\u(?:0000|d[89a-f][0-9a-f]{2})`
const replacementEscape = String.raw`\\uFFFD`
const summaryColumns = () => ({
  ...commonColumns,
  hasResult: and(isNotNull(job.result), ne(job.result, 'null'))!.mapWith(Boolean),
  hasError: isNotNull(job.error).mapWith(Boolean),
  phaseAvailable: progressPhaseMatch(sql`regexp_replace(${job.result}, ${jsonTextEscapes}, ${replacementEscape}, 'gi')::json ->> 'phase'`),
})

function decodeJob({ claimToken, params, progress, result, inputSnapshot, ...columns }: StoredJob): PostgresJobSnapshot {
  return {
    claimToken,
    inputSnapshot: inputSnapshot === null ? null : JSON.parse(inputSnapshot),
    row: {
      ...columns,
      params: JSON.parse(params),
      progress: JSON.parse(progress),
      result: result === null ? null : JSON.parse(result),
    },
  }
}

function decodeSummary({ progress, ...columns }: StoredJobSummary) {
  return toJobSummary({ ...columns, progress: JSON.parse(progress) })
}

async function readJob(query: PromiseLike<StoredJob[]>) {
  const [row] = await query
  return row ? decodeJob(row) : null
}

export function getPostgresJob(db: Executor, id: string, lock = false) {
  const query = db.select(jobColumns).from(job).where(eq(job.id, id))
  return readJob(lock ? query.for('update') : query)
}

export async function getPostgresJobDetail(db: Executor, id: string) {
  const job = await getPostgresJob(db, id)
  return job ? toJobDto(job.row) : null
}

export async function getPostgresJobSummary(db: Executor, id: string) {
  const [row] = await db.select(summaryColumns()).from(job).where(eq(job.id, id))
  return row ? decodeSummary(row) : null
}

const taskCenterColumns = {
  ...commonColumns,
  hasError: isNotNull(job.error).mapWith(Boolean),
  restarted: sql<boolean>`coalesce(position('服务重启' in ${job.error}), 0) > 0`,
}
type StoredTaskCenterRow = JobColumns & { hasError: boolean; restarted: boolean }

function decodeTaskCenterRow({ progress, ...row }: StoredTaskCenterRow) {
  const { done, total } = JSON.parse(progress) as Partial<JobProgress> | null ?? {}
  return { ...row, done: done ?? 0, total: total ?? 0 }
}

export type PostgresTaskCenterRow = ReturnType<typeof decodeTaskCenterRow>

export async function getPostgresTaskCenterRow(db: Executor, id: string) {
  const [row] = await db.select(taskCenterColumns).from(job).where(eq(job.id, id))
  return row ? decodeTaskCenterRow(row) : null
}

async function listJobs<Row, Dto>(
  db: NodePgDatabase,
  query: JobQuery,
  readPage: (tx: Executor, where: SQL | undefined, limit: number) => PromiseLike<Row[]>,
  decode: (row: Row) => Dto,
) {
  const where = and(
    query.kind?.length ? inArray(job.kind, query.kind) : undefined,
    query.state?.length ? inArray(job.state, query.state) : undefined,
  )
  const limit = Math.min(MAX_JOB_LIMIT, Math.max(1, Math.floor(query.limit ?? DEFAULT_JOB_LIMIT)))
  return db.transaction(async tx => {
    const [countRow] = await tx.select({ total: count() }).from(job).where(where)
    const page = await readPage(tx, where, limit)
    return { rows: page.map(decode), total: countRow!.total }
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' })
}

const newestJobsFirst = [desc(job.createdAt), desc(job.id)] as const

export function listPostgresJobs(db: NodePgDatabase, query: JobQuery = {}) {
  return listJobs(db, query,
    (tx, where, limit) => tx.select(jobColumns).from(job).where(where).orderBy(...newestJobsFirst).limit(limit),
    row => toJobDto(decodeJob(row).row))
}

export function listPostgresJobSummaries(db: NodePgDatabase, query: JobQuery = {}) {
  return listJobs(db, query,
    (tx, where, limit) => tx.select(summaryColumns()).from(job).where(where).orderBy(...newestJobsFirst).limit(limit),
    decodeSummary)
}

function postgresTextRequestKey(key?: string) {
  return key?.isWellFormed() && !key.includes('\0') ? key : null
}

export async function createPostgresJob(db: Executor, input: {
  id: string
  kind: string
  params: Record<string, unknown>
  progress?: JobProgress
  requestKey?: string
  inputSnapshot?: unknown
}) {
  const progress = makeProgress(input.progress?.done ?? 0, input.progress?.total ?? 1)
  const [row] = await db.insert(job).values({
    id: input.id, kind: input.kind, params: JSON.stringify(input.params), state: 'queued',
    progress: JSON.stringify(progress), createdAt: new Date().toISOString(),
    requestKey: postgresTextRequestKey(input.requestKey), inputSnapshot: JSON.stringify(input.inputSnapshot ?? null),
  }).returning(jobColumns)
  return decodeJob(row!)
}

function compareJob(id: string, expected: PostgresJobExpectation) {
  return and(eq(job.id, id), eq(job.state, expected.state),
    sql`${job.claimToken} IS NOT DISTINCT FROM ${expected.claimToken}::uuid`)
}

function normalizeProgress(progress: JobProgress) {
  return progress.done === 0 && progress.total === 0 ? { done: 0, total: 0 } : makeProgress(progress.done, progress.total)
}

export async function setPostgresJobProgress(
  db: Executor, id: string, expected: PostgresJobExpectation<ActiveState>, progress: JobProgress,
) {
  const { rowCount } = await db.update(job).set({ progress: JSON.stringify(normalizeProgress(progress)) })
    .where(and(compareJob(id, expected), inArray(job.state, activeStates)))
  return rowCount === 1
}

export async function setPostgresJobResult(
  db: Executor, id: string, expected: PostgresJobExpectation<ActiveState>, result: unknown,
) {
  const { rowCount } = await db.update(job).set({ result: encodeResult(result) })
    .where(and(compareJob(id, expected), inArray(job.state, activeStates)))
  return rowCount === 1
}

function encodeResult(result: unknown) {
  const encoded = result === null ? null : JSON.stringify(result)
  if (encoded === undefined) throw new TypeError('Job result must be JSON-serializable')
  return encoded
}

export function reopenPostgresJob(
  db: Executor, id: string, kind: string, expected: PostgresJobExpectation<TerminalState>, params: Record<string, unknown>,
  inputSnapshot?: unknown,
) {
  return readJob(db.update(job).set({
    state: 'queued', cancelRequested: false, params: JSON.stringify(params), error: null, startedAt: null, finishedAt: null,
    claimToken: sql`gen_random_uuid()`,
    inputSnapshot: inputSnapshot === undefined ? undefined : JSON.stringify(inputSnapshot),
  }).where(and(compareJob(id, expected), eq(job.kind, kind), inArray(job.state, terminalStates))).returning(jobColumns))
}

export function claimNextPostgresJob(db: Executor, kinds: string[]) {
  if (!kinds.length) return Promise.resolve(null)
  const candidate = db.$with('candidate').as(db.select({ id: job.id }).from(job)
    .where(and(eq(job.state, 'queued'), isNotNull(job.claimToken), inArray(job.kind, kinds)))
    .orderBy(asc(job.createdAt), asc(job.id)).limit(1).for('update', { skipLocked: true }))
  return readJob(db.with(candidate).update(job).set({
    state: 'running', startedAt: new Date().toISOString(), claimToken: sql`gen_random_uuid()`,
  }).where(inArray(job.id, db.select({ id: candidate.id }).from(candidate))).returning(jobColumns))
}

const interrupted = '服务重启,任务未完成(进行中的任务不跨进程恢复,请重新提交)'
const cancelledBeforeStart = '任务在开始前被取消,未执行'
const cancelledWhileRunning = '已按取消请求停止(尽力而为:取消在任务的下一个检查点生效),已完成的部分见 result'

export function recoverPostgresJobs(db: Executor) {
  return db.update(job).set({ state: 'failed', error: interrupted, finishedAt: new Date().toISOString() })
    .where(or(eq(job.state, 'running'), and(eq(job.state, 'queued'), isNull(job.claimToken))))
    .returning({ id: job.id, kind: job.kind })
}

export async function postgresJobCancellationRequested(db: Executor, id: string, claimToken: string) {
  const [row] = await db.select({ requested: job.cancelRequested }).from(job)
    .where(compareJob(id, { state: 'running', claimToken }))
  return row?.requested ?? true
}

export async function cancelPostgresJob(db: NodePgDatabase, id: string, logContext?: LogContext) {
  const outcome = await db.transaction(async tx => {
    const [row] = await tx.select({ state: job.state, kind: job.kind }).from(job).where(eq(job.id, id)).for('update')
    if (!row) return null
    if (isTerminalJobState(row.state)) {
      return { ...row, updated: false, cancelled: false, cancelRequested: false, alreadyFinished: true, note: `任务已结束(state=${row.state}),无法取消。` }
    }
    if (row.state === 'running') {
      const { rowCount } = await tx.update(job).set({ cancelRequested: true }).where(and(eq(job.id, id), not(job.cancelRequested)))
      return { ...row, updated: rowCount === 1, cancelled: false, cancelRequested: true, alreadyFinished: false, note: '任务正在运行，已请求取消（尽力而为）。请查询最终状态。' }
    }
    await tx.update(job).set({ state: 'cancelled', error: cancelledBeforeStart, finishedAt: new Date().toISOString() })
      .where(eq(job.id, id))
    return { ...row, state: 'cancelled' as const, updated: true, cancelled: true, cancelRequested: false, alreadyFinished: false, note: '任务尚在排队,已取消,未执行。' }
  })
  if (!outcome) return null
  const { kind, updated, ...response } = outcome
  if (updated) appLog({
    module: jobLogModule(kind), source: 'task', taskId: id,
    operation: response.cancelled ? 'task.finished' : 'task.cancel_requested',
    outcome: response.cancelled ? 'cancelled' : 'started',
  }, logContext)
  return response
}

export function completePostgresJob(db: Executor, claimed: PostgresJobSnapshot, outcome: {
  state: TerminalState
  error?: string | null
  result?: unknown
  progress?: JobProgress
}) {
  const progress = outcome.progress && JSON.stringify(normalizeProgress(outcome.progress))
  return readJob(db.update(job).set({
    state: sql`CASE WHEN ${job.cancelRequested} THEN 'cancelled' ELSE ${outcome.state} END`,
    error: sql`CASE WHEN ${job.cancelRequested} OR ${outcome.state} = 'cancelled'
      THEN ${cancelledWhileRunning} ELSE ${outcome.error ?? null} END`,
    progress: sql`COALESCE(${progress ?? null}, CASE WHEN NOT ${job.cancelRequested} AND ${outcome.state} = 'done'
      THEN json_build_object('done', ${job.progress}::json -> 'total', 'total', ${job.progress}::json -> 'total')::text
      END, ${job.progress})`,
    finishedAt: new Date().toISOString(),
    result: outcome.result === undefined ? undefined : encodeResult(outcome.result),
  }).where(compareJob(claimed.row.id, { state: 'running', claimToken: claimed.claimToken })).returning(jobColumns))
}

export async function listPostgresTaskCenter(db: Executor, query: {
  kinds?: string[]
  filter?: SQL
  state?: JobState
  page: number
  pageSize: number
}) {
  const state = and(query.state ? eq(job.state, query.state) : undefined, query.filter)
  const kinds = query.kinds === undefined ? undefined : inArray(job.kind, query.kinds)
  const counts = await db.select({ kind: job.kind, n: count() }).from(job).where(state).groupBy(job.kind)
  const total = counts.reduce((sum, row) => sum + (!query.kinds || query.kinds.includes(row.kind) ? row.n : 0), 0)
  const rows = await db.select(taskCenterColumns).from(job).where(and(state, kinds))
    .orderBy(...newestJobsFirst).limit(query.pageSize).offset((query.page - 1) * query.pageSize)
  return { rows: rows.map(decodeTaskCenterRow), total, counts }
}

export async function lockPostgresJobAdmission(db: Executor, kind: string) {
  await db.execute(sql`SELECT pg_advisory_xact_lock(144815, hashtext(${kind}))`)
}

export function findPostgresJobRequest(db: Executor, kind: string, key: string) {
  return readJob(db.select(jobColumns).from(job).where(and(eq(job.kind, kind), or(
    eq(job.requestKey, postgresTextRequestKey(key) ?? sql`NULL`),
    and(isNull(job.requestKey), sql`(business.job_params_for_query(${job.params}) -> 'clientRequestId')::jsonb
      = business.job_params_for_query(${JSON.stringify(key)})::jsonb`),
  ))).orderBy(...newestJobsFirst).limit(1))
}

export async function countActivePostgresJobs(db: Executor, kind: string) {
  const [row] = await db.select({ total: count() }).from(job)
    .where(and(eq(job.kind, kind), inArray(job.state, activeStates)))
  return row!.total
}
