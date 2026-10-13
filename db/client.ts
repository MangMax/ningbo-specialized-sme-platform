import { existsSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import * as schema from './schema'
import { TITLE_SEED } from './titles'

const dbPath = resolve(process.env.NUXT_DB_PATH || './data/roster.db')

let _db: ReturnType<typeof drizzle<typeof schema>> | null = null

/** Open (once) the SQLite database, apply migrations, and seed the title dictionary. */
export function useDb() {
  if (_db) return _db

  mkdirSync(dirname(dbPath), { recursive: true })
  const sqlite = new Database(dbPath)
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')

  const db = drizzle(sqlite, { schema })

  const migrationsFolder = resolve('./db/migrations')
  if (existsSync(migrationsFolder)) {
    migrate(db, { migrationsFolder })
  }

  // Title dictionary is static; upsert so re-opens are idempotent.
  for (const t of TITLE_SEED) {
    db.insert(schema.title).values(t).onConflictDoNothing().run()
  }

  _db = db
  return db
}

export { schema, dbPath }
