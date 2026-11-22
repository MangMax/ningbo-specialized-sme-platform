import pg from 'pg'

export function validateRuntimeMode() {
  const connection = process.env.NUXT_POSTGRES_DIRECTORY_URL
  if (!connection) throw new Error('NUXT_POSTGRES_DIRECTORY_URL is required')
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
