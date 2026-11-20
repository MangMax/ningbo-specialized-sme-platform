import { usePostgresDirectoryDb } from '../../../../db/postgresql/client'
import { postgresOnlyRuntime } from '../../../../db/runtime-mode'
import { createPostgresJobRunner, type PostgresJobDb } from './job-runner-postgres'

export function postgresJobsEnabled() {
  return process.env.NUXT_POSTGRES_JOBS === '1'
}

export function postgresJobStorageEnabled() {
  return postgresOnlyRuntime() || postgresJobsEnabled()
}

export function requirePostgresJobsWritable() {
  if (!postgresJobsEnabled()) {
    throw Object.assign(new Error('当前任务中心只读'), { statusCode: 403 })
  }
}

export function usePostgresJobsDb() {
  if (!postgresJobStorageEnabled()) return
  const db = usePostgresDirectoryDb()
  if (!db || (postgresJobsEnabled() && process.env.NUXT_POSTGRES_DIRECTORY_WRITE !== '1')) {
    throw Object.assign(new Error('PostgreSQL 任务中心的业务连接不可用'), { statusCode: 503 })
  }
  return db
}

let runtime: { db: PostgresJobDb; runner: ReturnType<typeof createPostgresJobRunner> } | undefined

/** The application starts this after registering job specs and supplying the files root. */
export function startPostgresJobs(filesDir: string) {
  if (!postgresJobsEnabled()) return
  const db = usePostgresJobsDb()
  if (!db) return
  if (runtime?.db !== db) runtime = { db, runner: createPostgresJobRunner(db, filesDir) }
  runtime.runner.start()
  return runtime
}

/** Call before closing the business pool. Active handlers may finish. */
export async function stopPostgresJobs() {
  const current = runtime
  try {
    await current?.runner.stop()
  } finally {
    if (current === runtime) runtime = undefined
  }
}
