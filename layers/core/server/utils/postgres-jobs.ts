import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { usePostgresDirectoryDb } from '../../../../db/postgresql/client'
import { createPostgresJobRunner, type PostgresJobDb } from './job-runner-postgres'

export function jobsEnabled() {
  return process.env.NUXT_DB_READONLY !== '1'
}

export function requireJobsWritable() {
  if (!jobsEnabled()) {
    throw Object.assign(new Error('当前任务中心只读'), { statusCode: 403 })
  }
}

export function useJobsDb() {
  return usePostgresDirectoryDb()
}

let runtime: { db: PostgresJobDb; runner: ReturnType<typeof createPostgresJobRunner> } | undefined

export function runningJobRunner(db: NodePgDatabase) {
  return runtime && runtime.db === db ? runtime.runner : undefined
}

export function startJobs(filesDir: string) {
  if (!jobsEnabled()) return
  return startWritableJobRunner(filesDir)
}

function startWritableJobRunner(filesDir: string) {
  const db = useJobsDb()
  if (runtime?.db !== db) runtime = { db, runner: createPostgresJobRunner(db, filesDir) }
  runtime.runner.start()
  return runtime
}

export function submitWritableJob(filesDir: string, input: Parameters<ReturnType<typeof createPostgresJobRunner>['submit']>[0]) {
  requireJobsWritable()
  return startWritableJobRunner(filesDir).runner.submit(input)
}

export async function stopJobs() {
  const current = runtime
  try {
    await current?.runner.stop()
  } finally {
    if (current === runtime) runtime = undefined
  }
}
