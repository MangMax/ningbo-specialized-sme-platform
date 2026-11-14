import { upgradeForeignKeyFailures } from './integrity-policy'
/** Dedicated fresh-target prerequisite; never installed by startup or ordinary expand. */
import Database from 'better-sqlite3'
import { statSync, statfsSync, realpathSync } from 'node:fs'
import { dirname } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { schemaHash } from '../lib/platform/sqlite-row-cells'
import { assertFrozenSource, fileHash, type FrozenSource } from './collections'

export const reconcileSlotColumns = ['reconcile_slot_state','reconcile_slot_rule','reconcile_slot_raw_archive_id','reconcile_slot_row_count','reconcile_slot_input_sha256','reconcile_slot_reason'] as const
export function hasReconcileSlotCapture(t: Database.Database) {
  return (t.pragma('table_info(platform_collection)') as {name:string}[]).some(c => c.name === reconcileSlotColumns[0])
}
export function requireReconcileSlotSchema(t: Database.Database) {
  const columns = new Set((t.pragma('table_info(platform_collection)') as {name:string}[]).map(c=>c.name))
  if (!reconcileSlotColumns.every(c=>columns.has(c))) throw new Error('Reconcile capture prerequisite incomplete')
  const fk = t.pragma('foreign_key_list(platform_collection)') as {from:string;table:string;to:string;on_delete:string}[]
  if (!fk.some(f=>f.from==='reconcile_slot_raw_archive_id' && f.table==='platform_archive_value' && f.to==='id' && f.on_delete==='RESTRICT')) throw new Error('Reconcile capture archive FK missing')
  for (const name of ['reconcile_slot_insert','reconcile_slot_binding','reconcile_slot_immutable','reconcile_slot_delete','reconcile_slot_observation_insert','reconcile_slot_observation_update','reconcile_slot_observation_delete']) {
    if (!t.prepare("SELECT 1 FROM sqlite_schema WHERE type='trigger' AND name=?").get(name)) throw new Error('Reconcile capture barrier missing: '+name)
  }
}
export function installReconcileSlotPrerequisite(target: string, frozen: FrozenSource, beforeCommit?: () => void) {
  assertFrozenSource(frozen,frozen.path)
  const path = realpathSync(target), a = statSync(path), b = statSync(frozen.path), disk = statfsSync(dirname(path))
  if (a.dev===b.dev && a.ino===b.ino || !a.isFile() || a.nlink!==1) throw new Error('Independent fresh target required')
  if (disk.bavail*disk.bsize < 8*1024**3) throw new Error('Disk floor 8GiB')
  const t = new Database(path,{fileMustExist:true})
  try {
    t.pragma('foreign_keys=ON')
    return t.transaction(() => {
      if (t.pragma('user_version',{simple:true}) !== 0 || hasReconcileSlotCapture(t)) throw new Error('Fresh expand prerequisite required')
      for (const table of ['platform_migration_run','platform_migration_checkpoint','platform_collection','platform_legacy_query_alias','platform_legacy_relation_alias']) {
        if (t.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get()) throw new Error('Target has begun migration')
      }
      const sourceSha256 = fileHash(frozen.fd), beforeSchema = schemaHash(t)
      t.exec(`ALTER TABLE platform_collection ADD COLUMN reconcile_slot_state TEXT NOT NULL DEFAULT 'uncaptured'
        CHECK(reconcile_slot_state IN ('uncaptured','verified','miss','error'));
        ALTER TABLE platform_collection ADD COLUMN reconcile_slot_rule TEXT;
        ALTER TABLE platform_collection ADD COLUMN reconcile_slot_raw_archive_id INTEGER REFERENCES platform_archive_value(id) ON DELETE RESTRICT
          CHECK(reconcile_slot_raw_archive_id IS NULL OR (typeof(reconcile_slot_raw_archive_id)='integer' AND reconcile_slot_raw_archive_id BETWEEN 1 AND 9007199254740991));
        ALTER TABLE platform_collection ADD COLUMN reconcile_slot_row_count INTEGER
          CHECK(reconcile_slot_row_count IS NULL OR (typeof(reconcile_slot_row_count)='integer' AND reconcile_slot_row_count BETWEEN 0 AND 9007199254740991));
        ALTER TABLE platform_collection ADD COLUMN reconcile_slot_input_sha256 TEXT
          CHECK(reconcile_slot_input_sha256 IS NULL OR (typeof(reconcile_slot_input_sha256)='text' AND length(reconcile_slot_input_sha256)=64 AND length(cast(reconcile_slot_input_sha256 AS blob))=64 AND reconcile_slot_input_sha256 NOT GLOB '*[^0-9a-f]*'));
        ALTER TABLE platform_collection ADD COLUMN reconcile_slot_reason TEXT CHECK(
          (reconcile_slot_state='uncaptured' AND reconcile_slot_rule IS NULL AND reconcile_slot_raw_archive_id IS NULL AND reconcile_slot_row_count IS NULL AND reconcile_slot_input_sha256 IS NULL)
          OR (reconcile_slot_state IN ('verified','miss','error') AND reconcile_slot_rule IS 'legacy-reconcile-slot-v1' AND reconcile_slot_raw_archive_id IS NOT NULL AND reconcile_slot_input_sha256 IS NOT NULL AND
            ((reconcile_slot_state='verified' AND reconcile_slot_row_count IS NOT NULL AND reconcile_slot_reason IS NULL)
              OR (reconcile_slot_state IN ('miss','error') AND typeof(reconcile_slot_reason)='text' AND length(reconcile_slot_reason)>0))));
        CREATE TRIGGER reconcile_slot_insert BEFORE INSERT ON platform_collection
        WHEN NEW.reconcile_slot_state<>'uncaptured' OR NEW.reconcile_slot_rule IS NOT NULL OR NEW.reconcile_slot_raw_archive_id IS NOT NULL OR NEW.reconcile_slot_input_sha256 IS NOT NULL OR NEW.reconcile_slot_row_count IS NOT NULL OR NEW.reconcile_slot_reason IS NOT NULL
        BEGIN SELECT RAISE(ABORT,'capture after original owner seal'); END;
        CREATE TRIGGER reconcile_slot_binding BEFORE UPDATE ON platform_collection
        WHEN NEW.reconcile_slot_state<>'uncaptured' AND (
          NEW.interface NOT IN ('business_list','apply_list') OR NOT EXISTS(
            SELECT 1 FROM platform_collection_archive_ref r WHERE r.owner_id=NEW.id AND r.field='rawResponse' AND r.sealed=1 AND r.archive_id=NEW.reconcile_slot_raw_archive_id))
        BEGIN SELECT RAISE(ABORT,'reconcile capture requires sealed raw owner'); END;
        CREATE TRIGGER reconcile_slot_immutable BEFORE UPDATE ON platform_collection
        WHEN (OLD.reconcile_slot_rule IS NOT NULL OR OLD.reconcile_slot_reason IS NOT NULL) AND (
          ${[...reconcileSlotColumns,'id','interface','rdjb','query_key','queried_at','status'].map(c=>`NEW.${c} IS NOT OLD.${c}`).join(' OR ')})
        BEGIN SELECT RAISE(ABORT,'immutable reconcile capture'); END;
        CREATE TRIGGER reconcile_slot_delete BEFORE DELETE ON platform_collection
        WHEN OLD.reconcile_slot_rule IS NOT NULL OR OLD.reconcile_slot_reason IS NOT NULL
        BEGIN SELECT RAISE(ABORT,'immutable reconcile capture'); END;`)
      const complete = `EXISTS(SELECT 1 FROM platform_migration_run WHERE transform_version='reconcile-slot-capture-v1' AND state='complete')`
      const verified = (owner:string) => `EXISTS(SELECT 1 FROM platform_collection WHERE id=${owner}.collection_id AND reconcile_slot_state='verified')`
      t.exec(`CREATE TRIGGER reconcile_slot_observation_insert BEFORE INSERT ON platform_business_observation WHEN ${complete} AND ${verified('NEW')}
        BEGIN SELECT RAISE(ABORT,'immutable reconcile row set'); END;
        CREATE TRIGGER reconcile_slot_observation_update BEFORE UPDATE ON platform_business_observation
        WHEN ${complete} AND (${verified('OLD')} OR ${verified('NEW')}) AND
          (NEW.id IS NOT OLD.id OR NEW.collection_id IS NOT OLD.collection_id OR NEW.sequence_no IS NOT OLD.sequence_no)
        BEGIN SELECT RAISE(ABORT,'immutable reconcile row set'); END;
        CREATE TRIGGER reconcile_slot_observation_delete BEFORE DELETE ON platform_business_observation WHEN ${complete} AND ${verified('OLD')}
        BEGIN SELECT RAISE(ABORT,'immutable reconcile row set'); END;`)
      requireReconcileSlotSchema(t)
      if (!isDeepStrictEqual(upgradeForeignKeyFailures(t),[]) || sourceSha256 !== fileHash(frozen.fd)) throw new Error('Prerequisite source/integrity drift')
      beforeCommit?.()
      return {sourceSha256,beforeSchema,afterSchema:schemaHash(t)}
    }).immediate()
  } finally { t.close() }
}
