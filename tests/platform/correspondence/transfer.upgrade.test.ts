import { finalEvidenceFromSource } from '../fixtures/completed-upgrade'
import { readPlatformQueryEvidence as readLegacyEvidence } from '../oracles/legacy-evidence'
import Database from 'better-sqlite3'
import {execFileSync} from 'node:child_process'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { copyFileSync,readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll,beforeEach,afterAll,expect,it } from 'vitest'
import { processReaderFixture } from '../fixtures/migrated-business-processes'
import { writeProcessTarget } from '../../../upgrade/frozen/process-target-writer'
import { writeRecognizedTarget } from '../../../upgrade/frozen/recognized-target-writer'
import * as s from '../../../upgrade/legacy-schema'
import {getTargetBusinessProcess} from '../../../upgrade/frozen/server/platform-business-processes-target'
import {getTargetRecognizedRecord} from '../../../upgrade/frozen/server/platform-recognized-target'
import {readTargetRelationEvidenceDisplay} from '../../../layers/sme-roster/server/utils/platform-relation-evidence-display-target'
import {readTargetPlatformEvidence} from '../../../layers/sme-roster/lib/platform/target-evidence-read'
import {targetSchema} from '../../../upgrade/target-schema'
import {createOfflineSnapshot} from '../../../upgrade/offline-snapshot'
import {projectionManifest} from '../../../upgrade/projections'
import {emptyProcessReaderFixture} from '../fixtures/migrated-business-processes'
import { transferCorrespondence } from '../../../upgrade/correspondence'
let f:Awaited<ReturnType<typeof processReaderFixture>>,source:string,target:string
const observed:number[]=[]
beforeAll(async()=>{
 f=await processReaderFixture(false,t=>t.exec("INSERT INTO platform_query(id,interface,query_key,rdjb,queried_at,status,created_at) VALUES(21,'recognized_list','R','2','t','success','c')"))
 f.t.exec("UPDATE platform_legacy_alias_sequence SET high_water=100 WHERE namespace='relation'")
 for(const [sequenceNo,collectionId,writer] of [[90,11,writeProcessTarget],[91,11,writeProcessTarget],[1,21,writeRecognizedTarget]] as const){
  const result=writer(f.db,{collectionId,position:{sequenceNo,positionState:'unknown'},row:{sequenceNo,relationKey:'TRANSFER',nameRaw:'Selected',rawFields:{id:'TRANSFER',rdjb:'2',cszt:'pending',whpcyear:'2024',whpc:'B'}},assignment:{nameRaw:'Selected',matchBasis:'none',verificationStatus:'pending',origin:'command',actor:{type:'agent',id:'transfer'},basis:'original'}})
  observed.push(result.observationId)
  // Valid legacy FK rows for original external IDs; target observations are deliberately different IDs.
  f.t.prepare("INSERT INTO platform_relation(id,query_id,sequence_no,name_raw,raw_fields,created_at) VALUES(?,?,?,'Selected',?,'c')").run(result.relationAlias,collectionId,sequenceNo,JSON.stringify({id:'TRANSFER',rdjb:'2',cszt:'pending',whpcyear:'2024',whpc:'B'}))
  drizzle(f.t,{schema:s}).insert(s.recordCorrespondence).values({id:30+observed.length,edgeKey:'transfer-'+observed.length,type:collectionId===21?'event_recognized':'event_process',role:'candidate',relationId:result.relationAlias,titleCode:'specialized_sme',status:'rejected',revision:3,targetIdentity:{relationId:result.relationAlias},provenance:{original:true},sourceFingerprint:'original-hash',ruleId:'r',ruleVersion:'v',createdAt:'c'}).run()
 }
 f.t.exec(`INSERT INTO record_correspondence(id,edge_key,type,role,title_code,status,revision,target_identity,provenance,source_fingerprint,rule_id,rule_version,created_at) VALUES(34,'null','event_export_context','candidate','specialized_sme','candidate',1,'{}','{}','hash','r','v','c');
 INSERT INTO import_batch(id,idempotency_key,source_kind,source_identity,status,preflight_result,summary,created_at) VALUES(9,'audit-batch','correspondence_decision','fixture','committed',' { "requestHash":"original" } ',' { "correspondenceIds":[31,33] } ','c');
 INSERT INTO record_correspondence_audit(id,correspondence_id,batch_id,idempotency_key,to_status,expected_revision,resulting_revision,actor_type,actor_id,basis,rule_id,rule_version,evidence,decided_at) VALUES(77,31,9,'audit1','rejected',2,3,'agent','fixture','original','r','v',' { "relationId":101 } ','c'),(78,33,9,'audit2','rejected',2,3,'agent','fixture','original','r','v',' { "relationId":103 } ','c');`)
 source=join(f.root,'fixed-71610.sqlite');target=join(f.root,'transferred.sqlite');await createOfflineSnapshot(f.target,source);copyFileSync(source,target)
})
beforeEach(()=>copyFileSync(source,target))
afterAll(()=>f?.close())
it('transfers populated correspondence references through nonidentity aliases preserving distinct observations and audit',()=>{
 expect(transferCorrespondence({source,target,runId:'h1c'})).toEqual({state:'complete',mapped:4,nulls:1})
 const t=new Database(target)
 try{
  expect(t.prepare('SELECT id,observation_id FROM record_correspondence ORDER BY id').all()).toEqual([{id:1,observation_id:1},...observed.map((id,i)=>({id:31+i,observation_id:id})),{id:34,observation_id:null}])
  expect(t.prepare('SELECT id,correspondence_id,batch_id FROM record_correspondence_audit ORDER BY id').all()).toEqual([{id:77,correspondence_id:31,batch_id:9},{id:78,correspondence_id:33,batch_id:9}])
  expect(t.pragma('foreign_key_check')).toEqual([])
 }finally{t.close()}
})

