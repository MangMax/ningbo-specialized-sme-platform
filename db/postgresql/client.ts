import { drizzle } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import { eq, type Logger } from 'drizzle-orm'
import { createDrizzleLogger } from '../../layers/core/lib/logging/drizzle'
import { settings } from './system-catalog'

let runtime: { pool: pg.Pool; db: ReturnType<typeof drizzle<Record<string, never>>> } | undefined

async function requirePostgres19(client: pg.ClientBase) {
  const [server] = await drizzle(client as pg.Client)
    .select({ version: settings.setting }).from(settings).where(eq(settings.name, 'server_version_num'))
  if (Math.floor(Number(server?.version) / 10000) !== 19) throw new Error('PostgreSQL 19 required')
}

export function usePostgresDirectoryDb(logger?: Logger) {
  const connectionString = process.env.NUXT_POSTGRES_DIRECTORY_URL
  if (!connectionString) throw new Error('NUXT_POSTGRES_DIRECTORY_URL is required')
  if (!runtime) {
    const url = new URL(connectionString)
    url.searchParams.delete('options')
    const readOnly = process.env.NUXT_DB_READONLY === '1'
    const pool = new pg.Pool({
      connectionString: url.href,
      connectionTimeoutMillis: 5000,
      onConnect: requirePostgres19,
      options: '-c search_path=business,public -c default_transaction_read_only=' + (readOnly ? 'on' : 'off'),
    })
    pool.on('error', error => console.error('PostgreSQL directory connection lost', error.name))
    runtime = { pool, db: drizzle<Record<string, never>>({ client: pool, logger: createDrizzleLogger({ connection: 'primary' }) }) }
  }
  return logger ? drizzle<Record<string, never>>({ client: runtime.pool, logger }) : runtime.db
}

export async function closePostgresDirectoryDb() {
  const connection = runtime?.pool
  runtime = undefined
  await connection?.end()
}
