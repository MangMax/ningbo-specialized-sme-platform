import { upgradeForeignKeyFailures } from './integrity-policy'
/** Explicit offline composition for the final target; never imported by runtime initialization. */
import type Database from 'better-sqlite3'
import { requireLegacyProvenanceReady } from '../lib/platform/legacy-provenance-catalog'

export function upgradeEnterpriseMergeIdentity(sqlite: Database.Database) {
  if (Number(sqlite.pragma('user_version', { simple: true })) !== 71613) throw new Error('Enterprise identity upgrade requires completed 71613 target')
  if (Number(sqlite.pragma('foreign_keys', { simple: true })) !== 1) throw new Error('Enterprise identity upgrade requires foreign keys enabled')
  requireLegacyProvenanceReady(sqlite)
  sqlite.transaction(() => {
    sqlite.exec(`CREATE TABLE IF NOT EXISTS enterprise_merge (
      from_enterprise_id integer PRIMARY KEY REFERENCES enterprise(id) ON DELETE RESTRICT,
      into_enterprise_id integer NOT NULL REFERENCES enterprise(id) ON DELETE RESTRICT,
      basis text NOT NULL,
      recorded_at text NOT NULL,
      CONSTRAINT enterprise_merge_distinct_ck CHECK(from_enterprise_id <> into_enterprise_id),
      CONSTRAINT enterprise_merge_from_enterprise_id_safe CHECK(typeof(from_enterprise_id)='integer' AND from_enterprise_id BETWEEN 1 AND 9007199254740991),
      CONSTRAINT enterprise_merge_into_enterprise_id_safe CHECK(typeof(into_enterprise_id)='integer' AND into_enterprise_id BETWEEN 1 AND 9007199254740991)
    );
    CREATE INDEX IF NOT EXISTS enterprise_merge_into_idx ON enterprise_merge(into_enterprise_id);
    CREATE TRIGGER IF NOT EXISTS enterprise_merge_no_update BEFORE UPDATE ON enterprise_merge
      BEGIN SELECT RAISE(ABORT,'enterprise_merge_append_only'); END;
    CREATE TRIGGER IF NOT EXISTS enterprise_merge_no_delete BEFORE DELETE ON enterprise_merge
      BEGIN SELECT RAISE(ABORT,'enterprise_merge_append_only'); END;
    CREATE TRIGGER IF NOT EXISTS enterprise_merge_insert BEFORE INSERT ON enterprise_merge
      WHEN EXISTS(SELECT 1 FROM enterprise_merge WHERE from_enterprise_id IN (NEW.from_enterprise_id,NEW.into_enterprise_id))
      BEGIN SELECT RAISE(ABORT,'enterprise_merge_current_identity_required'); END;`)
    if (upgradeForeignKeyFailures(sqlite).length) throw new Error('Enterprise identity upgrade foreign key conflict')
  }).immediate()
}
