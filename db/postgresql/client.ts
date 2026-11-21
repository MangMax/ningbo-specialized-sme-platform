import { drizzle } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import { eq } from 'drizzle-orm'
import { settings } from './system-catalog'
import { postgresOnlyRuntime } from '../runtime-mode'

let pool: pg.Pool | undefined
let db: ReturnType<typeof drizzle<Record<string, never>>> | undefined

async function requirePostgres19(client: pg.ClientBase) {
  const [server] = await drizzle(client as pg.Client)
    .select({ version: settings.setting }).from(settings).where(eq(settings.name, 'server_version_num'))
  if (Math.floor(Number(server?.version) / 10000) !== 19) throw new Error('PostgreSQL 19 required')
}

export function usePostgresDirectoryDb() {
  const connectionString = process.env.NUXT_POSTGRES_DIRECTORY_URL
  if (!connectionString) return
  const postgresOnly = postgresOnlyRuntime()
  if (!postgresOnly && process.env.NUXT_DB_READONLY !== '1') {
    throw new Error('PostgreSQL directory verification requires NUXT_DB_READONLY=1')
  }
  if (!db) {
    const url = new URL(connectionString)
    url.searchParams.delete('options')
    const readOnly = postgresOnly
      ? process.env.NUXT_DB_READONLY === '1'
      : process.env.NUXT_POSTGRES_DIRECTORY_WRITE !== '1'
    pool = new pg.Pool({
      connectionString: url.href,
      connectionTimeoutMillis: 5000,
      onConnect: postgresOnly ? requirePostgres19 : undefined,
      options: '-c search_path=business,public -c default_transaction_read_only=' + (readOnly ? 'on' : 'off'),
    })
    pool.on('error', error => console.error('PostgreSQL directory connection lost', error.name))
    db = drizzle<Record<string, never>>({ client: pool })
  }
  return db
}

export async function closePostgresDirectoryDb() {
  const connection = pool
  pool = undefined
  db = undefined
  await connection?.end()
}