it('keeps full detail DTOs and external IDs for both sources and separate observations of the same content',()=>{
 const processId=(f.t.prepare("SELECT id FROM platform_business_record WHERE interface='business_list' AND platform_key='TRANSFER'").get() as {id:number}).id
 const recognizedId=(f.t.prepare("SELECT id FROM platform_business_record WHERE interface='recognized_list' AND platform_key='TRANSFER'").get() as {id:number}).id
 const before=[getTargetBusinessProcess(f.db,processId),getTargetRecognizedRecord(f.db,recognizedId)] as const
 expect(before[0].observations.map(o=>({id:o.relationId,refs:o.correspondenceRefs}))).toEqual([{id:102,refs:[{id:32,status:'rejected',revision:3}]},{id:101,refs:[{id:31,status:'rejected',revision:3}]}])
 transferCorrespondence({source,target,runId:'h1c'})
 const t=new Database(target),db=drizzle(t,{schema:targetSchema})
 try{
  expect([getTargetBusinessProcess(db,processId),getTargetRecognizedRecord(db,recognizedId)]).toEqual(before)
  expect(t.prepare('SELECT record_id,version_id FROM platform_business_observation WHERE id IN (?,?) ORDER BY id').all(observed[0],observed[1])).toEqual([expect.objectContaining({record_id:processId}),expect.objectContaining({record_id:processId})])
  const versions=t.prepare('SELECT version_id FROM platform_business_observation WHERE id IN (?,?) ORDER BY id').all(observed[0],observed[1]) as {version_id:number}[]
  expect(versions[0]?.version_id).toBe(versions[1]?.version_id)
  const fk=t.pragma('foreign_key_list(record_correspondence)') as {from:string;table:string;to:string;on_delete:string}[]
  expect(fk).toHaveLength(6)
  expect(fk.find(r=>r.from==='observation_id')).toMatchObject({table:'platform_business_observation',to:'id',on_delete:'NO ACTION'})
  expect(fk.some(r=>r.table==='platform_relation')).toBe(false)
  expect(t.prepare("SELECT name FROM sqlite_schema WHERE type='index' AND tbl_name='record_correspondence' ORDER BY name").all()).toHaveLength(6)
  expect(t.prepare("SELECT * FROM sqlite_sequence WHERE name IN ('record_correspondence','record_correspondence_audit') ORDER BY name").all()).toEqual(f.t.prepare("SELECT * FROM sqlite_sequence WHERE name IN ('record_correspondence','record_correspondence_audit') ORDER BY name").all())
 }finally{t.close()}
})
it('preserves original correspondence fields serialized references audit bytes and fixed snapshot bytes',()=>{
 const original=readFileSync(source)
 transferCorrespondence({source,target,runId:'h1c'})
 const t=new Database(target)
 try{
  for(const table of ['record_correspondence','record_correspondence_audit','import_batch']) {
   const fields=(f.t.prepare(`PRAGMA table_info(${table})`).all() as {name:string}[]).filter(c=>c.name!=='relation_id').map(c=>c.name)
   const sql=`SELECT ${fields.flatMap(c=>[`typeof(${c}) AS k_${c}`,`hex(cast(${c} AS blob)) AS b_${c}`]).join(',')} FROM ${table} ORDER BY id`
   expect(t.prepare(sql).all()).toEqual(f.t.prepare(sql).all())
  }
  expect(readFileSync(source).equals(original)).toBe(true)
 }finally{t.close()}
})
it.each(['prepared','dropped','created','copied','indexed','validated','receipt'])('rolls back at %s then retries and replays without duplicating or losing rows',stage=>{
 const original=readFileSync(target)
 expect(()=>transferCorrespondence({source,target,runId:'h1c',beforeCommit:at=>{if(at===stage)throw new Error('cancel transfer')}})).toThrow('cancel transfer')
 const t=new Database(target)
 try{
  expect(t.pragma('user_version',{simple:true})).toBe(71610)
  expect(projectionManifest(t)).toBe(projectionManifest(f.t))
  expect(t.prepare("SELECT * FROM platform_migration_run WHERE run_id='h1c'").get()).toBeUndefined()
  expect(t.pragma('foreign_key_check')).toEqual([])
 }finally{t.close()}
 expect(readFileSync(target).equals(original)).toBe(true)
 expect(transferCorrespondence({source,target,runId:'h1c'})).toEqual({state:'complete',mapped:4,nulls:1})
 const committed=readFileSync(target)
 expect(transferCorrespondence({source,target,runId:'h1c'})).toEqual({state:'complete',mapped:4,nulls:1})
 expect(readFileSync(target).equals(committed)).toBe(true)
})
it('fails with concrete original row IDs when a normal legacy reference has no observation alias',()=>{
 const badSource=join(f.root,'unmapped-source.sqlite'),badTarget=join(f.root,'unmapped-target.sqlite')
 copyFileSync(source,badSource)
 const s=new Database(badSource)
 s.exec("INSERT INTO platform_relation(id,query_id,sequence_no,name_raw,created_at) VALUES(999,11,999,'missing mapping','c'); INSERT INTO record_correspondence SELECT 999,'unmapped',type,role,event_id,predecessor_event_id,999,export_row_id,enterprise_id,title_code,status,revision,target_identity,provenance,source_fingerprint,rule_id,rule_version,created_at,decided_at,ended_at FROM record_correspondence WHERE id=1")
 s.close();copyFileSync(badSource,badTarget)
 const original=readFileSync(badTarget)
 expect(()=>transferCorrespondence({source:badSource,target:badTarget,runId:'h1c'})).toThrow('Unmapped correspondence rows: [{"id":999,"relation_id":999,"observation_id":null}]')
 expect(readFileSync(badTarget).equals(original)).toBe(true)
})
it('transfers a normally empty target copy without manufacturing correspondence or audit rows',async()=>{
 const empty=await emptyProcessReaderFixture()
 try{
  const src=join(empty.root,'empty-fixed.sqlite'),dst=join(empty.root,'empty-target.sqlite')
  await createOfflineSnapshot(empty.target,src);copyFileSync(src,dst)
  expect(transferCorrespondence({source:src,target:dst,runId:'empty-h1c'})).toEqual({state:'complete',mapped:0,nulls:0})
  const t=new Database(dst)
  try{expect(t.prepare('SELECT * FROM record_correspondence').all()).toEqual([]);expect(t.prepare('SELECT * FROM record_correspondence_audit').all()).toEqual([]);expect(t.pragma('foreign_key_check')).toEqual([])}finally{t.close()}
 }finally{empty.close()}
})
it('reads original evidence and display without source receipt proof while preserving missing and uncaptured facts',async()=>{
 const native=finalEvidenceFromSource(f.root,f.legacySource)
 const selections=[1,7,8].map(relationId=>({relationId}))
 try{
  const before=readTargetRelationEvidenceDisplay(native.db,selections)
  const evidence=readTargetPlatformEvidence(native.db,{queryId:11,field:'legacyProvenance'})
  expect(evidence).toEqual(readLegacyEvidence(native.old,{queryId:11,field:'legacyProvenance'}))
  const archives=native.t.prepare('SELECT id,storage_class,sha256,byte_length,hex(bytes) bytes FROM platform_archive_value ORDER BY id').all()
  expect(native.t.prepare("SELECT count(*) n FROM platform_migration_run WHERE transform_version='t04-collection-reconcile-slot-v2'").get()).toEqual({n:1})
  native.t.exec("DELETE FROM platform_migration_checkpoint WHERE run_id IN (SELECT run_id FROM platform_migration_run WHERE transform_version='t04-collection-reconcile-slot-v2'); DELETE FROM platform_migration_run WHERE transform_version='t04-collection-reconcile-slot-v2'")
  expect(native.t.prepare("SELECT count(*) n FROM platform_migration_run WHERE transform_version='t04-collection-reconcile-slot-v2'").get()).toEqual({n:0})
  expect(readTargetRelationEvidenceDisplay(native.db,selections)).toEqual(before)
  expect(readTargetPlatformEvidence(native.db,{queryId:11,field:'legacyProvenance'})).toEqual(evidence)
  expect(before.sources.get(8)).toMatchObject({rawFields:null,sourceText:null})
  expect(native.t.prepare('SELECT id,storage_class,sha256,byte_length,hex(bytes) bytes FROM platform_archive_value ORDER BY id').all()).toEqual(archives)
  expect(native.t.pragma('foreign_key_check')).toEqual([])
 }finally{native.close()}
})

