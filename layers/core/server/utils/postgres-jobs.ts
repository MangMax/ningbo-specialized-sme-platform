import { usePostgresDirectoryDb } from '../../../../db/postgresql/client'
import { createPostgresJobRunner, type PostgresJobDb } from './job-runner-postgres'

export function postgresJobsEnabled() {
  return process.env.NUXT_POSTGRES_JOBS === '1'
}

export function usePostgresJobsDb() {
  if (!postgresJobsEnabled()) return
  const db = usePostgresDirectoryDb()
  if (!db || process.env.NUXT_POSTGRES_DIRECTORY_WRITE !== '1') {
    throw Object.assign(new Error('PostgreSQL 任务中心需要可写的 PostgreSQL 业务连接'), { statusCode: 503 })
  }
  return db
}

let runtime: { db: PostgresJobDb; runner: ReturnType<typeof createPostgresJobRunner> } | undefined

/** The application starts this after registering job specs and supplying the files root. */
export function startPostgresJobs(filesDir: string) {
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
