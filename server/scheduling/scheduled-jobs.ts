import { Cron } from 'croner'
import { and, desc, eq, like, sql } from 'drizzle-orm'
import { job as pgJob } from '../../db/postgresql/job-tables'
import { job as sqliteJob } from '../../db/schema'
import { useDb } from '../../db'
import { getAppModules } from '../../lib/app-modules'
import { jobSchedules } from '../../lib/job-schedules'
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

async function lastScheduledRun(kind: string, postgres: ReturnType<typeof usePostgresJobsDb>) {
  if (postgres) {
    const [row] = await postgres.select({ id: pgJob.id, status: pgJob.state, createdAt: pgJob.createdAt, finishedAt: pgJob.finishedAt })
      .from(pgJob).where(and(eq(pgJob.kind, kind), like(pgJob.requestKey, 'schedule:%')))
      .orderBy(desc(pgJob.createdAt), desc(pgJob.id)).limit(1)
    return row
  }
  // Drizzle 0.45's SQLite builder lacks a JSON path extractor for the legacy request key.
  const requestKey = sql<string>`json_extract(${sqliteJob.params}, '$.clientRequestId')`
  return useDb().select({ id: sqliteJob.id, status: sqliteJob.state, createdAt: sqliteJob.createdAt, finishedAt: sqliteJob.finishedAt })
    .from(sqliteJob).where(and(eq(sqliteJob.kind, kind), like(requestKey, 'schedule:%')))
    .orderBy(desc(sqliteJob.createdAt), desc(sqliteJob.id)).limit(1).get()
}

export async function readScheduledJobs(now = new Date()) {
  const enabled = schedulingEnabled()
  const postgres = usePostgresJobsDb()
  const items = await Promise.all(jobSchedules(getAppModules()).map(async job => {
    const row = await lastScheduledRun(job.kind, postgres)
    return {
      id: job.kind, label: job.label, frequency: job.frequency,
      nextRunAt: enabled ? new Cron(job.cron, { paused: true }).nextRun(now)?.getTime() ?? null : null,
      lastRun: row ? { id: row.id, status: row.status, createdAt: Date.parse(row.createdAt),
        finishedAt: row.finishedAt ? Date.parse(row.finishedAt) : null } : null,
    }
  }))
  return { enabled, items }
}
