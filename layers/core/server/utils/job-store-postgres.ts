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

type StoredJob = JobColumns & { params: string; result: string | null; error: string | null; claimToken: string | null }
type StoredJobSummary = JobColumns & { hasResult: boolean; hasError: boolean; exportWorkbook: boolean | null }

export interface PostgresJobSnapshot {
  row: JobRow
  claimToken: string | null
}

const commonColumns = sql`id, kind, state, progress, created_at AS "createdAt",
  started_at AS "startedAt", finished_at AS "finishedAt"`
const jobColumns = sql`${commonColumns}, params, result, error, claim_token AS "claimToken"`
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

function decodeJob({ claimToken, params, progress, result, ...columns }: StoredJob): PostgresJobSnapshot {
  return {
    claimToken,
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

export function getPostgresJob(db: Executor, id: string) {
  return readJob(db, sql`SELECT ${jobColumns} FROM business.job WHERE id = ${id}`)
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
}) {
  const progress = makeProgress(input.progress?.done ?? 0, input.progress?.total ?? 1)
  const { rows } = await db.execute<StoredJob>(sql`INSERT INTO business.job
    (id, kind, params, state, progress, created_at)
    VALUES (${input.id}, ${input.kind}, ${JSON.stringify(input.params)}, 'queued',
      ${JSON.stringify(progress)}, ${new Date().toISOString()})
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

export async function setPostgresJobProgress(
  db: Executor, id: string, expected: PostgresJobExpectation<ActiveState>, progress: JobProgress,
) {
  const normalized = progress.done === 0 && progress.total === 0 ? { done: 0, total: 0 } : makeProgress(progress.done, progress.total)
  const { rowCount } = await db.execute(sql`UPDATE business.job SET progress = ${JSON.stringify(normalized)}
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
) {
  return readJob(db, sql`UPDATE business.job
    SET state = 'queued', params = ${JSON.stringify(params)}, error = NULL, started_at = NULL, finished_at = NULL,
      claim_token = gen_random_uuid()
    WHERE ${compareJob(id, expected)} AND kind = ${kind} AND state IN ('done', 'failed', 'cancelled')
    RETURNING ${jobColumns}`)
}
