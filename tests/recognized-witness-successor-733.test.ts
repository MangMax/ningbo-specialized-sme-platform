import { deserialize } from 'node:v8'
import { getTableConfig } from 'drizzle-orm/sqlite-core'
import { witnessCollection,witnessCondition,witnessObservation } from '../lib/platform/recognized-witness-schema'
import { verifyFingerprint } from '../lib/platform/fingerprint-verifier'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { expect,it } from 'vitest'
import { copyFileSync,writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { recognizedFixture } from './helpers/recognized-target-732'
import { finalizeRecognizedWitness } from '../upgrade/recognized-witness'
import { witnessInstalled } from '../lib/platform/recognized-witness-catalog'
import { recognizedStoredInstalled } from '../lib/platform/recognized-stored-catalog'
import { verifyWitnessCollection,verifyWitnessObservation,captureWitnessCollection,witnessCollectionValues } from '../lib/platform/recognized-witness-write'
import { assertExpandRuntime } from '../db/schema-phase'
import { targetSchema as s } from '../lib/platform/target-schema'
import { platformResultToImport } from '../lib/platform/recognized-evidence'
import type { PlatformLiveQueryResult,PlatformQuerySource } from '../lib/platform/live-query'
import { writeNewCollectionTarget,writeCollectionTarget,type NewCollectionTargetCommand } from '../lib/platform/collection-target-command'
import { insertArchiveValue,bindArchive,sealArchiveOwner } from '../lib/platform/target-archive'
import { listTargetRecognizedDirectory } from '../server/utils/platform-recognized-target'
async function fixture(){const f=await recognizedFixture();f.close();const source=join(f.root,'witness-source.sqlite');copyFileSync(f.target,source);return {...f,source,runId:'witness',predecessorRunId:'recognized'}}
function command(source:PlatformQuerySource='queryBusList'):NewCollectionTargetCommand {
 const raw={id:'future',rdjb:'1',qymc:'Future',rddqrq:'2028-12-31',whpc:'2026-2'}
 const e:PlatformLiveQueryResult={source,status:'success',effectiveConditions:{combination:'and',...(source==='businessList'?{uscc:'91330200712345678A'}:{name:'Future'})},titleScope:{mode:source==='queryList'?'source_default':'selected',rdjb:source==='queryList'?[]:['1']},queriedAt:'2026-11-12T00:00:00Z',completedAt:'2026-11-12T00:01:00Z',rows:[raw],dataRows:[raw],pages:[{source,rdjb:source==='queryList'?null:'1',page:1,maxPage:1,status:'success',fetchedCount:1,declaredTotal:1,error:null}],fetchedCount:1,declaredTotal:1,completeness:'complete',fullRange:true,unfinished:[],error:null,limits:{maxRequests:100,maxRows:5000,maxDurationMs:60000,pageSize:50}}
 return {queryText:JSON.stringify(platformResultToImport(e)),evidenceText:JSON.stringify(e),createdAt:'c',assignments:[{enterpriseId:null,nameRaw:'Future',usccRaw:null,matchBasis:'none',verificationStatus:'pending',origin:'command',actor:{type:'agent',id:'733'},basis:'synthetic'}]}
}
it('preserves every predecessor cell receipt and checkpoint and replays a catalog-bound successor byte-identically',async()=>{
 const f=await fixture();expect(finalizeRecognizedWitness(f)).toEqual({state:'complete',collections:6,observations:6})
 const t=new Database(f.target),source=new Database(f.source,{readonly:true})
 try{
  expect(witnessInstalled(t)).toBe(true);expect(recognizedStoredInstalled(t)).toBe(true)
  for(const table of [witnessCollection,witnessCondition,witnessObservation]) {
   const config=getTableConfig(table),physical=t.prepare(`PRAGMA table_info('${config.name}')`).all() as {name:string;type:string;notnull:number;dflt_value:unknown}[]
   for(const column of config.columns.filter(c=>c.name.startsWith('witness_'))) {
    const actual=physical.find(c=>c.name===column.name)!
    expect(actual.type.toLowerCase()).toBe(column.getSQLType())
    expect(Boolean(actual.notnull)).toBe(column.notNull)
    expect(actual.dflt_value).toBe(column.default==='uncaptured'?"'uncaptured'":null)
   }
  }
  expect(()=>assertExpandRuntime(t)).toThrow(/cutover/)
  for(const r of source.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as {name:string}[]) {
   const columns=(source.prepare(`PRAGMA table_info('${r.name}')`).all() as {name:string}[]).map(c=>`"${c.name}"`).join(',')
   const suffix=r.name.startsWith('platform_migration_')?" WHERE run_id<>'witness'":''
   expect(t.prepare(`SELECT ${columns} FROM "${r.name}"${suffix}`).all(),r.name).toEqual(source.prepare(`SELECT ${columns} FROM "${r.name}"${suffix}`).all())
  }
  expect(t.pragma('foreign_key_check')).toEqual([])
  expect(t.pragma('integrity_check',{simple:true})).toBe('ok')
  const bytes=t.serialize();t.close();expect(finalizeRecognizedWitness(f).state).toBe('complete')
  const replay=new Database(f.target);try{expect(replay.serialize()).toEqual(bytes)}finally{replay.close()}
 }finally{if(t.open)t.close();source.close()}
},30000)
it('rolls back schema captures barriers and receipts at every publication boundary',async()=>{
 const f=await fixture()
 for(const stage of ['authenticated','schema','captured','barriers','receipt']) {
  const target=join(f.root,stage+'.sqlite');copyFileSync(f.source,target)
  const before=new Database(target);const bytes=before.serialize();before.close()
  expect(()=>finalizeRecognizedWitness({...f,target,beforeCommit:s=>{if(s===stage)throw new Error('injected '+stage)}})).toThrow('injected '+stage)
  const t=new Database(target);try{expect(t.serialize()).toEqual(bytes);expect(recognizedStoredInstalled(t)).toBe(true);expect(witnessInstalled(t)).toBe(false)}finally{t.close()}
 }
},30000)
it('new commands capture source pages without changing candidate masks and replay without writes',async()=>{
 const f=await fixture();finalizeRecognizedWitness(f)
 const t=new Database(f.target);t.pragma('foreign_keys=ON');const db=drizzle(t,{schema:s})
 try{
  const input=command(),result=writeNewCollectionTarget(db,input),id=result.observations[0]!.observationId
  expect(t.prepare('SELECT witness_gate,witness_state FROM platform_collection WHERE id=?').get(result.collectionId)).toEqual({witness_gate:1,witness_state:'captured'})
  const position=t.prepare('SELECT witness_state,witness_rdjb_kind,witness_rdjb_value,witness_page_kind,witness_page_value,witness_ordinal,candidate_scope_mask FROM platform_business_observation WHERE id=?').get(id) as {witness_rdjb_value:Buffer;witness_page_value:Buffer}
  expect(position).toMatchObject({witness_state:'matched',witness_rdjb_kind:'text',witness_page_kind:'number',witness_ordinal:0,candidate_scope_mask:1})
  expect(deserialize(position.witness_rdjb_value)).toBe('1');expect(deserialize(position.witness_page_value)).toBe(1)
  verifyWitnessObservation(t,id)
  verifyFingerprint(t,{observationId:id,collectionId:result.collectionId,relationAlias:result.observations[0]!.relationAlias})
  const before=t.serialize();expect(writeCollectionTarget(db,input).observations[0]!.observationId).toBe(id);expect(t.serialize()).toEqual(before)
  for(const source of ['queryList','businessList'] as const){const future=command(source),written=writeNewCollectionTarget(db,future),bytes=t.serialize();expect(writeCollectionTarget(db,future).observations[0]!.observationId).toBe(written.observations[0]!.observationId);expect(t.serialize()).toEqual(bytes)}
  expect(listTargetRecognizedDirectory({},db).total).toBeGreaterThan(0)
  const bad=command();bad.queryText=bad.queryText.replace('future','other');const snapshot=t.serialize()
  expect(()=>db.transaction(tx=>{try{writeNewCollectionTarget(tx,bad)}catch{}})).not.toThrow();expect(t.serialize()).toEqual(snapshot)
 }finally{t.close()}
},30000)
it('rejects forged partial catalogs altered barriers or corrupted successor receipts without editing predecessor receipts',async()=>{
 const f=await fixture();finalizeRecognizedWitness(f)
 expect(()=>finalizeRecognizedWitness({...f,target:f.source})).toThrow(/Distinct isolated/)
 expect(()=>finalizeRecognizedWitness({...f,predecessorRunId:'missing'})).toThrow()
 const alteredBarrier=join(f.root,'barrier-tamper.sqlite');copyFileSync(f.target,alteredBarrier)
 const barrier=new Database(alteredBarrier)
 try{barrier.exec('DROP TRIGGER recognized_witness_observation_update');expect(()=>recognizedStoredInstalled(barrier)).toThrow(/triggers/)}finally{barrier.close()}
 const t=new Database(f.target)
 try{
  const receipts=t.prepare("SELECT * FROM platform_migration_run WHERE run_id<>'witness'").all()
  expect(()=>t.prepare('UPDATE platform_collection SET witness_gate=1 WHERE id=1').run()).toThrow(/immutable/)
  expect(()=>t.prepare("UPDATE platform_business_observation SET witness_rdjb_value='3' WHERE id=1").run()).toThrow(/immutable/)
  t.prepare("UPDATE platform_migration_checkpoint SET batch_digest='bad' WHERE run_id='witness'").run()
  expect(()=>witnessInstalled(t)).toThrow(/receipt/)
  expect(()=>recognizedStoredInstalled(t)).toThrow(/receipt/)
  expect(t.prepare("SELECT * FROM platform_migration_run WHERE run_id<>'witness'").all()).toEqual(receipts)
  const before=t.serialize();t.close();expect(()=>finalizeRecognizedWitness(f)).toThrow(/checkpoint/)
  const after=new Database(f.target);try{expect(after.serialize()).toEqual(before)}finally{after.close()}
  const altered=join(f.root,'altered.sqlite');copyFileSync(f.source,altered)
  const partial=new Database(altered);partial.exec('ALTER TABLE platform_collection ADD COLUMN witness_gate INTEGER')
  try{expect(()=>recognizedStoredInstalled(partial)).toThrow(/columns|catalog/)}finally{partial.close()}
 }finally{if(t.open)t.close()}
},30000)
it('distinguishes missing original ref from authenticated SQL NULL without reading residual legacy tables',async()=>{
 const f=await fixture();finalizeRecognizedWitness(f)
 const trace:string[]=[],t=new Database(f.target,{verbose:q=>trace.push(String(q))});t.pragma('foreign_keys=ON');const db=drizzle(t,{schema:s})
 try{
  const template=db.select().from(s.platformCollection).get()!
  const ids=[false,true].map(hasNull=>{
   const c=db.insert(s.platformCollection).values({...template,id:undefined,queryKey:hasNull?'sql-null':'missing-ref'}).returning().get()
   for(const name of ['rddqrq','whpcyear','whpc'] as const)db.insert(s.platformCollectionCondition).values({collectionId:c.id,name,valueKind:'absent'}).run()
   if(hasNull){const archiveId=insertArchiveValue(db,{storageClass:'null',bytes:null,createdAt:'c'});bindArchive(db,{kind:'collection',ownerId:c.id,field:'collectionEvidence',archiveId});sealArchiveOwner(db,{kind:'collection',ownerId:c.id})}
   captureWitnessCollection(t,c.id);verifyWitnessCollection(t,c.id);return c.id
  })
  expect(witnessCollectionValues(t,ids[0]!).fields).toMatchObject({witness_state:'uncaptured',witness_archive_id:null,witness_gate:null,witness_error:'missing_original_collection_evidence'})
  expect(witnessCollectionValues(t,ids[1]!).fields).toMatchObject({witness_state:'captured',witness_gate:0,witness_error:null})
  expect(witnessCollectionValues(t,ids[1]!).fields.witness_archive_id).toBeTypeOf('number')
  expect(trace.join('\n')).not.toMatch(/(?:from|join)\s+["`]?platform_(?:query|relation)["`]?\s/i)
  writeFileSync(join(f.root,'CERTIFICATION-TRACE.json'),JSON.stringify(trace,null,2))
 }finally{t.close()}
},30000)
