import { appLog, type LogContext } from '../../lib/logging'
import { jobLogModule } from '../../lib/logging/module'
import { sql, type SQL } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { isTerminalJobState, makeProgress, type JobProgress, type JobState } from '../../lib/job'
import { DEFAULT_JOB_LIMIT, MAX_JOB_LIMIT, toJobDto, toJobSummary, type JobQuery, type JobRow } from './job-store'

type Executor = Pick<NodePgDatabase, 'execute'>
type TerminalState = Extract<JobState, 'done' | 'failed' | 'cancelled'>
type ActiveState = Exclude<JobState, TerminalState>

export interface PostgresJobExpectation<State extends JobState = JobState> {
  state: State
  claimToken: string | null
}

type JobColumns = Pick<JobRow, 'id' | 'kind' | 'state' | 'createdAt' | 'startedAt' | 'finishedAt'> & {
  progress: string
}

type StoredJob = JobColumns & { params: string; result: string | null; error: string | null; claimToken: string | null; inputSnapshot: string | null }
type StoredJobSummary = JobColumns & { hasResult: boolean; hasError: boolean; exportWorkbook: boolean | null }

export interface PostgresJobSnapshot {
  row: JobRow
  claimToken: string | null
  inputSnapshot: unknown
}

const commonColumns = sql`id, kind, state, progress, created_at AS "createdAt",
  started_at AS "startedAt", finished_at AS "finishedAt"`
const jobColumns = sql`${commonColumns}, params, result, error, claim_token AS "claimToken", input_snapshot AS "inputSnapshot"`
// PostgreSQL rejects escaped NULs and isolated surrogate code units when
// extracting JSON text. Replace those escapes only for this ASCII phase check.
const jsonTextEscapes = String.raw`\\u(?:0000|d[89a-f][0-9a-f]{2})`
const replacementEscape = String.raw`\\uFFFD`
const summaryColumns = sql`${commonColumns},
  result IS NOT NULL AND result <> 'null' AS "hasResult",
  error IS NOT NULL AS "hasError",
  CASE WHEN kind = 'current-roster-export' AND state = 'running'
    THEN regexp_replace(result, ${jsonTextEscapes}, ${replacementEscape}, 'gi')::json ->> 'phase' = 'workbook'
    ELSE false END AS "exportWorkbook"`

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

async function readJob(db: Executor, query: SQL) {
  const { rows } = await db.execute<StoredJob>(query)
  return rows[0] ? decodeJob(rows[0]) : null
}

export function getPostgresJob(db: Executor, id: string, lock = false) {
  return readJob(db, sql`SELECT ${jobColumns} FROM business.job WHERE id = ${id} ${lock ? sql`FOR UPDATE` : sql.empty()}`)
}

export async function getPostgresJobDetail(db: Executor, id: string) {
  const job = await getPostgresJob(db, id)
  return job ? toJobDto(job.row) : null
}

export async function getPostgresJobSummary(db: Executor, id: string) {
  const { rows } = await db.execute<StoredJobSummary>(sql`SELECT ${summaryColumns} FROM business.job WHERE id = ${id}`)
  return rows[0] ? decodeSummary(rows[0]) : null
}

