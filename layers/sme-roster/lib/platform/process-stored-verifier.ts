/** Bounded same-owner authentication only; never used for query membership. */
import type Database from 'better-sqlite3'
import { and, eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { isDeepStrictEqual } from 'node:util'
import { createHash } from 'node:crypto'
import { targetSchema as s } from './target-schema'
import { storedProcessProjection as p, processWriteObservation as o, storedProcessProjection } from './process-stored-schema'
import { processMaterialization } from './process-materialization'
import { captureSqlFactTitle } from './apply-stored-cells'
import { rowSnapshot } from './sqlite-row-cells'
import type { ProcessTargetInput } from './process-target-writer'
export const PROCESS_STORED_KEYS=['exactStatus','exactDeclareKind','exactAppliedAt','exactYear','exactTitleRaw','exactBatch','exactAwardBatchLabel','exactProvince','exactStoredState','exactStoredRule','exactStoredOrigin','exactStoredReason','sqlFactTitle','sqlFactTitleState','sqlFactTitleRule','sqlFactTitleReason'] as const
const fields=['status','declare_kind','applied_at','year','title_raw','batch','award_batch_label','province']
export function verifyProcessStored(t:Database.Database,id:number,source:{kind:'command',input:ProcessTargetInput}|{kind:'legacy',cells:ReturnType<typeof rowSnapshot>}){
 const db=drizzle(t),projection=db.select().from(p).where(eq(p.observationId,id)).get(),pair=db.select().from(o).where(eq(o.id,id)).get()
 if(!projection||projection.exactStoredState!=='captured'||projection.sqlFactTitleState!=='captured')throw new Error('process_stored_uncaptured')
 if(pair?.processExactOwnerId!==id||pair.processExactState!=='captured'||pair.processSqlFactTitleState!=='captured'||projection.exactStoredRule!=='process-stored-cells-v1'||projection.sqlFactTitleRule!=='process-legacy-sql-fact-title-v1'||projection.exactStoredReason!==null||projection.sqlFactTitleReason!==null)throw new Error('process_stored_conflict: capture metadata')
 if(pair.versionId!==null){const version=db.select().from(storedProcessProjection).where(eq(storedProcessProjection.versionId,pair.versionId)).get();if(version&&PROCESS_STORED_KEYS.some(key=>version[key]!==null))throw new Error('process_stored_conflict: version capture fields')}
 const raw=db.select({r:s.platformObservationArchiveRef,a:s.platformArchiveValue}).from(s.platformObservationArchiveRef).innerJoin(s.platformArchiveValue,eq(s.platformArchiveValue.id,s.platformObservationArchiveRef.archiveId)).where(and(eq(s.platformObservationArchiveRef.ownerId,id),eq(s.platformObservationArchiveRef.field,'rawFields'))).get()
 if(!raw||raw.r.sealed!==1||(!['text','null'].includes(raw.a.storageClass)&&!(source.kind==='legacy'&&raw.a.storageClass==='blob')))throw new Error('process_stored_conflict: raw owner')
 if(raw.a.storageClass==='null'?(raw.a.bytes!==null||raw.a.byteLength!==null||raw.a.sha256!==null):(!raw.a.bytes||raw.a.byteLength!==raw.a.bytes.length||raw.a.sha256!==createHash('sha256').update(raw.a.bytes).digest('hex')))throw new Error('process_stored_conflict: raw bytes')
 const text=raw.a.storageClass==='blob'||raw.a.bytes===null?null:new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(raw.a.bytes)
 if(projection.sqlFactTitle!==captureSqlFactTitle(t,raw.a.storageClass==='blob'?raw.a.bytes:text))throw new Error('process_stored_conflict: SQL fact title')
 const assignment=db.select().from(s.platformObservationAssignment).where(and(eq(s.platformObservationAssignment.observationId,id),eq(s.platformObservationAssignment.revision,1))).get()
 let expected:ReturnType<typeof rowSnapshot>
 if(source.kind==='command'){
  if(projection.exactStoredOrigin!=='command_materialized')throw new Error('process_stored_conflict: command origin')
  const m=processMaterialization(db,source.input.row,text)
  if(!assignment||assignment.nameRaw!==m.nameRaw||assignment.usccRaw!==m.usccRaw||pair.sourceRelationKey!==m.sourceRelationKey)throw new Error('process_stored_conflict: revision1/key')
  const Connection = t.constructor as typeof Database
  const oracle = new Connection(':memory:')
  try{oracle.exec('CREATE TABLE cells(status TEXT,declare_kind TEXT,applied_at TEXT,year INTEGER,title_raw TEXT,batch TEXT,award_batch_label TEXT,province TEXT)');oracle.prepare('INSERT INTO cells VALUES(?,?,?,?,?,?,?,?)').run(m.exactStatus,m.exactDeclareKind,m.exactAppliedAt,m.exactYear,m.exactTitleRaw,m.exactBatch,m.exactAwardBatchLabel,m.exactProvince);expected=rowSnapshot(oracle,'cells','rowid',1)}finally{oracle.close()}
 }else{
  if(!['legacy_source','sealed_snapshot'].includes(projection.exactStoredOrigin??''))throw new Error('process_stored_conflict: legacy origin')
  expected=fields.map(name=>{const cell=source.cells.find(c=>c.name===name);if(!cell)throw new Error('process_stored_uncaptured: missing cell');return cell})
  const originalText=(name:string)=>{const c=source.cells.find(c=>c.name===name);if(!c||!['text','null'].includes(c.storageClass))throw new Error('process_stored_uncaptured: revision1');return c.storageClass==='null'?null:new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(Buffer.from(c.hex,'hex'))}
  if(!assignment||assignment.nameRaw!==originalText('name_raw')||assignment.usccRaw!==originalText('uscc_raw')||pair.sourceRelationKey!==originalText('relation_key'))throw new Error('process_stored_conflict: revision1/key')
 }
 const actual=rowSnapshot(t,'platform_business_projection','observation_id',id,fields.map(f=>'exact_'+f)).map((c,i)=>({...c,name:fields[i]!}))
 if(!isDeepStrictEqual(expected,actual))throw new Error('process_stored_conflict: exact cells')
}
