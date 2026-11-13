/** Explicit successor description only. W/R own admission; ordinary guards remain CLOSED. */
import type Database from 'better-sqlite3'
import { hasColumns, migrationFinished } from './migration-readiness'
export const LEGACY_PROVENANCE_VERSION = 71613
export const LEGACY_PROVENANCE_TRANSFORM = 'collection-legacy-provenance-v1'
export function requireLegacyProvenanceReady(t: Database.Database) {
  if (t.pragma('user_version', { simple: true }) !== LEGACY_PROVENANCE_VERSION) throw new Error('Unsupported collection provenance schema version')
  if (!hasColumns(t, 'platform_collection_legacy_provenance', ['collection_id', 'origin', 'source_identity', 'source_sha256', 'segment_index', 'input_fingerprint', 'import_batch_id', 'created_at', 'archive_id']) || !migrationFinished(t, LEGACY_PROVENANCE_TRANSFORM)) throw new Error('Collection provenance migration incomplete')
}
