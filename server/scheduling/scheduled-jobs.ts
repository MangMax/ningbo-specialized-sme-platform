import { Cron } from 'croner'
import { sql } from 'drizzle-orm'
import { useDb } from '../../db'
import { getAppModules } from '../../lib/app-modules'
import { jobSchedules } from '../../lib/job-schedules'
import type { JobState } from '../../layers/core/lib/job'
import { ensureJobRunnerReady, getJobSpec, submitJob } from '../../layers/core/server/utils/job-runner'
import { postgresJobStorageEnabled, postgresJobsEnabled, startPostgresJobs, usePostgresJobsDb } from '../../layers/core/server/utils/postgres-jobs'

function schedulingEnabled() {
  return postgresJobStorageEnabled() ? postgresJobsEnabled() : process.env.NUXT_DB_READONLY !== '1'
}

export async function dispatchScheduledJob(kind: string, filesDir: string, now = new Date()) {
  if (!schedulingEnabled()) return { skipped: true }
  const schedule = jobSchedules(getAppModules()).find(job => job.kind === kind)
  const spec = getJobSpec(kind)
  if (!schedule || !spec) throw new Error(`定时任务未正确登记：${kind}`)
  // Croner's backwards search excludes the reference second, including an exact tick.
  const reference = new Date(Math.floor(now.getTime() / 1000) * 1000 + 1000)
  const [slot] = new Cron(schedule.cron, { paused: true }).previousRuns(1, reference)
  if (!slot) return { skipped: true }
  const parse = (postgresJobStorageEnabled() && spec.postgres?.parse) || spec.parse
  const parsed = parse({ clientRequestId: `schedule:${slot.toISOString()}` })
  if (!parsed.ok) throw new Error(parsed.message)
  const input = { kind, params: parsed.params, filesDir }
  const runtime = startPostgresJobs(filesDir)
  if (runtime) return { jobId: (await runtime.runner.submit(input)).id }
  const db = useDb()
  ensureJobRunnerReady(db)
  return { jobId: submitJob(db, input).id }
}

type LastRun = { id: string; status: JobState; created_at: string; finished_at: string | null }

export async function readScheduledJobs(now = new Date()) {
  const enabled = schedulingEnabled()
  const postgres = usePostgresJobsDb()
  const items = await Promise.all(jobSchedules(getAppModules()).map(async job => {
    const table = postgres ? sql`business.job` : sql`job`
    const requestKey = postgres ? sql`request_key` : sql`json_extract(params, '$.clientRequestId')`
    const query = sql`SELECT id, state AS status, created_at, finished_at FROM ${table}
      WHERE kind = ${job.kind} AND ${requestKey} LIKE 'schedule:%' ORDER BY created_at DESC, id DESC LIMIT 1`
    const row = postgres ? (await postgres.execute<LastRun>(query)).rows[0] : useDb().get<LastRun>(query)
    return {
      id: job.kind, label: job.label, frequency: job.frequency,
      nextRunAt: enabled ? new Cron(job.cron, { paused: true }).nextRun(now)?.getTime() ?? null : null,
      lastRun: row ? { id: row.id, status: row.status, createdAt: Date.parse(row.created_at),
        finishedAt: row.finished_at ? Date.parse(row.finished_at) : null } : null,
    }
  }))
  return { enabled, items }
}
