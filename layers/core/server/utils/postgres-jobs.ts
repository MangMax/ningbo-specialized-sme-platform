import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { usePostgresDirectoryDb } from '../../../../db/postgresql/client'
import { createPostgresJobRunner, type PostgresJobDb } from './job-runner-postgres'

export function postgresJobsEnabled() {
  return process.env.NUXT_DB_READONLY !== '1'
}

export function requirePostgresJobsWritable() {
  if (!postgresJobsEnabled()) {
    throw Object.assign(new Error('当前任务中心只读'), { statusCode: 403 })
  }
}

export function usePostgresJobsDb() {
  return usePostgresDirectoryDb()
}

let runtime: { db: PostgresJobDb; runner: ReturnType<typeof createPostgresJobRunner> } | undefined

export function runningPostgresJobRunner(db: NodePgDatabase) {
  return runtime && runtime.db === db ? runtime.runner : undefined
}

export function startPostgresJobs(filesDir: string) {
  if (!postgresJobsEnabled()) return
  return startWritableJobRunner(filesDir)
}

function startWritableJobRunner(filesDir: string) {
  const db = usePostgresJobsDb()
  if (runtime?.db !== db) runtime = { db, runner: createPostgresJobRunner(db, filesDir) }
  runtime.runner.start()
  return runtime
}

export function submitWritablePostgresJob(filesDir: string, input: Parameters<ReturnType<typeof createPostgresJobRunner>['submit']>[0]) {
  requirePostgresJobsWritable()
  return startWritableJobRunner(filesDir).runner.submit(input)
}

export async function stopPostgresJobs() {
  const current = runtime
  try {
    await current?.runner.stop()
  } finally {
    if (current === runtime) runtime = undefined
  }
}
