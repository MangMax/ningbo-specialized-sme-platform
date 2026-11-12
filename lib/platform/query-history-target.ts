import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { sqliteConnection } from './target-connection'
import { requireH1cReady } from './h1c-catalog'

/** Only explicitly injected, completed targets. Global expand/worker admission stays closed. */
export function queryHistoryTarget<S extends Record<string, unknown>>(db: BetterSQLite3Database<S>) {
  const connection = sqliteConnection(db)
  const phase = Number(connection.pragma('user_version', { simple: true }))
  if (phase === 0) return false
  if (phase !== 71612) throw new Error('Query history requires schema0 or a complete 71612 target')
  requireH1cReady(connection)
  return true
}
