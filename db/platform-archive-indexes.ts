import type Database from 'better-sqlite3'

const lookups = [
  ['platform_apply_projection_source_archive_idx', 'platform_apply_projection', 'source_archive_id'],
  ['platform_business_projection_source_archive_idx', 'platform_business_projection', 'source_archive_id'],
  ['platform_recognized_projection_source_archive_idx', 'platform_recognized_projection', 'source_archive_id'],
  ['platform_business_version_canonical_archive_idx', 'platform_business_record_version', 'canonical_archive_id'],
] as const

export function installPlatformArchiveLookupIndexes(db:Database.Database) {
  for(const [name, table, column] of lookups)db.exec(`CREATE INDEX IF NOT EXISTS "${name}" ON "${table}"("${column}")`)
}
