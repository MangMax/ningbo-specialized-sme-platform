import { drizzle } from 'drizzle-orm/node-postgres'
import pg from 'pg'

let pool: pg.Pool | undefined
let db: ReturnType<typeof drizzle<Record<string, never>>> | undefined

export function usePostgresDirectoryDb() {
  const connectionString = process.env.NUXT_POSTGRES_DIRECTORY_URL
  if (!connectionString) return
  if (process.env.NUXT_DB_READONLY !== '1') {
    throw new Error('PostgreSQL directory verification requires NUXT_DB_READONLY=1')
  }
  if (!db) {
    const url = new URL(connectionString)
    url.searchParams.delete('options')
    const readOnly = process.env.NUXT_POSTGRES_DIRECTORY_WRITE !== '1'
    pool = new pg.Pool({
      connectionString: url.href,
      connectionTimeoutMillis: 5000,
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
