import { upgradeIntegrityGate, upgradeForeignKeyFailures } from './integrity-policy'
/** Explicit offline 71611 -> 71612. Never imported by application startup. */
import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { existsSync, realpathSync, statSync, statfsSync } from 'node:fs'
import { dirname } from 'node:path'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import * as schema from './legacy-schema'
import { withFrozenSource, fileHash, assertFrozenSource } from './frozen-source'
import { schemaHash } from '../layers/sme-roster/lib/platform/sqlite-row-cells'
import { requireH1cReady } from './h1c-catalog'
import { DIFFERENCE_REFERENCE_TRANSFORM, requireDifferenceReferencesReady } from './difference-reference-catalog'
import { processStoredInstalled } from './process-stored-catalog'
import { recognizedStoredInstalled } from './recognized-stored-catalog'
import { witnessInstalled } from './frozen/recognized-witness-catalog'
import { projectionManifest } from './projections'
export type DifferenceTransferOptions = { source: string; target: string; runId: string; beforeCommit?: (stage: string) => void }
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`
const hash = (v: Buffer) => createHash('sha256').update(v).digest('hex')
/** Offline full-cell comparison, reversing exactly the two current physical references. */
function originalManifest(t: Database.Database) {
 const queries = new Map((t.prepare('SELECT collection_id,old_id FROM platform_legacy_query_alias').all() as {collection_id:number;old_id:number}[]).map(r => [r.collection_id,r.old_id]))
 const relations = new Map((t.prepare('SELECT observation_id,old_id FROM platform_legacy_relation_alias').all() as {observation_id:number;old_id:number}[]).map(r => [r.observation_id,r.old_id]))
 const digest = createHash('sha256')
 projectionManifest(t, line => {
  const row = JSON.parse(line) as {table:string;fields:{name:string;kind:string;hex:string;byteLength:number|null;sha256:string|null}[]}
  if (row.table === 'difference_reason') for (const cell of row.fields) {
   const aliases = cell.name === 'evidence_query_id' ? queries : cell.name === 'evidence_relation_id' ? relations : null
   if (aliases && cell.kind !== 'null') {
    const id = Number(Buffer.from(cell.hex,'hex').toString()), old = aliases.get(id)
    if (old === undefined) throw new Error(`Missing reverse difference alias: ${cell.name} ${id}`)
    const bytes = Buffer.from(String(old)); cell.hex = bytes.toString('hex').toUpperCase(); cell.byteLength = bytes.length; cell.sha256 = hash(bytes)
   }
  }
  digest.update(JSON.stringify(row)+'\n')
 })
 return digest.digest('hex')
}
export function transferDifferenceReferences(options: DifferenceTransferOptions): {state:'complete';rows:number;queries:number;relations:number} {
 return withFrozenSource(options.source, frozen => {
  const source = realpathSync(options.source), target = realpathSync(options.target), ss = statSync(source), ts = statSync(target)
  if (source === target || (ss.dev === ts.dev && ss.ino === ts.ino)) throw new Error('Distinct isolated target required')
  if (![ss,ts].every(file => file.isFile() && file.nlink === 1)) throw new Error('Independent regular source and target files required')
  if (!options.runId) throw new Error('Migration run ID required')
  for (const path of [source,target]) {
   for (const suffix of ['-wal','-journal']) if (existsSync(path+suffix) && statSync(path+suffix).size) throw new Error('Standalone fixed snapshot required')
   const disk = statfsSync(dirname(path)); if (disk.bavail*disk.bsize < 8*1024**3) throw new Error('Disk floor 8GiB')
  }
  const s = frozen.database, t = new Database(target,{fileMustExist:true})
  try {
   t.pragma('foreign_keys=ON')
   if (s.pragma('user_version',{simple:true}) !== 71611) throw new Error('Completed 71611 source required')
   requireH1cReady(s)
   if (!processStoredInstalled(s) || !recognizedStoredInstalled(s) || !witnessInstalled(s)) throw new Error('Completed 71611 source required')
   const snapshot = fileHash(frozen.fd), manifest = projectionManifest(s)
   const counts = s.prepare('SELECT count(*) rows,count(evidence_query_id) queries,count(evidence_relation_id) relations FROM difference_reason').get() as {rows:number;queries:number;relations:number}
   const run = t.prepare('SELECT source_snapshot_sha256,transform_version,state FROM platform_migration_run WHERE run_id=?').get(options.runId) as {source_snapshot_sha256:string;transform_version:string;state:string}|undefined
   if (run) {
    if (run.state !== 'complete' || run.transform_version !== DIFFERENCE_REFERENCE_TRANSFORM || run.source_snapshot_sha256 !== snapshot) throw new Error('Migration run/source conflict')
    requireDifferenceReferencesReady(t)
    return {state:'complete',...counts}
   }
   if (t.pragma('user_version',{simple:true}) !== 71611 || schemaHash(t) !== schemaHash(s) || projectionManifest(t) !== manifest) throw new Error('Target must be an unchanged independent source copy')
   const missing = s.prepare(`SELECT d.id,d.evidence_query_id,d.evidence_relation_id,q.collection_id,r.observation_id FROM difference_reason d
    LEFT JOIN platform_legacy_query_alias q ON q.old_id=d.evidence_query_id LEFT JOIN platform_collection c ON c.id=q.collection_id
    LEFT JOIN platform_legacy_relation_alias r ON r.old_id=d.evidence_relation_id LEFT JOIN platform_business_observation o ON o.id=r.observation_id
    WHERE (d.evidence_query_id IS NOT NULL AND c.id IS NULL) OR (d.evidence_relation_id IS NOT NULL AND o.id IS NULL) ORDER BY d.id`).all()
   if (missing.length) throw new Error(`Unmapped difference rows: ${JSON.stringify(missing)}`)
   const violations = s.pragma('foreign_key_check') as unknown[]
   if (violations.length) throw new Error(`Source dangling foreign keys: ${JSON.stringify(violations)}`)
   const owners = ['difference_reason']
   for (const {name} of s.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as {name:string}[])
    if (name !== 'difference_reason' && (s.prepare(`PRAGMA foreign_key_list(${quote(name)})`).all() as {table:string}[]).some(fk => fk.table === 'difference_reason')) owners.push(name)
   const catalog = (s.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY type,name').all() as {type:string;name:string;tbl_name:string;sql:string}[]).filter(c => owners.includes(c.tbl_name))
   const sequence = s.prepare('SELECT name,seq FROM sqlite_sequence ORDER BY name').all() as {name:string;seq:number}[]
   const ledger = (db:Database.Database) => JSON.stringify(['platform_migration_run','platform_migration_checkpoint'].map(name => db.prepare(`SELECT * FROM ${name} ORDER BY 1,2,3`).all()))
   if (JSON.stringify(t.prepare('SELECT name,seq FROM sqlite_sequence ORDER BY name').all()) !== JSON.stringify(sequence) || ledger(t) !== ledger(s)) throw new Error('Target sequence/migration log differs from source copy')
   const reboundDdl = (owner:string,ddl:string) => owner === 'difference_reason' ? ddl.replace(/REFERENCES\s+([`"]?)platform_query\1/gi,'REFERENCES platform_collection').replace(/REFERENCES\s+([`"]?)platform_relation\1/gi,'REFERENCES platform_business_observation') : ddl
   t.transaction(() => {
    // Defer enforcement only until commit; foreign_keys stays ON throughout. This permits
    // self previous_id and incoming owners to retain their original IDs in the same table.
    t.pragma('defer_foreign_keys=ON')
    for (const [i,owner] of owners.entries()) t.exec(`CREATE TEMP TABLE difference_transfer_${i} AS SELECT * FROM ${quote(owner)}`)
    options.beforeCommit?.('prepared')
    for (const owner of [...owners].reverse()) t.exec(`DROP TABLE ${quote(owner)}`)
    options.beforeCommit?.('dropped')
    for (const owner of owners) {
     const table = catalog.find(c => c.type === 'table' && c.name === owner)
     if (!table) throw new Error(`Missing table DDL: ${owner}`)
     const ddl = reboundDdl(owner,table.sql)
     t.exec(ddl)
    }
    options.beforeCommit?.('created')
    for (const [i,owner] of owners.entries()) {
     const fields = (s.prepare(`PRAGMA table_info(${quote(owner)})`).all() as {name:string}[]).map(c => c.name)
     const values = fields.map(c => owner === 'difference_reason' && c === 'evidence_query_id' ? '(SELECT collection_id FROM platform_legacy_query_alias WHERE old_id=d.evidence_query_id)' : owner === 'difference_reason' && c === 'evidence_relation_id' ? '(SELECT observation_id FROM platform_legacy_relation_alias WHERE old_id=d.evidence_relation_id)' : `d.${quote(c)}`)
     t.exec(`INSERT INTO ${quote(owner)} (${fields.map(quote).join(',')}) SELECT ${values.join(',')} FROM difference_transfer_${i} d`)
    }
    options.beforeCommit?.('copied')
    for (const c of catalog.filter(c => c.type === 'index' || c.type === 'trigger')) t.exec(c.sql)
    for (const owner of owners) t.prepare('DELETE FROM sqlite_sequence WHERE name=?').run(owner)
    for (const row of sequence.filter(r => owners.includes(r.name))) t.prepare('INSERT INTO sqlite_sequence(name,seq) VALUES(?,?)').run(row.name,row.seq)
    for (const [i] of owners.entries()) t.exec(`DROP TABLE difference_transfer_${i}`)
    options.beforeCommit?.('indexed')
    const installed = (t.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY type,name').all() as typeof catalog).filter(c => owners.includes(c.tbl_name))
    if (JSON.stringify(installed) !== JSON.stringify(catalog.map(c => ({...c,sql:c.type === 'table' ? reboundDdl(c.tbl_name,c.sql) : c.sql})))) throw new Error('Transferred constraints/indexes/triggers differ from source contract')
    if (originalManifest(t) !== manifest || ledger(t) !== ledger(s) || JSON.stringify(t.prepare('SELECT name,seq FROM sqlite_sequence ORDER BY name').all()) !== JSON.stringify(sequence)) throw new Error('Transferred business cells/log/sequence differ from fixed snapshot')
    if ((upgradeForeignKeyFailures(t) as unknown[]).length || !upgradeIntegrityGate(t)) throw new Error('Transferred target integrity failure')
    assertFrozenSource(frozen,source)
    if (fileHash(frozen.fd) !== snapshot) throw new Error('Fixed source changed')
    options.beforeCommit?.('validated')
    t.pragma('user_version=71612')
    const db = drizzle(t,{schema})
    db.insert(schema.platformMigrationRun).values({runId:options.runId,sourceSnapshotSha256:snapshot,sourceSchemaHash:schemaHash(s),sourceManifestSha256:manifest,targetSchemaVersion:schemaHash(t),transformVersion:DIFFERENCE_REFERENCE_TRANSFORM,state:'complete'}).run()
    db.insert(schema.platformMigrationCheckpoint).values({runId:options.runId,phase:'difference-evidence-fk',sourceTable:'difference_reason',lastOldId:(s.prepare('SELECT coalesce(max(id),0) id FROM difference_reason').get() as {id:number}).id,copiedCount:counts.rows,batchDigest:manifest}).run()
    options.beforeCommit?.('receipt')
   }).immediate()
   return {state:'complete',...counts}
  } finally { t.close() }
 })
}
