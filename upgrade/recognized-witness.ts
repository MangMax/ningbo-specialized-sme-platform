import { upgradeMemoizedDigest, upgradeIntegrityGate, upgradeForeignKeyFailures } from './integrity-policy'
/** #733 A: maintenance-window fixed snapshot -> independent target, explicit #732 successor. */
import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { existsSync,realpathSync,statSync,statfsSync } from 'node:fs'
import { dirname } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { eq,asc } from 'drizzle-orm'
import { targetSchema as schema } from '../lib/platform/target-schema'
import { withFrozenSource,assertFrozenSource,fileHash,type FrozenSource } from '../lib/platform/frozen-source'
import { schemaHash } from '../lib/platform/sqlite-row-cells'
import { projectionManifest } from './projections'
import { recognizedStoredInstalled } from '../lib/platform/recognized-stored-catalog'
import { witnessDefinitions } from '../lib/platform/recognized-witness-schema'
import { witnessInstalled,witnessTriggers,WITNESS_TRANSFORM } from '../lib/platform/recognized-witness-catalog'
import { captureWitnessCollection,captureWitnessObservation,verifyWitnessCollection,verifyWitnessObservation } from '../lib/platform/recognized-witness-write'
export type WitnessUpgradeOptions={source:string,target:string,runId:string,predecessorRunId:string,beforeCommit?:(stage:string)=>void}
function digest(t:Database.Database,run:string,original=false) {
 return upgradeMemoizedDigest(t,JSON.stringify(['recognized-witness',run,original]),()=>{
 const h=createHash('sha256')
 projectionManifest(t,line=>{if(original){const r=z.object({table:z.string(),fields:z.array(z.object({name:z.string()}).passthrough())}).parse(JSON.parse(line));r.fields=r.fields.filter(c=>!c.name.startsWith('witness_'));line=JSON.stringify(r)}h.update(line+'\n')})
 for(const table of ['platform_migration_run','platform_migration_checkpoint'])h.update(JSON.stringify(t.prepare(`SELECT * FROM ${table} WHERE run_id<>? ORDER BY run_id${table.endsWith('checkpoint')?',phase,source_table':''}`).all(run)))
 h.update(JSON.stringify(t.prepare('SELECT * FROM sqlite_sequence ORDER BY name').all()))
 return h.digest('hex')
 })
}
export function finalizeRecognizedWitness(options:WitnessUpgradeOptions,frozen?:FrozenSource):{state:'complete';collections:number;observations:number} {
 if(!frozen)return withFrozenSource(options.source,s=>finalizeRecognizedWitness(options,s))
 assertFrozenSource(frozen,options.source)
 const source=realpathSync(options.source),target=realpathSync(options.target),ss=statSync(source),ts=statSync(target)
 if(ss.dev===ts.dev&&ss.ino===ts.ino)throw new Error('Distinct isolated source and target required')
 if(!options.runId||!options.predecessorRunId||options.runId===options.predecessorRunId)throw new Error('Distinct run IDs required')
 for(const p of [source,target]){for(const suffix of ['-wal','-journal'])if(existsSync(p+suffix)&&statSync(p+suffix).size)throw new Error('Standalone fixed offline files required');const d=statfsSync(dirname(p));if(d.bavail*d.bsize<8*1024**3)throw new Error('Disk floor 8GiB')}
 const s=frozen.database,sourceHash=fileHash(frozen.fd),sourceSchema=schemaHash(s),sourceManifest=digest(s,options.runId)
 if(!recognizedStoredInstalled(s)||witnessInstalled(s))throw new Error('Accepted #732 catalog predecessor required')
 z.object({state:z.literal('complete'),transform_version:z.literal('recognized-stored-title-v1'),target_schema_version:z.literal(sourceSchema)}).parse(s.prepare('SELECT * FROM platform_migration_run WHERE run_id=?').get(options.predecessorRunId))
 const db=drizzle(s,{schema}),c=schema.platformCollection,o=schema.platformBusinessObservation
 const collections=db.select({id:c.id}).from(c).where(eq(c.interface,'recognized_list')).orderBy(asc(c.id)).all()
 const observations=db.select({id:o.id}).from(o).innerJoin(c,eq(c.id,o.collectionId)).where(eq(c.interface,'recognized_list')).orderBy(asc(o.id)).all()
 const t=new Database(target,{fileMustExist:true});t.pragma('foreign_keys=ON')
 const checkpoint=()=>({run_id:options.runId,phase:'recognized-witness',source_table:'platform_collection',last_old_id:0,copied_count:collections.length,batch_digest:digest(t,options.runId)})
 try{
 const existing=t.prepare('SELECT * FROM platform_migration_run WHERE run_id=?').get(options.runId)
 if(existing){
 z.object({state:z.literal('complete'),source_snapshot_sha256:z.literal(sourceHash),source_schema_hash:z.literal(sourceSchema),source_manifest_sha256:z.literal(sourceManifest),target_schema_version:z.literal(schemaHash(t)),transform_version:z.literal(WITNESS_TRANSFORM)}).parse(existing)
 if(!isDeepStrictEqual(t.prepare('SELECT * FROM platform_migration_checkpoint WHERE run_id=?').all(options.runId),[checkpoint()]))throw new Error('witness_checkpoint_drift')
 }else{
 if(schemaHash(t)!==sourceSchema||digest(t,options.runId)!==sourceManifest||t.pragma('user_version',{simple:true})!==71609)throw new Error('Unproven witness target facts/catalog')
 t.transaction(()=>{
 options.beforeCommit?.('authenticated')
 for(const [table,fields] of Object.entries(witnessDefinitions))for(const [name,type] of Object.entries(fields))t.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`)
 options.beforeCommit?.('schema')
 for(const c of collections)captureWitnessCollection(t,c.id)
 for(const o of observations)captureWitnessObservation(t,o.id)
 options.beforeCommit?.('captured')
 t.exec(witnessTriggers)
 options.beforeCommit?.('barriers')
 if(digest(t,options.runId,true)!==sourceManifest)throw new Error('Original facts/hash/IDs/bytes/receipts drift')
 if(!isDeepStrictEqual(upgradeForeignKeyFailures(t),[])||!upgradeIntegrityGate(t))throw new Error('Witness successor integrity failure')
 t.prepare('INSERT INTO platform_migration_run(run_id,state,source_snapshot_sha256,source_schema_hash,source_manifest_sha256,target_schema_version,transform_version) VALUES(?,?,?,?,?,?,?)').run(options.runId,'complete',sourceHash,sourceSchema,sourceManifest,schemaHash(t),WITNESS_TRANSFORM)
 t.prepare('INSERT INTO platform_migration_checkpoint(run_id,phase,source_table,last_old_id,copied_count,batch_digest) VALUES(@run_id,@phase,@source_table,@last_old_id,@copied_count,@batch_digest)').run(checkpoint())
 if(!witnessInstalled(t)||!recognizedStoredInstalled(t))throw new Error('Witness successor catalog receipt conflict')
 for(const c of collections)verifyWitnessCollection(t,c.id)
 for(const o of observations)verifyWitnessObservation(t,o.id)
 options.beforeCommit?.('receipt');assertFrozenSource(frozen,options.source);if(fileHash(frozen.fd)!==sourceHash)throw new Error('Frozen witness source drift')
 }).immediate()
 }
 if(!witnessInstalled(t)||!recognizedStoredInstalled(t))throw new Error('Witness successor catalog unavailable')
 for(const c of collections)verifyWitnessCollection(t,c.id)
 for(const o of observations)verifyWitnessObservation(t,o.id)
 assertFrozenSource(frozen,options.source);if(fileHash(frozen.fd)!==sourceHash)throw new Error('Frozen witness source drift')
 return {state:'complete',collections:collections.length,observations:observations.length}
 }finally{t.close()}
}
