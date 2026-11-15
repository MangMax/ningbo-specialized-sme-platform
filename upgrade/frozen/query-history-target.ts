/** Offline historical oracle from ab503081dae3e24680afc9b07395a7e3ff21fc9f. */
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { sqliteConnection } from '../../lib/platform/target-connection'
import { requireLegacyProvenanceReady } from '../legacy-provenance-catalog'
import { requireH1cReady } from '../h1c-catalog'

/** Only explicitly injected, completed targets. Global expand/worker admission stays closed. */
export function queryHistoryTarget<S extends Record<string, unknown>>(db: BetterSQLite3Database<S>) {
  const connection = sqliteConnection(db)
  const phase = Number(connection.pragma('user_version', { simple: true }))
  if (phase === 0) return false
  if (phase === 71613) { requireLegacyProvenanceReady(connection); return true }
  if (phase !== 71612) throw new Error('Query history requires schema0 or a complete 71612 target')
  requireH1cReady(connection)
  return true
}
