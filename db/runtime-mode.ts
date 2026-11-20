export function postgresOnlyRuntime(): boolean {
  return process.env.NUXT_DB_MODE === 'postgresql'
}

export function assertSqliteRuntime() {
  if (postgresOnlyRuntime()) {
    throw Object.assign(new Error('This operation requires a PostgreSQL migration'), {
      statusCode: 503,
      statusMessage: 'PostgreSQL migration required',
      data: { code: 'postgresql_migration_required' },
    })
  }
}

export function validateRuntimeMode() {
  const mode = process.env.NUXT_DB_MODE
  if (mode === 'sqlite' || (mode === undefined && process.env.NUXT_DB_PATH)) return
  if (mode !== 'postgresql') {
    throw new Error('Set NUXT_DB_MODE=postgresql, or explicitly select a legacy SQLite path')
  }
  const connection = process.env.NUXT_POSTGRES_DIRECTORY_URL
  if (!connection) throw new Error('PostgreSQL mode requires NUXT_POSTGRES_DIRECTORY_URL')
  for (const value of [connection, process.env.NUXT_POSTGRES_LOG_URL ?? connection]) {
    if (!URL.canParse(value) || !['postgresql:', 'postgres:'].includes(new URL(value).protocol)) {
      throw new Error('PostgreSQL mode requires valid PostgreSQL connection URLs')
    }
  }
}

/** Existing routes and subprocesses consume these switches independently. */
export function configurePostgresRuntime() {
  if (!postgresOnlyRuntime()) return
  const writable = process.env.NUXT_DB_READONLY === '1' ? '0' : '1'
  process.env.NUXT_POSTGRES_DIRECTORY_WRITE = writable
  process.env.NUXT_POSTGRES_JOBS = writable
  process.env.NUXT_POSTGRES_FILE_LIBRARY = '1'
  process.env.NUXT_POSTGRES_LEAD_REGISTRATION = '1'
  process.env.NUXT_POSTGRES_ROSTER_READ = '1'
  process.env.NUXT_POSTGRES_LOG_URL ??= process.env.NUXT_POSTGRES_DIRECTORY_URL!
}
