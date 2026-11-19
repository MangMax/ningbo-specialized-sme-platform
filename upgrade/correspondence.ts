import { completeUpgradeActive, upgradeIntegrityGate, upgradeForeignKeyFailures } from './integrity-policy'
/** Maintenance-window transfer from a fixed 71610 snapshot into its independent target copy. */
import Database from 'better-sqlite3'
import {createHash} from 'node:crypto'
import {existsSync,realpathSync,statSync,statfsSync} from 'node:fs'
import {dirname} from 'node:path'
import {drizzle} from 'drizzle-orm/better-sqlite3'
import * as schema from './legacy-schema'
import {withFrozenSource,fileHash,assertFrozenSource} from './frozen-source'
import {schemaHash} from '../layers/sme-roster/lib/platform/sqlite-row-cells'
import {H1C_CATALOG_TRANSFORM,requireH1cReady} from './h1c-catalog'
import {processStoredInstalled} from './process-stored-catalog'
import {recognizedStoredInstalled} from './recognized-stored-catalog'
import {witnessInstalled} from './frozen/recognized-witness-catalog'
import {projectionManifest} from './projections'
import {z} from 'zod'
export type CorrespondenceTransferOptions={source:string;target:string;runId:string;beforeCommit?:(stage:string)=>void}
const hash=(v:string|Buffer)=>createHash('sha256').update(v).digest('hex')
const manifestOwners = ['record_correspondence', 'record_correspondence_audit'] as const
const quote=(name:string)=>`"${name.replaceAll('"','""')}"`
/** Full owner bytes without expanding multi-GiB audit text into HEX/JSON. */
export function correspondenceCellDigest(t:Database.Database) {
 const digest=createHash('sha256').update('h1c-framed-original-cells-v1\n')
 for(const table of manifestOwners) {
  const fields=z.array(z.object({name:z.string(),pk:z.number()})).parse(t.pragma(`table_info(${quote(table)})`))
  const normalized=fields.map(field=>field.name==='observation_id'&&table==='record_correspondence'?'relation_id':field.name)
  const value=(name:string)=>name==='observation_id'&&table==='record_correspondence'?'(SELECT old_id FROM platform_legacy_relation_alias WHERE observation_id=c.observation_id)':`c.${quote(name)}`
  const select=fields.flatMap(field=>{const expression=value(field.name);return[`typeof(${expression})`,`cast(${expression} as blob)`,`case when typeof(${expression})='real' then ${expression} end`]}).join(',')
  const order=fields.filter(field=>field.pk).sort((a,b)=>a.pk-b.pk).map(field=>`c.${quote(field.name)}`).join(',')||'c.rowid'
  digest.update(JSON.stringify([table,normalized])+'\n')
  for(const raw of t.prepare(`SELECT ${select} FROM ${quote(table)} c ORDER BY ${order}`).raw().iterate()) {
   const row=z.array(z.unknown()).parse(raw)
   for(let i=0;i<fields.length;i++) {
    const kind=row[i*3],bytes=row[i*3+1],numeric=row[i*3+2]
    if(typeof kind!=='string'||(bytes!==null&&!Buffer.isBuffer(bytes)))throw new Error('Invalid correspondence SQLite cell')
    let real:string|null=null
    if(kind==='real') {if(typeof numeric!=='number')throw new Error('Invalid correspondence REAL');const bits=Buffer.alloc(8);bits.writeDoubleBE(numeric);real=bits.toString('hex')}
    digest.update(JSON.stringify([normalized[i],kind,bytes?.length??null,real])+'\n')
    if(bytes)digest.update(bytes)
    digest.update('\n')
   }
  }
 }
 return digest.digest('hex')
}
function transferManifest(t:Database.Database, original=false) {
 return completeUpgradeActive()?hash(JSON.stringify({metadata:projectionManifest(t),owners:correspondenceCellDigest(t)}))
  :original?originalManifest(t):projectionManifest(t,undefined,manifestOwners)
}
/** Compare every business cell, reversing only the intended reference conversion. Offline only. */
function originalManifest(t:Database.Database) {
 const aliases=new Map((t.prepare('SELECT observation_id,old_id FROM platform_legacy_relation_alias').all() as {observation_id:number;old_id:number}[]).map(r=>[r.observation_id,r.old_id]))
 const digest=createHash('sha256')
 projectionManifest(t,line=>{
  const row=JSON.parse(line) as {table:string;fields:{name:string;kind:string;hex:string;byteLength:number|null;sha256:string|null}[]}
  if(row.table==='record_correspondence')for(const field of row.fields)if(field.name==='observation_id') {
   field.name='relation_id'
   if(field.kind!=='null') {
    const id=Number(Buffer.from(field.hex,'hex').toString()),old=aliases.get(id)
    if(old===undefined)throw new Error(`Missing reverse observation alias: ${id}`)
    const bytes=Buffer.from(String(old));field.hex=bytes.toString('hex').toUpperCase();field.byteLength=bytes.length;field.sha256=hash(bytes)
   }
  }
  digest.update(JSON.stringify(row)+'\n')
 }, manifestOwners)
 return digest.digest('hex')
}
export function transferCorrespondence(options:CorrespondenceTransferOptions):{state:'complete';mapped:number;nulls:number} {
 return withFrozenSource(options.source,frozen=>{
  const source=realpathSync(options.source),target=realpathSync(options.target),ss=statSync(source),ts=statSync(target)
  if(source===target||(ss.dev===ts.dev&&ss.ino===ts.ino))throw new Error('Distinct isolated target required')
  if(!options.runId)throw new Error('Migration run ID required')
  for(const path of [source,target]) {
   for(const suffix of ['-wal','-journal'])if(existsSync(path+suffix)&&statSync(path+suffix).size)throw new Error('Standalone fixed snapshot required')
   const disk=statfsSync(dirname(path));if(disk.bavail*disk.bsize<8*1024**3)throw new Error('Disk floor 8GiB')
  }
  const s=frozen.database,t=new Database(target,{fileMustExist:true})
  try {
   t.pragma('foreign_keys=ON')
   if(s.pragma('user_version',{simple:true})!==71610||!processStoredInstalled(s)||!recognizedStoredInstalled(s)||!witnessInstalled(s))throw new Error('Completed 71610 source required')
   const snapshot=fileHash(frozen.fd),manifest=transferManifest(s)
   const counts=s.prepare('SELECT count(relation_id) mapped,count(*)-count(relation_id) nulls FROM record_correspondence').get() as {mapped:number;nulls:number}
   const run=t.prepare('SELECT * FROM platform_migration_run WHERE run_id=?').get(options.runId) as {source_snapshot_sha256:string;transform_version:string;state:string}|undefined
   if(run) {
    if(run.state!=='complete'||run.transform_version!==H1C_CATALOG_TRANSFORM||run.source_snapshot_sha256!==snapshot)throw new Error('Migration run/source conflict')
    requireH1cReady(t)
    return {state:'complete',...counts}
   }
   if(t.pragma('user_version',{simple:true})!==71610||schemaHash(t)!==schemaHash(s)||transferManifest(t)!==manifest)throw new Error('Target must be an unchanged independent source copy')
   const missing=s.prepare('SELECT c.id,c.relation_id,a.observation_id FROM record_correspondence c LEFT JOIN platform_legacy_relation_alias a ON a.old_id=c.relation_id LEFT JOIN platform_business_observation o ON o.id=a.observation_id WHERE c.relation_id IS NOT NULL AND o.id IS NULL ORDER BY c.id').all()
   if(missing.length)throw new Error(`Unmapped correspondence rows: ${JSON.stringify(missing)}`)
   const violations=s.pragma('foreign_key_check') as unknown[]
   if(violations.length)throw new Error(`Source dangling foreign keys: ${JSON.stringify(violations)}`)
   const owners=['record_correspondence','record_correspondence_audit']
   // Rebuild only the known incoming audit owner. An unexpected owner needs an explicit migration.
   for(const {name} of s.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all() as {name:string}[])
    for(const fk of s.prepare(`PRAGMA foreign_key_list(${quote(name)})`).all() as {table:string}[])
     if(owners.includes(fk.table)&&!(name==='record_correspondence_audit'&&fk.table==='record_correspondence'))throw new Error(`Unsupported incoming FK: ${name} -> ${fk.table}`)
   const catalog=s.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE tbl_name IN ('record_correspondence','record_correspondence_audit') AND sql IS NOT NULL ORDER BY type,name").all() as {type:string;name:string;tbl_name:string;sql:string}[]
   const fields=(s.prepare('PRAGMA table_info(record_correspondence)').all() as {name:string}[]).map(c=>c.name)
   const sequence=s.prepare("SELECT name,seq FROM sqlite_sequence WHERE name IN ('record_correspondence','record_correspondence_audit') ORDER BY name").all() as {name:string;seq:number}[]
   const ledger=(db:Database.Database)=>JSON.stringify(['platform_migration_run','platform_migration_checkpoint'].map(name=>db.prepare(`SELECT * FROM ${name} ORDER BY 1,2,3`).all()))
   if(JSON.stringify(t.prepare('SELECT * FROM sqlite_sequence ORDER BY name').all())!==JSON.stringify(s.prepare('SELECT * FROM sqlite_sequence ORDER BY name').all()))throw new Error('Target sequence differs from source copy')
   if(ledger(t)!==ledger(s))throw new Error('Target migration log differs from source copy')
   const externalReferences = s.prepare("SELECT sql FROM sqlite_schema WHERE type IN ('trigger','view') AND tbl_name NOT IN ('record_correspondence','record_correspondence_audit') AND (sql LIKE '%record_correspondence%')").all()
   const renameOwners = completeUpgradeActive() && externalReferences.length === 0
   t.transaction(()=>{
    if (renameOwners) t.exec('ALTER TABLE record_correspondence_audit RENAME TO h1c_audit; ALTER TABLE record_correspondence RENAME TO h1c_correspondence')
    else t.exec('CREATE TEMP TABLE h1c_correspondence AS SELECT * FROM record_correspondence; CREATE TEMP TABLE h1c_audit AS SELECT * FROM record_correspondence_audit')
    options.beforeCommit?.('prepared')
    if (!renameOwners) t.exec('DROP TABLE record_correspondence_audit; DROP TABLE record_correspondence')
    options.beforeCommit?.('dropped')
    for(const owner of owners) {
     let ddl=catalog.find(c=>c.type==='table'&&c.name===owner)!.sql
     if(owner==='record_correspondence')ddl=ddl.replaceAll('relation_id','observation_id').replace(/REFERENCES\s+([`"]?)platform_relation\1/gi,'REFERENCES platform_business_observation')
     t.exec(ddl)
    }
    options.beforeCommit?.('created')
    t.exec(`INSERT INTO record_correspondence (${fields.map(c=>quote(c==='relation_id'?'observation_id':c)).join(',')}) SELECT ${fields.map(c=>c==='relation_id'?'(SELECT observation_id FROM platform_legacy_relation_alias WHERE old_id=c.relation_id)':`c.${quote(c)}`).join(',')} FROM h1c_correspondence c; INSERT INTO record_correspondence_audit SELECT * FROM h1c_audit`)
    options.beforeCommit?.('copied')
    if (renameOwners) t.exec('DROP TABLE h1c_audit; DROP TABLE h1c_correspondence')
    for(const c of catalog.filter(c=>c.type==='index'||c.type==='trigger'))t.exec(c.tbl_name==='record_correspondence'?c.sql.replaceAll('relation_id','observation_id'):c.sql)
    t.exec("DELETE FROM sqlite_sequence WHERE name IN ('record_correspondence','record_correspondence_audit')")
    for(const row of sequence)t.prepare('INSERT INTO sqlite_sequence(name,seq) VALUES(?,?)').run(row.name,row.seq)
    if (!renameOwners) t.exec('DROP TABLE h1c_audit; DROP TABLE h1c_correspondence')
    options.beforeCommit?.('indexed')
    if(transferManifest(t,true)!==manifest)throw new Error('Transferred business cells differ from fixed snapshot')
    if((upgradeForeignKeyFailures(t) as unknown[]).length||!upgradeIntegrityGate(t))throw new Error('Transferred target integrity failure')
    assertFrozenSource(frozen,source)
    if(fileHash(frozen.fd)!==snapshot)throw new Error('Fixed source changed')
    options.beforeCommit?.('validated')
    t.pragma('user_version=71611')
    drizzle(t,{schema}).insert(schema.platformMigrationRun).values({runId:options.runId,sourceSnapshotSha256:snapshot,sourceSchemaHash:schemaHash(s),sourceManifestSha256:manifest,targetSchemaVersion:schemaHash(t),transformVersion:H1C_CATALOG_TRANSFORM,state:'complete'}).run()
    drizzle(t,{schema}).insert(schema.platformMigrationCheckpoint).values({runId:options.runId,phase:'h1c-correspondence-fk',sourceTable:'record_correspondence',lastOldId:(s.prepare('SELECT coalesce(max(id),0) id FROM record_correspondence').get() as {id:number}).id,copiedCount:counts.mapped+counts.nulls,batchDigest:manifest}).run()
    options.beforeCommit?.('receipt')
   }).immediate()
   return {state:'complete',...counts}
  }finally{t.close()}
 })
}
