import Database from 'better-sqlite3'
import { copyFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { processReaderFixture } from './process-target-734'
import { schemaHash } from '../../lib/platform/sqlite-row-cells'
import { projectionManifest } from '../../upgrade/projections'
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
type Fixture = Awaited<ReturnType<typeof processReaderFixture>>

/** Test-owned controlled catalog only; not the C migration implementation. */
export function controlledH1cSuccessor(f: Fixture, name='controlled-h1c') {
  const path = join(f.root, name+'.sqlite')
  copyFileSync(f.target, path)
  const t = new Database(path)
  t.pragma('foreign_keys=ON')
  const table = (name: string) => (t.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name=?").get(name) as {sql:string}).sql
  const ddl = table('record_correspondence').replaceAll('`relation_id`', '`observation_id`').replace('REFERENCES `platform_relation`', 'REFERENCES `platform_business_observation`')
  const audit = table('record_correspondence_audit')
  const indexes = t.prepare("SELECT sql FROM sqlite_schema WHERE type='index' AND tbl_name IN ('record_correspondence','record_correspondence_audit') AND sql IS NOT NULL ORDER BY name").all() as {sql:string}[]
  const sequence = t.prepare("SELECT * FROM sqlite_sequence WHERE name IN ('record_correspondence','record_correspondence_audit') ORDER BY name").all() as {name:string;seq:number}[]
  t.transaction(() => {
    t.exec('CREATE TEMP TABLE saved_edges AS SELECT * FROM record_correspondence; CREATE TEMP TABLE saved_audit AS SELECT * FROM record_correspondence_audit; DROP TABLE record_correspondence_audit; DROP TABLE record_correspondence')
    t.exec(ddl); t.exec(audit)
    t.exec('INSERT INTO record_correspondence SELECT * FROM saved_edges; INSERT INTO record_correspondence_audit SELECT * FROM saved_audit')
    for (const index of indexes) t.exec(index.sql.replaceAll('`relation_id`', '`observation_id`'))
    t.exec("DELETE FROM sqlite_sequence WHERE name IN ('record_correspondence','record_correspondence_audit')")
    for (const row of sequence) t.prepare('INSERT INTO sqlite_sequence(name,seq) VALUES(?,?)').run(row.name,row.seq)
    t.exec('DROP TABLE saved_edges; DROP TABLE saved_audit')
    t.pragma('user_version=71611')
    const sourceSchemaHash = schemaHash(f.t), targetSchemaHash = schemaHash(t)
    const copiedCount = (t.prepare('SELECT count(*) n FROM record_correspondence').get() as {n:number}).n
    const digest = projectionManifest(t)
    t.prepare('INSERT INTO platform_migration_run(run_id,state,source_snapshot_sha256,source_schema_hash,source_manifest_sha256,target_schema_version,transform_version) VALUES(?,?,?,?,?,?,?)').run('h1c','complete',hash(readFileSync(f.target)),sourceSchemaHash,projectionManifest(f.t),targetSchemaHash,'h1c-correspondence-observation-v1')
    t.prepare('INSERT INTO platform_migration_checkpoint(run_id,phase,source_table,last_old_id,copied_count,batch_digest) VALUES(?,?,?,?,?,?)').run('h1c','h1c-correspondence-fk','record_correspondence',0,copiedCount,digest)
  }).immediate()
  return t
}
