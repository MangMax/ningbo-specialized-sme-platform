/** Explicit offline populated finalization, never a registered startup migration. */
import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { existsSync, realpathSync, statSync, statfsSync } from 'node:fs'
import { dirname } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { asc, eq, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import * as schema from '../db/schema'
import { assertFrozenSource, fileHash, schemaHash, withFrozenSource, type FrozenSource } from './collections'
import { projectionManifest, upgradeProjections } from './projections'
import { FINAL_OBSERVATION_VERSION } from '../db/schema-phase'
export { FINAL_OBSERVATION_VERSION } from '../db/schema-phase'
export const FINAL_OBSERVATION_TRANSFORM='t05c-independent-observation-v1'
const parent='platform_business_observation'
export const observationIncomingOwners=['platform_apply_projection','platform_business_projection','platform_legacy_relation_alias','platform_observation_archive_ref','platform_observation_assignment','platform_recognized_projection'] as const
const tables=[parent,...observationIncomingOwners]
const hash=(s:string)=>createHash('sha256').update(s).digest('hex')
const quote=(s:string)=>'"'+s.replaceAll('"','""')+'"'
type Catalog={type:string,name:string,tbl_name:string,sql:string}
export function finalizationCatalog(t:Database.Database) {return t.prepare("select type,name,tbl_name,sql from sqlite_schema where sql is not null order by type,name").all() as Catalog[]}
function preservedManifest(t:Database.Database) {
  const h=createHash('sha256')
  projectionManifest(t,line=>{
    const row=JSON.parse(line) as {table:string,fields:{name:string}[]}
    if(row.table===parent)row.fields=row.fields.filter(c=>c.name!=='relation_id')
    // Column ordinal changes only in the rebuilt parent; named-cell order is canonical here.
    row.fields.sort((a,b)=>a.name.localeCompare(b.name))
    h.update(JSON.stringify(row)+'\n')
  });return h.digest('hex')
}
function rebuild(t:Database.Database,step?:(stage:string)=>void) {
  const catalog=finalizationCatalog(t)
  const incoming=catalog.filter(x=>x.type==='table'&&x.name!==parent&& (t.pragma(`foreign_key_list(${quote(x.name)})`) as {table:string}[]).some(f=>f.table===parent)).map(x=>x.name).sort()
  if(!isDeepStrictEqual(incoming,[...observationIncomingOwners].sort()))throw new Error('Unexpected incoming FK owner inventory')
  const affected=catalog.filter(x=>tables.some(n=>x.tbl_name===n)||(x.type==='trigger'&&tables.some(n=>x.sql.includes(n))))
  for(const x of affected.filter(x=>x.type==='trigger'))t.exec(`DROP TRIGGER ${quote(x.name)}`)
  for(const name of tables)t.exec(`CREATE TEMP TABLE ${quote('t05c_'+name)} AS SELECT * FROM ${quote(name)}`)
  const sequences=t.prepare('select name,seq from sqlite_sequence').all() as {name:string,seq:number}[]
  for(const name of [...observationIncomingOwners,parent])t.exec(`DROP TABLE ${quote(name)}`)
  step?.('dropped')
  for(const name of tables) {
    let ddl=affected.find(x=>x.type==='table'&&x.name===name)!.sql
    if(name===parent)ddl=ddl.replace(/\s*`relation_id` integer PRIMARY KEY NOT NULL,/, '').replace('`id` integer,','`id` integer PRIMARY KEY NOT NULL,').replace('`collection_id` integer,','`collection_id` integer NOT NULL,').replace('`sequence_no` integer,','`sequence_no` integer NOT NULL,').replace('`position_state` text,','`position_state` text NOT NULL,').replace(/\s*FOREIGN KEY \(`relation_id`\) REFERENCES `platform_relation`\(`id`\)[^,]+,/, '')
    else ddl=ddl.replaceAll('`platform_business_observation`(`relation_id`)','`platform_business_observation`(`id`)')
    t.exec(ddl)
  }
  step?.('created')
  for(const name of tables) {
    const fields=(t.pragma(`table_info(${quote(name)})`) as {name:string}[]).map(c=>quote(c.name)).join(',')
    t.exec(`INSERT INTO ${quote(name)}(${fields}) SELECT ${fields} FROM ${quote('t05c_'+name)}`)
    step?.('copied:'+name)
  }
  for(const {name,seq} of sequences)if(tables.includes(name))t.prepare('update sqlite_sequence set seq=? where name=?').run(seq,name)
  for(const x of affected.filter(x=>x.type==='index'||x.type==='trigger')) {
    let ddl=x.sql
    if(x.name==='platform_legacy_relation_alias_owner')ddl="CREATE TRIGGER platform_legacy_relation_alias_owner BEFORE INSERT ON platform_legacy_relation_alias WHEN NOT EXISTS (SELECT 1 FROM platform_business_observation o JOIN platform_collection c ON c.id=o.collection_id JOIN platform_legacy_query_alias q ON q.collection_id=c.id WHERE o.id=NEW.observation_id) BEGIN SELECT RAISE(ABORT, 'unmapped observation collection'); END"
    else ddl=ddl.replaceAll('relation_id','id')
    t.exec(ddl)
  }
  for(const name of tables)t.exec(`DROP TABLE ${quote('t05c_'+name)}`)
  step?.('restored')
}
export type FinalizationOptions={source:string,target:string,runId:string,projectionRunId:string,observationRunId:string,collectionRunId:string,beforeCommit?:(stage:string)=>void}
export function finalizeObservations(options:FinalizationOptions,frozen?:FrozenSource):{state:'complete',sourceManifest:string,targetManifest:string,schemaHash:string} {
  if(!frozen)return withFrozenSource(options.source,f=>finalizeObservations(options,f))
  assertFrozenSource(frozen,options.source)
  const ids=[options.runId,options.projectionRunId,options.observationRunId,options.collectionRunId]
  if(ids.some(x=>!x)||new Set(ids).size!==4)throw new Error('Invalid phase run IDs')
  const source=realpathSync(options.source),target=realpathSync(options.target),ss=statSync(source),ts=statSync(target)
  if(source===target||(ss.dev===ts.dev&&ss.ino===ts.ino))throw new Error('Distinct isolated target required')
  for(const path of [source,target]) {
    for(const suffix of ['-wal','-journal'])if(existsSync(path+suffix)&&statSync(path+suffix).size>0)throw new Error('Frozen offline files required')
    const d=statfsSync(dirname(path));if(d.bavail*d.bsize<8*1024**3)throw new Error('Disk floor 8GiB')
  }
  const t=new Database(target,{fileMustExist:true})
  try {
    t.pragma('foreign_keys=ON')
    const db=drizzle(t,{schema}),r=schema.platformMigrationRun,cp=schema.platformMigrationCheckpoint
    const sourceManifest=hash(JSON.stringify({source:projectionManifest(frozen.database),phases:ids.slice(1)})),sourceHash=fileHash(frozen.fd)
    const digest=()=>hash(JSON.stringify({manifest:projectionManifest(t),runs:db.select().from(r).where(sql`${r.runId} <> ${options.runId}`).orderBy(asc(r.runId)).all(),checkpoints:db.select().from(cp).where(sql`${cp.runId} <> ${options.runId}`).orderBy(asc(cp.runId),asc(cp.phase),asc(cp.sourceTable)).all()}))
    const existing=db.select().from(r).where(eq(r.runId,options.runId)).get()
    if(existing) {
      if(existing.state!=='complete'||existing.sourceSnapshotSha256!==sourceHash||existing.sourceSchemaHash!==schemaHash(frozen.database)||existing.sourceManifestSha256!==sourceManifest||existing.transformVersion!==FINAL_OBSERVATION_TRANSFORM||existing.targetSchemaVersion!==schemaHash(t)||t.pragma('user_version',{simple:true})!==FINAL_OBSERVATION_VERSION||!isDeepStrictEqual(db.select().from(cp).where(eq(cp.runId,options.runId)).all(),[{runId:options.runId,phase:'t05c-final',sourceTable:parent,lastOldId:0,copiedCount:0,batchDigest:digest()}]))throw new Error('Finalized source/target/checkpoint binding drift')
    } else {
      if(t.pragma('user_version',{simple:true})!==0)throw new Error('Unsupported target schema version')
      const prior=db.select().from(r).where(eq(r.runId,options.projectionRunId)).get()
      if(prior?.state!=='complete')throw new Error('Completed T05b required')
      // Read-only replay validation of completed T05b, including all prerequisite and archive bindings.
      upgradeProjections({...options,runId:options.projectionRunId,batchSize:100},frozen)
      db.transaction(tx=>{
        const before=preservedManifest(t)
        rebuild(t,options.beforeCommit)
        if(before!==preservedManifest(t))throw new Error('Preserved cell/byte manifest mismatch')
        if(!isDeepStrictEqual(t.pragma('foreign_key_check'),[])||!isDeepStrictEqual(t.pragma('integrity_check'),[{integrity_check:'ok'}]))throw new Error('Final target integrity failure')
        if(fileHash(frozen.fd)!==sourceHash)throw new Error('Source drift')
        t.pragma(`user_version=${FINAL_OBSERVATION_VERSION}`)
        tx.insert(r).values({runId:options.runId,state:'complete',sourceSnapshotSha256:sourceHash,sourceSchemaHash:schemaHash(frozen.database),sourceManifestSha256:sourceManifest,targetSchemaVersion:schemaHash(t),transformVersion:FINAL_OBSERVATION_TRANSFORM}).run()
        tx.insert(cp).values({runId:options.runId,phase:'t05c-final',sourceTable:parent,lastOldId:0,copiedCount:0,batchDigest:digest()}).run()
        options.beforeCommit?.('receipt')
      },{behavior:'immediate'})
    }
    return {state:'complete',sourceManifest,targetManifest:projectionManifest(t),schemaHash:schemaHash(t)}
  } finally {t.close()}
}
