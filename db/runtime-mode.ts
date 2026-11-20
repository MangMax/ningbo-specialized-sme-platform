import pg from 'pg'

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
  if (mode === 'sqlite' || mode === undefined) return
  if (mode !== 'postgresql') {
    throw new Error('NUXT_DB_MODE must be postgresql or sqlite')
  }
  const connection = process.env.NUXT_POSTGRES_DIRECTORY_URL
  if (!connection) throw new Error('PostgreSQL mode requires NUXT_POSTGRES_DIRECTORY_URL')
  const logConnection = process.env.NUXT_POSTGRES_LOG_URL ?? connection
  for (const value of [connection, logConnection]) {
    if (!URL.canParse(value) || !['postgresql:', 'postgres:'].includes(new URL(value).protocol)) {
      throw new Error('PostgreSQL mode requires valid PostgreSQL connection URLs')
    }
  }
  // Use the driver's effective endpoint, including socket and query-parameter overrides.
  const business = new pg.Client({ connectionString: connection })
  const logs = new pg.Client({ connectionString: logConnection })
  if (business.host !== logs.host || business.port !== logs.port || business.database !== logs.database) {
    throw new Error('PostgreSQL business and log connections must target the same PostgreSQL database')
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