async function listJobs<Stored extends Record<string, unknown>, Dto>(
  db: NodePgDatabase,
  query: JobQuery,
  columns: SQL,
  decode: (row: Stored) => Dto,
) {
  const conditions: SQL[] = []
  if (query.kind?.length) conditions.push(sql`kind IN (${sql.join(query.kind.map(kind => sql`${kind}`), sql`, `)})`)
  if (query.state?.length) conditions.push(sql`state IN (${sql.join(query.state.map(state => sql`${state}`), sql`, `)})`)
  const where = conditions.length ? sql`WHERE ${sql.join(conditions, sql` AND `)}` : sql``
  const limit = Math.min(MAX_JOB_LIMIT, Math.max(1, Math.floor(query.limit ?? DEFAULT_JOB_LIMIT)))
  return db.transaction(async tx => {
    const count = await tx.execute<{ n: string }>(sql`SELECT count(*) AS n FROM business.job ${where}`)
    const page = await tx.execute<Stored>(sql`SELECT ${columns} FROM business.job ${where}
      ORDER BY created_at DESC, id DESC LIMIT ${limit}`)
    return { rows: (page.rows as Stored[]).map(decode), total: Number(count.rows[0]!.n) }
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' })
}

export function listPostgresJobs(db: NodePgDatabase, query: JobQuery = {}) {
  return listJobs(db, query, jobColumns, (row: StoredJob) => toJobDto(decodeJob(row).row))
}

export function listPostgresJobSummaries(db: NodePgDatabase, query: JobQuery = {}) {
  return listJobs(db, query, summaryColumns, decodeSummary)
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
  const { rows } = await db.execute<StoredJob>(sql`INSERT INTO business.job
    (id, kind, params, state, progress, created_at, request_key, input_snapshot)
    VALUES (${input.id}, ${input.kind}, ${JSON.stringify(input.params)}, 'queued',
      ${JSON.stringify(progress)}, ${new Date().toISOString()}, ${input.requestKey ?? null}, ${JSON.stringify(input.inputSnapshot ?? null)})
    RETURNING ${jobColumns}`)
  return decodeJob(rows[0]!)
}

export function claimPostgresJob(db: Executor, id: string) {
  return readJob(db, sql`UPDATE business.job
    SET state = 'running', started_at = ${new Date().toISOString()}, claim_token = gen_random_uuid()
    WHERE id = ${id} AND state = 'queued'
    RETURNING ${jobColumns}`)
}

function compareJob(id: string, expected: PostgresJobExpectation) {
  return sql`id = ${id} AND state = ${expected.state}
    AND claim_token IS NOT DISTINCT FROM ${expected.claimToken}::uuid`
}

function normalizeProgress(progress: JobProgress) {
  return progress.done === 0 && progress.total === 0 ? { done: 0, total: 0 } : makeProgress(progress.done, progress.total)
}

export async function setPostgresJobProgress(
  db: Executor, id: string, expected: PostgresJobExpectation<ActiveState>, progress: JobProgress,
) {
  const { rowCount } = await db.execute(sql`UPDATE business.job SET progress = ${JSON.stringify(normalizeProgress(progress))}
    WHERE ${compareJob(id, expected)} AND state IN ('queued', 'running')`)
  return rowCount === 1
}

export async function setPostgresJobResult(
  db: Executor, id: string, expected: PostgresJobExpectation<ActiveState>, result: unknown,
) {
  const { rowCount } = await db.execute(sql`UPDATE business.job SET result = ${encodeResult(result)}
    WHERE ${compareJob(id, expected)} AND state IN ('queued', 'running')`)
  return rowCount === 1
}

function encodeResult(result: unknown) {
  const encoded = result === null ? null : JSON.stringify(result)
  if (encoded === undefined) throw new TypeError('Job result must be JSON-serializable')
  return encoded
}

export function finishPostgresJob(db: Executor, id: string, expected: PostgresJobExpectation<ActiveState>, outcome: {
  state: TerminalState
  result?: unknown
  error?: string | null
}) {
  if (!isTerminalJobState(outcome.state) || expected.state === 'queued' && outcome.state === 'done') return Promise.resolve(null)
  const result = outcome.result === undefined ? sql`` : sql`, result = ${encodeResult(outcome.result)}`
  return readJob(db, sql`UPDATE business.job
    SET state = ${outcome.state}, error = ${outcome.error ?? null}, finished_at = ${new Date().toISOString()}${result}
    WHERE ${compareJob(id, expected)} AND state IN ('queued', 'running')
    RETURNING ${jobColumns}`)
}

/** Keep the prior checkpoint when reopening a job. */
export function reopenPostgresJob(
  db: Executor, id: string, kind: string, expected: PostgresJobExpectation<TerminalState>, params: Record<string, unknown>,
  inputSnapshot?: unknown,
) {
  const snapshot = inputSnapshot === undefined ? sql.empty() : sql`, input_snapshot = ${JSON.stringify(inputSnapshot)}`
  return readJob(db, sql`UPDATE business.job
    SET state = 'queued', cancel_requested = false, params = ${JSON.stringify(params)}, error = NULL, started_at = NULL, finished_at = NULL,
      claim_token = gen_random_uuid()${snapshot}
    WHERE ${compareJob(id, expected)} AND kind = ${kind} AND state IN ('done', 'failed', 'cancelled')
    RETURNING ${jobColumns}`)
}

/** Claim the oldest runnable row, skipping rows locked by another transaction. */
export function claimNextPostgresJob(db: Executor, kinds: string[]) {
  if (!kinds.length) return Promise.resolve(null)
  return readJob(db, sql`WITH candidate AS (
    SELECT id FROM business.job
    WHERE state = 'queued' AND claim_token IS NOT NULL
      AND kind IN (${sql.join(kinds.map(kind => sql`${kind}`), sql`, `)})
    ORDER BY created_at, id LIMIT 1 FOR UPDATE SKIP LOCKED
  )
  UPDATE business.job SET state = 'running', started_at = ${new Date().toISOString()}, claim_token = gen_random_uuid()
  WHERE id = (SELECT id FROM candidate) RETURNING ${jobColumns}`)
}

const interrupted = '服务重启,任务未完成(进行中的任务不跨进程恢复,请重新提交)'
const cancelledBeforeStart = '任务在开始前被取消,未执行'
const cancelledWhileRunning = '已按取消请求停止(尽力而为:取消在任务的下一个检查点生效),已完成的部分见 result'

/** Requires exclusive scheduler ownership. Queued PostgreSQL submissions are durable. */
export async function recoverPostgresJobs(db: Executor) {
  const { rows } = await db.execute<{ id: string; kind: string }>(sql`UPDATE business.job
    SET state = 'failed', error = ${interrupted}, finished_at = ${new Date().toISOString()}
    WHERE state = 'running' OR (state = 'queued' AND claim_token IS NULL)
    RETURNING id, kind`)
  return rows
}

export async function postgresJobCancellationRequested(db: Executor, id: string, claimToken: string) {
  const { rows } = await db.execute<{ requested: boolean }>(sql`SELECT cancel_requested AS requested FROM business.job
    WHERE ${compareJob(id, { state: 'running', claimToken })}`)
  return rows[0]?.requested ?? true
}

/** Serialize the cancellation decision with claim and completion. */
export async function cancelPostgresJob(db: NodePgDatabase, id: string, logContext?: LogContext) {
  const outcome = await db.transaction(async tx => {
    const { rows } = await tx.execute<{ state: JobState; kind: string }>(sql`SELECT state, kind FROM business.job WHERE id = ${id} FOR UPDATE`)
    const row = rows[0]
    if (!row) return null
    if (isTerminalJobState(row.state)) {
      return { ...row, updated: false, cancelled: false, cancelRequested: false, alreadyFinished: true, note: `任务已结束(state=${row.state}),无法取消。` }
    }
    if (row.state === 'running') {
      const { rowCount } = await tx.execute(sql`UPDATE business.job SET cancel_requested = true WHERE id = ${id} AND NOT cancel_requested`)
      return { ...row, updated: rowCount === 1, cancelled: false, cancelRequested: true, alreadyFinished: false, note: '任务正在运行，已请求取消（尽力而为）。请查询最终状态。' }
    }
    await tx.execute(sql`UPDATE business.job
      SET state = 'cancelled', error = ${cancelledBeforeStart}, finished_at = ${new Date().toISOString()} WHERE id = ${id}`)
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

/** Atomically publish the result, progress and terminal state for this claim. */
export function completePostgresJob(db: Executor, job: PostgresJobSnapshot, outcome: {
  state: TerminalState
  error?: string | null
  result?: unknown
  progress?: JobProgress
}) {
  const progress = outcome.progress && JSON.stringify(normalizeProgress(outcome.progress))
  const result = outcome.result === undefined ? sql`` : sql`, result = ${encodeResult(outcome.result)}`
  return readJob(db, sql`UPDATE business.job SET
    state = CASE WHEN cancel_requested THEN 'cancelled' ELSE ${outcome.state} END,
    error = CASE WHEN cancel_requested OR ${outcome.state} = 'cancelled' THEN ${cancelledWhileRunning} ELSE ${outcome.error ?? null} END,
    progress = COALESCE(${progress ?? null}, CASE WHEN NOT cancel_requested AND ${outcome.state} = 'done'
      THEN json_build_object('done', progress::json -> 'total', 'total', progress::json -> 'total')::text END, progress),
    finished_at = ${new Date().toISOString()}${result}
    WHERE ${compareJob(job.row.id, { state: 'running', claimToken: job.claimToken })}
    RETURNING ${jobColumns}`)
}

export async function listPostgresTaskCenter(db: Executor, query: {
  kinds?: string[]
  titleCode?: string
  state?: JobState
  page: number
  pageSize: number
}) {
  const state = sql`(${query.state ? sql`state = ${query.state}` : sql`true`})
    ${query.titleCode === undefined ? sql.empty() : sql`AND kind = 'current-roster-export'
      AND params::json ->> 'titleCode' = ${query.titleCode}`}`
  const kinds = query.kinds?.length
    ? sql`kind IN (${sql.join(query.kinds.map(kind => sql`${kind}`), sql`, `)})`
    : sql`${query.kinds === undefined}`
  const { rows: counts } = await db.execute<{ kind: string; n: string }>(sql`
      SELECT kind, count(*) AS n FROM business.job WHERE ${state} GROUP BY kind`)
  const total = counts.reduce((sum, row) => sum + (!query.kinds || query.kinds.includes(row.kind) ? Number(row.n) : 0), 0)
  const { rows } = await db.execute<StoredJobSummary>(sql`SELECT ${summaryColumns} FROM business.job
      WHERE ${state} AND ${kinds} ORDER BY created_at DESC, id DESC
      LIMIT ${query.pageSize} OFFSET ${(query.page - 1) * query.pageSize}`)
  return { rows: rows.map(decodeSummary), total, counts }
}

export async function lockPostgresJobAdmission(db: Executor, kind: string) {
  await db.execute(sql`SELECT pg_advisory_xact_lock(144815, hashtext(${kind}))`)
}

export function findPostgresJobRequest(db: Executor, kind: string, key: string) {
  // Older receipts keep their original params bytes and did not have request_key.
  return readJob(db, sql`SELECT ${jobColumns} FROM business.job WHERE kind = ${kind} AND
    (request_key = ${key} OR (request_key IS NULL AND
      (CASE WHEN pg_input_is_valid(params, 'jsonb') THEN params::jsonb ->> 'clientRequestId'
       ELSE regexp_replace(params, ${jsonTextEscapes}, ${replacementEscape}, 'gi')::json ->> 'clientRequestId' END) = ${key}))
    ORDER BY created_at DESC, id DESC LIMIT 1`)
}

export async function countActivePostgresJobs(db: Executor, kind: string) {
  const { rows } = await db.execute<{ n: string }>(sql`SELECT count(*) AS n FROM business.job
    WHERE kind = ${kind} AND state IN ('queued', 'running')`)
  return Number(rows[0]!.n)
}
