export { hasColumns, migrationFinished } from './migration-readiness'
import { requireLegacyProvenanceReady } from './legacy-provenance-catalog'
/** Internal target migration readiness; comprehensive validation belongs offline. */
import type Database from 'better-sqlite3'
export function requireH1cReady(t:Database.Database) {
 requireLegacyProvenanceReady(t)
}
