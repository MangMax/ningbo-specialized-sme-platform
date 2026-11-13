import { businessStatusRule } from '../lib/platform/business-status-catalog'
import { sourceValueKind, sourceFieldComparison } from '../lib/platform/source-extraction'
/** Offline T05b only. Source parsing ends here; no runtime consumer imports this module. */
import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { realpathSync, statSync, statfsSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { TextDecoder } from 'node:util'
import { and, asc, eq, sql } from 'drizzle-orm'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../db/schema'
import { parseApplyRecord } from '../lib/platform/apply-record'
import { parseBusinessProcess } from '../lib/platform/business-projection'
import { parseRecognizedRecord } from '../lib/platform/recognized-projection'
import { bindArchive, insertArchiveValue, type ArchiveInput } from '../lib/platform/immutable-archive'
import { assertFrozenSource, fileHash, schemaHash, withFrozenSource, type FrozenSource } from './collections'
import { upgradeObservations, rowSnapshot } from './observations'
import { verifyReconcileHistory } from './reconcile-slot-capture'

export const PROJECTION_TRANSFORM='t05b-source-projections-v1'
type Db=BetterSQLite3Database<typeof schema>
const hash=(v:string|Buffer)=>createHash('sha256').update(v).digest('hex')
/** Infrastructure manifest: SQLite storage classes and bytes, ordered by the complete PK. */
export function projectionManifest(s:Database.Database,emit?:(line:string)=>void) {
  const tables=s.prepare("select name from sqlite_schema where type='table' and name not like 'sqlite_%' and name not in ('platform_migration_run','platform_migration_checkpoint') order by name").all() as {name:string}[]
  const digest=createHash('sha256')
  for(const {name} of tables) {
    const fields=s.prepare(`pragma table_info("${name}")`).all() as {name:string,pk:number}[]
    const pk=fields.filter(c=>c.pk).sort((a,b)=>a.pk-b.pk).map(c=>`"${c.name}"`).join(',')
    const values=fields.flatMap((c,i)=>[`typeof("${c.name}") k${i}`,`hex(cast("${c.name}" as blob)) b${i}`,`case when typeof("${c.name}")='real' then "${c.name}" end n${i}`]).join(',')
    for(const row of s.prepare(`select ${values} from "${name}" order by ${pk||'rowid'}`).iterate()) {
      const cells=row as Record<string,unknown>
      const line=JSON.stringify({table:name,fields:fields.map((c,i)=>{
        const kind=cells[`k${i}`],hex=cells[`b${i}`]
        const numeric=cells[`n${i}`]
        if(typeof hex!=='string')throw new Error('Invalid SQLite cell bytes')
        const bytes=Buffer.from(hex,'hex'),metadata={name:c.name,kind,hex,byteLength:kind==='null'?null:bytes.length,sha256:kind==='null'?null:hash(bytes)}
        if(kind==='real' && typeof numeric==='number') {const bits=Buffer.alloc(8);bits.writeDoubleBE(numeric);return {...metadata,real64be:bits.toString('hex')}}
        return metadata
      })})
      digest.update(line+'\n');emit?.(line)
    }
  }
  return digest.digest('hex')
}
function archiveValid(a:typeof schema.platformArchiveValue.$inferSelect) {
  if(a.storageClass==='null' ? a.bytes!==null||a.byteLength!==null||a.sha256!==null : !Buffer.isBuffer(a.bytes)||a.bytes.length!==a.byteLength||hash(a.bytes)!==a.sha256) throw new Error('Invalid archive length or digest')
}
function canonical(s:Database.Database,id:number):ArchiveInput {
  const cell=s.prepare('select typeof(canonical_raw_json) kind,cast(canonical_raw_json as blob) bytes from platform_business_record_version where id=?').get(id) as {kind:string,bytes:Buffer}
  if(cell.kind!=='text'&&cell.kind!=='blob') throw new Error('Unsupported canonical storage')
  return {storageClass:cell.kind,bytes:cell.bytes,createdAt:null}
}
function originalVersionArchives(s:Database.Database,t:Database.Database,sd:Db,db:Db) {
  const r=schema.platformVersionArchiveRef,a=schema.platformArchiveValue
  for(const ref of sd.select().from(r).orderBy(asc(r.ownerId),asc(r.field)).all()) {
    const actual=db.select().from(r).where(and(eq(r.ownerId,ref.ownerId),eq(r.field,ref.field))).get()
    if(!isDeepStrictEqual(ref,actual)) throw new Error('Original version archive reference drift')
    const source=sd.select().from(a).where(eq(a.id,ref.archiveId)).get(),target=db.select().from(a).where(eq(a.id,ref.archiveId)).get()
    if(!source||!target) throw new Error('Missing original version archive')
    archiveValid(source);archiveValid(target)
    if(!isDeepStrictEqual(rowSnapshot(s,'platform_archive_value','id',ref.archiveId),rowSnapshot(t,'platform_archive_value','id',ref.archiveId))) throw new Error('Original version archive metadata drift')
  }
}
function decode(a:typeof schema.platformArchiveValue.$inferSelect) {
  if(a.storageClass==='null') return {state:'absent' as const,row:null}
  try {
    const parsed:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(a.bytes!))
    if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))return {state:'invalid' as const,row:null}
    return {state:'valid' as const,row:parsed as Record<string,unknown>}
  }catch{return {state:'invalid' as const,row:null}}
}
function transferObservation(db:Db,id:number,transform:string) {
  const o=schema.platformBusinessObservation,r=schema.platformRelation,c=schema.platformCollection,a=schema.platformArchiveValue,ref=schema.platformObservationArchiveRef
  const input=db.select({source:c.interface,province:r.province,status:r.status,batch:r.batch,declareKind:r.declareKind,appliedAt:r.appliedAt,awardBatchLabel:r.awardBatchLabel,year:r.year,createdAt:r.createdAt,versionId:o.versionId}).from(o).innerJoin(r,eq(r.id,o.relationId)).innerJoin(c,eq(c.id,o.collectionId)).where(eq(o.relationId,id)).get()
  const raw=db.select({value:a,ref}).from(ref).innerJoin(a,eq(a.id,ref.archiveId)).where(and(eq(ref.ownerId,id),eq(ref.field,'rawFields'))).get()
  if(!input||!raw||raw.ref.sealed!==1)throw new Error('Missing mapped source or sealed raw owner')
  archiveValid(raw.value)
  const decoded=decode(raw.value),title=decoded.row?.rdjb,titleKind=decoded.state==='valid'?sourceValueKind(title):decoded.state==='invalid'?'invalid':'absent'
  const common={createdAt:input.createdAt,observationId:id,versionId:null,recordId:null,basis:decoded.state==='valid'?'observation_reconciliation' as const:'unavailable' as const,parseState:decoded.state,sourceArchiveId:raw.ref.archiveId,sourceTitleKind:titleKind,sourceTitleText:typeof title==='string'?title:null,sourceTitleNumberText:typeof title==='number'&&Number.isFinite(title)?String(title):null,sourceTitleBoolean:typeof title==='boolean'?Number(title):null,sourceTitleRuleVersion:PROJECTION_TRANSFORM}
  switch(input.source) {
    case 'apply_list':db.insert(schema.platformApplyProjection).values({...common,...sourceFieldComparison('apply_list',input,decoded.row,decoded.state),...parseApplyRecord(decoded.row),ruleVersion:'platform-apply-v1'}).run();break
    case 'business_list':db.insert(schema.platformBusinessProjection).values({...common,...sourceFieldComparison('business_list',input,decoded.row,decoded.state),sourceTitleRuleVersion:transform,...parseBusinessProcess(decoded.row),ruleVersion:'platform-business-v1'}).run();break
    case 'recognized_list': {
      // Preserve captured fidelity exactly, including uncaptured NULL; raw parsing cannot upgrade trust.
      const old=input.versionId===null?undefined:db.select().from(schema.platformRecognizedProjection).where(eq(schema.platformRecognizedProjection.versionId,input.versionId)).get()
      db.insert(schema.platformRecognizedProjection).values({...common,...sourceFieldComparison('recognized_list',input,decoded.row,decoded.state),...parseRecognizedRecord(decoded.row),sourceValidityDate:old?.sourceValidityDate??null,sourceMaintenanceBatch:old?.sourceMaintenanceBatch??null,sourceMaintenanceYearAbsent:old?.sourceMaintenanceYearAbsent??null,ruleVersion:'platform-recognized-v1'}).run();break
    }
    default:throw new Error('Unsupported source interface')
  }
}
function transferVersion(s:Database.Database,db:Db,id:number) {
  const r=schema.platformVersionArchiveRef,a=schema.platformArchiveValue,v=schema.platformBusinessRecordVersion,input=canonical(s,id)
  let ref=db.select().from(r).where(and(eq(r.ownerId,id),eq(r.field,'canonicalRawJson'))).get()
  if(!ref) {
    bindArchive(db,{kind:'version',ownerId:id,field:'canonicalRawJson',archiveId:insertArchiveValue(db,input)})
    ref=db.select().from(r).where(eq(r.ownerId,id)).get()!
  }
  const value=db.select().from(a).where(eq(a.id,ref.archiveId)).get()!
  archiveValid(value)
  if(value.storageClass!==input.storageClass||!isDeepStrictEqual(value.bytes,input.bytes))throw new Error('Canonical archive bytes conflict')
  if(ref.sealed!==1)db.update(r).set({sealed:1}).where(eq(r.ownerId,id)).run()
  db.update(v).set({canonicalArchiveId:ref.archiveId}).where(eq(v.id,id)).run()
}
export type ProjectionUpgradeOptions={source:string,target:string,runId:string,observationRunId:string,collectionRunId:string,batchSize:number,transformVersion?:string,beforeCheckpoint?:(phase:string,id:number)=>void}
type ProjectionUpgradeResult={state:'complete',observationCount:number,sourceManifest:string,targetManifest:string}
export function upgradeProjections(options:ProjectionUpgradeOptions,frozen?:FrozenSource):ProjectionUpgradeResult {
  if(!frozen)return withFrozenSource(options.source,f=>upgradeProjections(options,f))
  assertFrozenSource(frozen,options.source)
  if(new Set([options.runId,options.observationRunId,options.collectionRunId]).size!==3||!options.runId||!Number.isSafeInteger(options.batchSize)||options.batchSize<1||options.batchSize>1000)throw new Error('Invalid run or batch')
  const source=realpathSync(options.source),target=realpathSync(options.target),ss=statSync(source),ts=statSync(target)
  if(source===target||(ss.dev===ts.dev&&ss.ino===ts.ino))throw new Error('Distinct isolated target required')
  for(const path of [source,target]) {
    for(const suffix of ['-wal','-journal'])if(existsSync(path+suffix)&&statSync(path+suffix).size>0)throw new Error('Frozen offline files required')
    const d=statfsSync(dirname(path));if(d.bavail*d.bsize<8*1024**3)throw new Error('Disk floor 8GiB')
  }
  const s=frozen.database,t=new Database(target,{fileMustExist:true})
  try {
    t.pragma('foreign_keys=ON')
    const transform=businessStatusRule(t)
    if(options.transformVersion!==undefined&&options.transformVersion!==transform)throw new Error('Source/schema/transform binding changed')
    const db=drizzle(t,{schema}),sd=drizzle(s,{schema}),runs=schema.platformMigrationRun,cp=schema.platformMigrationCheckpoint
    const binding={runId:options.runId,sourceSnapshotSha256:fileHash(frozen.fd),sourceSchemaHash:schemaHash(s),sourceManifestSha256:hash(JSON.stringify({manifest:projectionManifest(s),observationRunId:options.observationRunId,collectionRunId:options.collectionRunId})),targetSchemaVersion:schemaHash(t),transformVersion:transform}
    const targetDigest=()=>hash(JSON.stringify({manifest:projectionManifest(t),checkpoints:db.select().from(cp).where(sql`NOT (${cp.runId} = ${options.runId} AND ${cp.phase} = 't05b-target')`).orderBy(asc(cp.runId),asc(cp.phase),asc(cp.sourceTable)).all(),prerequisites:db.select().from(runs).where(sql`${runs.runId} <> ${options.runId}`).orderBy(asc(runs.runId)).all()}))
    const run=db.select().from(runs).where(eq(runs.runId,options.runId)).get()
    if(run) {const {state:_,...stored}=run;if(!isDeepStrictEqual(binding,stored))throw new Error('Source/schema/transform binding changed')}
    else {
      const prior=db.select().from(runs).where(eq(runs.runId,options.observationRunId)).get()
      if(prior?.state!=='complete')throw new Error('Completed T05a required')
      // T05a is revalidated before any T05b domain changes. Its own immutable source checks
      // deliberately reject added projection/version facts on subsequent runs.
      upgradeObservations({source:options.source,target:options.target,runId:options.observationRunId,collectionRunId:options.collectionRunId,batchSize:options.batchSize},frozen)
      originalVersionArchives(s,t,sd,db)
      db.transaction(tx=>{
        tx.insert(runs).values({...binding,state:'running'}).run()
        tx.insert(cp).values({runId:options.runId,phase:'t05b-target',sourceTable:'all',lastOldId:0,copiedCount:0,batchDigest:targetDigest()}).run()
      })
    }
    const targetKey=and(eq(cp.runId,options.runId),eq(cp.phase,'t05b-target'))
    const checkpoint=db.select().from(cp).where(targetKey).get()
    if(!checkpoint||checkpoint.sourceTable!=='all'||checkpoint.lastOldId!==0||checkpoint.copiedCount!==0||checkpoint.batchDigest!==targetDigest())throw new Error('Target checkpoint drift')
    for(const phase of ['observations','versions'] as const) {
      const key=and(eq(cp.runId,options.runId),eq(cp.phase,`t05b-${phase}`)),previous=db.select().from(cp).where(key).get()
      let last=previous?.lastOldId??0,count=previous?.copiedCount??0
      const ids=phase==='observations'?sd.select({id:schema.platformRelation.id}).from(schema.platformRelation).orderBy(asc(schema.platformRelation.id)).all():sd.select({id:schema.platformBusinessRecordVersion.id}).from(schema.platformBusinessRecordVersion).orderBy(asc(schema.platformBusinessRecordVersion.id)).all()
      if(!isDeepStrictEqual(ids.filter(x=>x.id<=last).at(-1)?.id??0,last)||ids.filter(x=>x.id<=last).length!==count)throw new Error('Checkpoint PK drift')
      while(true) {
        const batch=ids.filter(x=>x.id>last).slice(0,options.batchSize)
        if(!batch.length)break
        db.transaction(tx=>{
          for(const {id} of batch) {if(phase==='observations')transferObservation(tx,id,transform);else transferVersion(s,tx,id)}
          options.beforeCheckpoint?.(phase,batch.at(-1)!.id)
          if(fileHash(frozen.fd)!==binding.sourceSnapshotSha256)throw new Error('Source drift')
          const values={runId:options.runId,phase:`t05b-${phase}`,sourceTable:phase==='observations'?'platform_relation':'platform_business_record_version',lastOldId:batch.at(-1)!.id,copiedCount:count+batch.length,batchDigest:hash(JSON.stringify(ids.filter(x=>x.id<=batch.at(-1)!.id)))}
          if(tx.select().from(cp).where(key).get())tx.update(cp).set(values).where(key).run();else tx.insert(cp).values(values).run()
          tx.update(cp).set({batchDigest:targetDigest()}).where(targetKey).run()
        },{behavior:'immediate'})
        last=batch.at(-1)!.id;count+=batch.length
      }
    }
    // Full PK equality, not cardinality, including raw-only and shared versions.
    const expected=sd.select({id:schema.platformRelation.id}).from(schema.platformRelation).orderBy(asc(schema.platformRelation.id)).all().map(x=>x.id)
    const actual=[...db.select({id:schema.platformApplyProjection.observationId}).from(schema.platformApplyProjection).where(sql`observation_id IS NOT NULL`).all(),...db.select({id:schema.platformBusinessProjection.observationId}).from(schema.platformBusinessProjection).where(sql`observation_id IS NOT NULL`).all(),...db.select({id:schema.platformRecognizedProjection.observationId}).from(schema.platformRecognizedProjection).where(sql`observation_id IS NOT NULL`).all()].map(x=>x.id).sort((a,b)=>a!-b!)
    const versions=sd.select({id:schema.platformBusinessRecordVersion.id}).from(schema.platformBusinessRecordVersion).orderBy(asc(schema.platformBusinessRecordVersion.id)).all()
    const v=schema.platformBusinessRecordVersion,vr=schema.platformVersionArchiveRef
    const archived=db.select({id:v.id}).from(v).innerJoin(vr,and(eq(vr.ownerId,v.id),eq(vr.archiveId,v.canonicalArchiveId),eq(vr.sealed,1),eq(vr.field,'canonicalRawJson'))).orderBy(asc(v.id)).all()
    if(!isDeepStrictEqual(versions,archived))throw new Error('Incomplete canonical version PK coverage')
    if(!isDeepStrictEqual(expected,actual))throw new Error('Incomplete observation projection PK coverage')
    if(!isDeepStrictEqual(t.pragma('foreign_key_check'),[])||!isDeepStrictEqual(t.pragma('integrity_check'),[{integrity_check:'ok'}]))throw new Error('Target integrity failure')
    if(fileHash(frozen.fd)!==binding.sourceSnapshotSha256)throw new Error('Source drift')
    verifyReconcileHistory(s,t,true)
    db.update(runs).set({state:'complete'}).where(eq(runs.runId,options.runId)).run()
    return {state:'complete' as const,observationCount:expected.length,sourceManifest:binding.sourceManifestSha256,targetManifest:projectionManifest(t)}
  }finally{t.close()}
}