it('runs the offline command and saves the actual table catalog FK counts and completion receipt',()=>{
 const evidence=join(f.root,'transfer-command-evidence')
 const output=execFileSync(process.execPath,['upgrade/run-correspondence.mjs',source,target,evidence,'cli-h1c'],{encoding:'utf8',env:{...process.env,JITI_FS_CACHE:'false'}})
 expect(JSON.parse(output)).toEqual({state:'complete',mapped:4,nulls:1})
 const receipt=JSON.parse(readFileSync(join(evidence,'receipt.json'),'utf8'))
 expect(receipt.target).toMatchObject({phase:71611,counts:{correspondence:5,audit:2},foreignKeyCheck:[]})
 expect(receipt.target.catalog.find((r:{type:string;name:string})=>r.type==='table'&&r.name==='record_correspondence').sql).toContain('platform_business_observation')
})

it('keeps detail correspondence selection in its read snapshot and observes the next committed revision freshly',()=>{
 transferCorrespondence({source,target,runId:'h1c'})
 const t=new Database(target);t.pragma('journal_mode=WAL')
 const writer=new Database(target),db=drizzle(t,{schema:targetSchema})
 const id=(t.prepare("SELECT id FROM platform_business_record WHERE interface='business_list' AND platform_key='TRANSFER'").get() as {id:number}).id
 try{
  let before:ReturnType<typeof getTargetBusinessProcess>
  db.transaction(tx=>{
   before=getTargetBusinessProcess(tx,id)
   writer.prepare("UPDATE record_correspondence SET status='unlinked',revision=4 WHERE id=31").run()
   expect(getTargetBusinessProcess(tx,id)).toEqual(before)
  })
  expect(getTargetBusinessProcess(db,id).observations.find(r=>r.relationId===101)?.correspondenceRefs).toEqual([{id:31,status:'unlinked',revision:4}])
 }finally{writer.close();t.pragma('wal_checkpoint(TRUNCATE)');t.pragma('journal_mode=DELETE');t.close()}
})
