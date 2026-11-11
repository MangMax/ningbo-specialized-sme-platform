import Database from 'better-sqlite3'
import * as expandSchema from '../db/schema'
import { ensurePlatformObservation } from '../server/utils/platform-business-record'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { copyFileSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'
import { upgradeCollections } from '../upgrade/collections'
import { upgradeObservations } from '../upgrade/observations'
import { upgradeProjections } from '../upgrade/projections'
import { finalizeObservations, finalizeCollectionScopes } from '../upgrade/finalize-observations'
import { installFingerprintBasis } from '../upgrade/fingerprint-basis'
const evidence=process.env.FINGERPRINT_CAPTURE_EVIDENCE_DIR??tmpdir()
function fixture(seed?:(s:Database.Database)=>void) {
  const root=mkdtempSync(join(evidence,'sqlite-')),source=join(root,'source.sqlite'),target=join(root,'target.sqlite')
  const s=new Database(source);migrate(drizzle(s),{migrationsFolder:'db/migrations'})
  s.exec(`INSERT INTO platform_query(id,interface,query_key,rdjb,queried_at,status,created_at) VALUES(1,'apply_list','Q','2','t','success','c');
    INSERT INTO platform_relation(id,query_id,sequence_no,relation_key,raw_fields,created_at) VALUES(11,1,1,'A','null','c');`)
  seed?.(s)
  s.close();copyFileSync(source,target)
  upgradeCollections({source,target,runId:'collections',batchSize:10})
  upgradeObservations({source,target,runId:'observations',collectionRunId:'collections',batchSize:10})
  upgradeProjections({source,target,runId:'projections',observationRunId:'observations',collectionRunId:'collections',batchSize:10})
  const opts={source,target,runId:'final',projectionRunId:'projections',observationRunId:'observations',collectionRunId:'collections'}
  finalizeObservations(opts);finalizeCollectionScopes({...opts,runId:'scopes',finalizationRunId:'final'})
  const t=new Database(target);t.pragma('foreign_keys=ON')
  return {source,target,t}
}

import { beforeAll, afterAll } from 'vitest'
import { installFingerprintBarrier } from '../upgrade/fingerprint-basis'
import { targetSchema } from '../lib/platform/target-schema'
import { writeApplyTarget, type ApplyTargetInput } from '../lib/platform/apply-target-writer'
import { writeProcessTarget } from '../lib/platform/process-target-writer'
import { writeRecognizedTarget } from '../lib/platform/recognized-target-writer'
let base: Buffer
beforeAll(()=>{ const f=fixture(t=>{
 t.exec("insert into platform_query(id,interface,query_key,rdjb,queried_at,status,created_at) values(2,'business_list','B','','t','success','c'),(3,'recognized_list','R','','t','success','c')")
 let id=100
 for(const queryId of [1,2,3])for(const [i,raw] of [null,'null','bad','5','[]','{"id":"A","year":"2028","whpcyear":false,"rddqrq":" raw "}'].entries())t.prepare("insert into platform_relation(id,query_id,sequence_no,relation_key,raw_fields,source_text,created_at) values(?,?,?,'A',?,'source','c')").run(id++,queryId,i+10,raw)
 }); installFingerprintBasis(f.t); installFingerprintBarrier(f.t); f.t.pragma('user_version=71607'); base=f.t.serialize(); f.t.close() })
const assignment={matchBasis:'none',verificationStatus:'pending',origin:'command',actor:{type:'agent',id:'test'},basis:'explicit'} as const
function fresh(source='apply_list') { const t=new Database(base); t.pragma('foreign_keys=ON'); return {t,db:drizzle(t,{schema:targetSchema})} }
const sourceId=(source:string)=>source==='apply_list'?1:source==='business_list'?2:3
const input:ApplyTargetInput={collectionId:1,position:{sequenceNo:2,positionState:'unknown'},row:{sequenceNo:2,rawFields:null},assignment}
it.each([['apply_list',writeApplyTarget],['business_list',writeProcessTarget],['recognized_list',writeRecognizedTarget]] as const)('captures literal canonical bytes for %s even without record/version', (source,writer)=>{
 const {t,db}=fresh(source); const args={...input,collectionId:sourceId(source)}; const result=writer(db,args)
 const literal='{"assignment":{"actor":{"id":"test","type":"agent"},"basis":"explicit","matchBasis":"none","origin":"command","verificationStatus":"pending"},"collectionId":1,"position":{"positionState":"unknown","sequenceNo":2},"row":{"rawFields":null,"sequenceNo":2}}'
 expect(t.prepare('select scheme,cast(bytes as text) bytes from platform_observation_fingerprint_basis b join platform_archive_value a on a.id=b.input_archive_id where observation_id=?').get(result.observationId)).toEqual({scheme:'target-command-v1',bytes:literal.replace('collectionId\":1','collectionId\":'+args.collectionId)})
 expect(result.recordId).toBeNull();expect(result.versionId).toBeNull();expect(t.pragma('foreign_key_check')).toEqual([]);t.close()
})
import { verifyFingerprint } from '../lib/platform/fingerprint-verifier'
it('verifies captured input against facts and revision1 but leaves revision2 outside original hash',()=>{
 const {t,db}=fresh(); const r=writeApplyTarget(db,input)
 expect(verifyFingerprint(t,{observationId:r.observationId,collectionId:1,relationAlias:r.relationAlias}).scheme).toBe('target-command-v1')
 t.prepare("insert into platform_observation_assignment(observation_id,revision,match_basis,verification_status,origin,actor,basis) values(?,2,'none','pending','command','{}','later')").run(r.observationId)
 expect(()=>verifyFingerprint(t,{observationId:r.observationId,collectionId:1,relationAlias:r.relationAlias})).not.toThrow();t.close()
})
import { bootstrapFingerprint } from '../lib/platform/fingerprint-bootstrap'
it('ordinary bootstrap captures original legacy null envelope even with request while reference leaves not_indexed intact',()=>{
 const {t}=fresh();const owner={observationId:11,collectionId:1,relationAlias:11}
 const before=t.serialize();expect(bootstrapFingerprint(t,owner,'reference')).toBeNull();expect(t.serialize()).toEqual(before)
 expect(bootstrapFingerprint(t,owner,'ordinary')?.scheme).toBe('legacy-bootstrap-v1')
 expect(verifyFingerprint(t,owner).scheme).toBe('legacy-bootstrap-v1');t.close()
})

it.each([['apply_list',writeApplyTarget],['business_list',writeProcessTarget],['recognized_list',writeRecognizedTarget]] as const)('FK OFF refuses %s before writes including outer transactions',(source,writer)=>{
 const {t,db}=fresh(source);t.pragma('foreign_keys=OFF');const before=t.serialize()
 for(const outer of [false,true]) {if(outer)t.exec('BEGIN');expect(()=>writer(db,{...input,collectionId:sourceId(source)})).toThrow(/foreign_keys/);if(outer)t.exec('ROLLBACK');expect(t.serialize()).toEqual(before)}t.close()
})
it.each(['platform_observation_fingerprint_basis','platform_observation_assignment','platform_observation_archive_ref','platform_apply_projection','platform_legacy_relation_alias'])('caller-caught %s failure restores basis archive IDs and alias highwater',table=>{
 const {t,db}=fresh();t.exec(`create trigger inject before insert on ${table} begin select raise(abort,'injected');end`);const before=t.serialize()
 t.exec('BEGIN');expect(()=>writeApplyTarget(db,input)).toThrow('injected');expect(t.serialize()).toEqual(before);t.exec('ROLLBACK');expect(t.serialize()).toEqual(before);t.close()
})
it('safe observation allocation refuses exhausted sqlite_sequence before any persisted change',()=>{
 const {t,db}=fresh();t.exec("insert into sqlite_sequence(name,seq) values('platform_business_observation',9007199254740991)");const before=t.serialize();expect(()=>writeApplyTarget(db,input)).toThrow(/exhausted/);expect(t.serialize()).toEqual(before);t.close()
})
it.each(['page_id','input_fingerprint','projection_rule_version','key_source','record_id','version_id'])('rejects %s drift with original relation error envelope',field=>{
 const {t,db}=fresh();const r=writeApplyTarget(db,input)
 // Explicit corruption probe removes only relevant guards; this is not a supported write path.
 const triggers=t.prepare("select name from sqlite_schema where type='trigger' and tbl_name='platform_business_observation'").all() as {name:string}[];for(const {name} of triggers)t.exec(`drop trigger "${name}"`)
 t.pragma('foreign_keys=OFF');t.pragma('ignore_check_constraints=ON');t.prepare(`update platform_business_observation set ${field}=? where id=?`).run(field==='key_source'?'relation_key':['input_fingerprint','projection_rule_version'].includes(field)?'drift':999,r.observationId);t.pragma('foreign_keys=ON')
 try{verifyFingerprint(t,{observationId:r.observationId,collectionId:1,relationAlias:r.relationAlias});expect.fail('must reject drift')}catch(e){expect(e).toMatchObject({kind:'platform_relation',ref:'relation:'+r.relationAlias,field:'relations',code:['key_source','record_id','version_id'].includes(field)?'projection_mapping_conflict':'projection_source_drift'})}t.close()
})
it('extra own keys and omitted versus null position remain distinct captured input bytes',()=>{
 const inputs=[input,{...input,assignment:{...assignment,extra:'X'}},{...input,position:{...input.position,pageId:null,pageRowNo:null}}]
 const bytes=inputs.map(args=>{const {t,db}=fresh();const r=writeApplyTarget(db,args);expect(()=>verifyFingerprint(t,{observationId:r.observationId,collectionId:1,relationAlias:r.relationAlias})).not.toThrow();const row=t.prepare('select hex(bytes) bytes from platform_archive_value a join platform_observation_fingerprint_basis b on a.id=b.input_archive_id where observation_id=?').get(r.observationId) as {bytes:string};t.close();return row.bytes})
 expect(new Set(bytes).size).toBe(3)
})
it('revision1 drift rejects while its archive still has the original digest',()=>{
 const {t,db}=fresh();const r=writeApplyTarget(db,input);const triggers=t.prepare("select name from sqlite_schema where type='trigger' and tbl_name='platform_observation_assignment'").all() as {name:string}[];for(const {name} of triggers)t.exec(`drop trigger "${name}"`)
 t.prepare("update platform_observation_assignment set basis='drift' where observation_id=?").run(r.observationId)
 expect(()=>verifyFingerprint(t,{observationId:r.observationId,collectionId:1,relationAlias:r.relationAlias})).toThrow(/revision1/);t.close()
})

import { readFileSync } from 'node:fs'
import { writeNewCollectionTarget, type NewCollectionTargetCommand } from '../lib/platform/collection-target-command'
it.each(['queryList','businessList','queryBusList'])('full %s command preserves research literal A/B hashes and canonical input presence',source=>{
 const original=JSON.parse(readFileSync(new URL('./fixtures/fingerprint-capture/'+source+'.json',import.meta.url),'utf8')) as {a:NewCollectionTargetCommand,b:NewCollectionTargetCommand,bytesA:string,bytesB:string}
 for(const [key,wanted] of [['a','5787a3cae365a8bb0632230f801aefa5fa16676a0a3c5d978239eeec78aad45b'],['b','29ad6f09680c20070d3dbc05f69c8ae09a069ab16bc40bbe2fb351cc497be73d']] as const) {
  const {t}=fresh();
  // Independent empty target keeps the original command's collection/page IDs = 1.
  const empty=emptyFingerprintTarget(t);t.close();const db=drizzle(empty,{schema:targetSchema})
  empty.exec("insert into title(code,name_zh,level,rank) values('specialized_sme','specialized','municipal',2)")
  const result=writeNewCollectionTarget(db,original[key]),o=result.observations[0]!
  expect(empty.prepare('select input_fingerprint hash from platform_business_observation').get()).toEqual({hash:wanted})
  expect(verifyFingerprint(empty,{observationId:o.observationId,collectionId:result.collectionId,relationAlias:o.relationAlias}).scheme).toBe('target-command-v1')
  const row=empty.prepare('select cast(bytes as text) bytes from platform_archive_value a join platform_observation_fingerprint_basis b on a.id=b.input_archive_id').get() as {bytes:string}
  expect(row.bytes).toBe(key==='a'?original.bytesA:original.bytesB)
  expect(Object.hasOwn(JSON.parse(row.bytes).assignment,'commandReceiptId')).toBe(key==='b');empty.close()
 }
})
import { emptyFingerprintTarget } from '../lib/platform/fingerprint-verifier'
it('outer COMMIT rejects orphan captured basis after successful nested RELEASE; explicit rollback restores bytes',()=>{
 const {t,db}=fresh();const before=t.serialize();t.exec('BEGIN;SAVEPOINT nested')
 captureFingerprintBasis(db,999,'target-command-v1',Buffer.from('{}'));t.exec('RELEASE nested');expect(()=>t.exec('COMMIT')).toThrow(/FOREIGN KEY/);t.exec('ROLLBACK');expect(t.serialize()).toEqual(before);t.close()
})
import { captureFingerprintBasis } from '../lib/platform/fingerprint-capture'
it('FK OFF rejects command bootstrap and basis helper before any write',()=>{
 const {t,db}=fresh();t.pragma('foreign_keys=OFF');const before=t.serialize()
 for(const outer of [false,true]){if(outer)t.exec('BEGIN');expect(()=>writeNewCollectionTarget(db,{queryText:'{}',evidenceText:null,createdAt:'c',assignments:[]})).toThrow(/foreign_keys/);expect(()=>bootstrapFingerprint(t,{observationId:11,collectionId:1,relationAlias:11},'ordinary')).toThrow(/foreign_keys/);expect(()=>captureFingerprintBasis(db,999,'target-command-v1',Buffer.from('{}'))).toThrow(/foreign_keys/);if(outer)t.exec('ROLLBACK');expect(t.serialize()).toEqual(before)}t.close()
})

it.each(['apply_list','business_list','recognized_list'])('ordinary %s bootstrap preserves SQL NULL text-null malformed primitive array and object input',source=>{
 const {t}=fresh();const query=sourceId(source)
 for(let i=0;i<6;i++) {
  const id=100+(query-1)*6+i,owner={observationId:id,collectionId:query,relationAlias:id}
  const before=t.prepare('select indexed_at,input_fingerprint from platform_business_observation where id=?').get(id)
  expect(before).toEqual({indexed_at:null,input_fingerprint:null})
  expect(bootstrapFingerprint(t,owner,'ordinary')?.scheme).toBe('legacy-bootstrap-v1')
  expect(verifyFingerprint(t,owner).scheme).toBe('legacy-bootstrap-v1')
  const bytes=(t.prepare('select cast(bytes as text) bytes from platform_archive_value a join platform_observation_fingerprint_basis b on a.id=b.input_archive_id where observation_id=?').get(id) as {bytes:string}).bytes
  expect(JSON.parse(bytes).invalidRaw).toBe(i===1?'null':i===2?'bad':null)
 }
 expect(t.pragma('foreign_key_check')).toEqual([]);t.close()
})
it.each(['uncaptured','unknown','missing-basis','missing-archive','wrong-owner','source-projection'])('refuses %s without certifying archive self-hash',fault=>{
 const {t,db}=fresh();const r=writeApplyTarget(db,input),owner={observationId:r.observationId,collectionId:1,relationAlias:r.relationAlias}
 const triggers=t.prepare("select name from sqlite_schema where type='trigger' and tbl_name in ('platform_observation_fingerprint_basis','platform_archive_value','platform_apply_projection')").all() as {name:string}[];for(const {name} of triggers)t.exec(`drop trigger "${name}"`)
 t.pragma('foreign_keys=OFF');t.pragma('ignore_check_constraints=ON')
 if(fault==='uncaptured')t.prepare("update platform_observation_fingerprint_basis set scheme='uncaptured',input_archive_id=null where observation_id=?").run(r.observationId)
 if(fault==='unknown')t.prepare("update platform_observation_fingerprint_basis set scheme='unknown' where observation_id=?").run(r.observationId)
 if(fault==='missing-basis')t.prepare('delete from platform_observation_fingerprint_basis where observation_id=?').run(r.observationId)
 if(fault==='missing-archive')t.prepare('delete from platform_archive_value where id=(select input_archive_id from platform_observation_fingerprint_basis where observation_id=?)').run(r.observationId)
 if(fault==='source-projection')t.prepare('delete from platform_apply_projection where observation_id=?').run(r.observationId)
 t.pragma('foreign_keys=ON')
 expect(()=>verifyFingerprint(t,fault==='wrong-owner'?{...owner,collectionId:2}:owner)).toThrow();t.close()
})
it('rejects undefined and non-plain prototype input without leaving any facts',()=>{
 const {t,db}=fresh();const before=t.serialize()
 expect(()=>writeApplyTarget(db,{...input,assignment:{...assignment,recordedAt:undefined}})).toThrow('platform_raw_not_json')
 const row=Object.assign(Object.create({extra:'inherited'}),input.row)
 expect(()=>writeApplyTarget(db,{...input,row})).toThrow('platform_raw_not_json');expect(t.serialize()).toEqual(before);t.close()
})
import { insertArchiveValue, bindArchive, sealArchiveOwner, allocateLegacyAlias, reserveLegacyIds, bindLegacyAlias, writeOwnerArchive } from '../lib/platform/target-archive'
it('all successor archive and alias write helpers reject FK OFF before mutations in outer transactions',()=>{
 const {t,db}=fresh();t.pragma('foreign_keys=OFF');const before=t.serialize()
 const calls=[()=>insertArchiveValue(db,{storageClass:'blob',bytes:Buffer.from('{}'),createdAt:null}),()=>bindArchive(db,{kind:'observation',ownerId:11,field:'rawFields',archiveId:1}),()=>sealArchiveOwner(db,{kind:'observation',ownerId:11}),()=>allocateLegacyAlias(db,{kind:'relation',observationId:11}),()=>reserveLegacyIds(db,{query:9,relation:999}),()=>bindLegacyAlias(db,{kind:'relation',oldId:999,observationId:11}),()=>writeOwnerArchive(db,{kind:'observation',ownerId:11,field:'rawFields'},{storageClass:'null',bytes:null,createdAt:null})]
 for(const outer of [false,true]){if(outer)t.exec('BEGIN');for(const call of calls)expect(call).toThrow(/foreign_keys/);if(outer)t.exec('ROLLBACK');expect(t.serialize()).toEqual(before)}t.close()
})
it.each(['platform_observation_fingerprint_basis','platform_observation_assignment','platform_legacy_relation_alias'])('full command caller-caught %s failure rolls collection pages archives and sequences back',table=>{
 const {t}=fresh();const empty=emptyFingerprintTarget(t);t.close();const db=drizzle(empty,{schema:targetSchema})
 const original=JSON.parse(readFileSync(new URL('./fixtures/fingerprint-capture/queryList.json',import.meta.url),'utf8')).a as NewCollectionTargetCommand
 empty.exec(`create trigger inject before insert on ${table} begin select raise(abort,'injected command');end`);const before=empty.serialize();empty.exec('BEGIN')
 expect(()=>writeNewCollectionTarget(db,original)).toThrow('injected command');expect(empty.serialize()).toEqual(before);empty.exec('ROLLBACK');expect(empty.serialize()).toEqual(before);empty.close()
})
it('exports physical schema catalog with eight archive owners and valid deferred pairs',()=>{
 const {t,db}=fresh();writeApplyTarget(db,input)
 const catalog=t.prepare("select type,name,tbl_name,sql from sqlite_schema where sql is not null order by type,name").all()
 expect(fingerprintArchiveInventory(t)).toHaveLength(8);expect(t.pragma('foreign_key_check')).toEqual([]);expect(t.pragma('integrity_check')).toEqual([{integrity_check:'ok'}])
 writeFileSync(join(evidence,'CAPTURE-SCHEMA-CATALOG.json'),JSON.stringify({phase:t.pragma('user_version',{simple:true}),catalog,inventory:fingerprintArchiveInventory(t),foreignKeys:t.pragma('foreign_key_check'),integrity:t.pragma('integrity_check')},null,2));t.close()
})
import { writeFileSync } from 'node:fs'
import { fingerprintArchiveInventory } from '../upgrade/fingerprint-basis'
it.each(['platform_observation_fingerprint_basis','platform_business_observation'])('ordinary bootstrap caller-caught %s failure restores original not_indexed facts and archive highwater',table=>{
 const {t}=fresh();t.exec(`create trigger inject before ${table==='platform_business_observation'?'update':'insert'} on ${table} begin select raise(abort,'bootstrap injected');end`)
 const before=t.serialize();t.exec('BEGIN');expect(()=>bootstrapFingerprint(t,{observationId:105,collectionId:1,relationAlias:105},'ordinary')).toThrow('bootstrap injected');expect(t.serialize()).toEqual(before);t.exec('ROLLBACK');expect(t.serialize()).toEqual(before);t.close()
})
it('bootstrap classifies independently of collection request presence',()=>{
 const {t,db}=fresh();
 // A controlled legal collection with copied original owners; request is sealed before use.
 const old=db.select().from(targetSchema.platformCollection).all().find(c=>c.id===1)!
 db.insert(targetSchema.platformCollection).values({...old,id:9,queryKey:'request-bearing'}).run()
 // Coordinate cells retain original query alias 1. Copy source rows into this owner in
 // a controlled fixture, with a new complete cells envelope for its explicit alias.
 const o=db.select().from(targetSchema.platformBusinessObservation).all().find(o=>o.id===11)!
 db.insert(targetSchema.platformBusinessObservation).values({...o,id:999,collectionId:9}).run()
 db.insert(targetSchema.platformLegacyQueryAlias).values({oldId:9,collectionId:9}).run();db.insert(targetSchema.platformLegacyRelationAlias).values({oldId:999,observationId:999}).run()
 const refs=db.select().from(targetSchema.platformObservationArchiveRef).all().filter(r=>r.ownerId===11)
 for(const r of refs){const a=db.select().from(targetSchema.platformArchiveValue).all().find(a=>a.id===r.archiveId)!
  let bytes=a.bytes
  if(r.field==='legacyRowSnapshot'){const snapshot=JSON.parse(bytes!.toString());for(const c of snapshot.fields){if(c.name==='id')c.hex=Buffer.from('999').toString('hex').toUpperCase();if(c.name==='query_id')c.hex=Buffer.from('9').toString('hex').toUpperCase()}bytes=Buffer.from(JSON.stringify(snapshot))}
  const id=insertArchiveValue(db,a.storageClass==='null'?{storageClass:'null',bytes:null,createdAt:null}:{storageClass:a.storageClass,bytes:bytes!,createdAt:null});bindArchive(db,{kind:'observation',ownerId:999,field:r.field,archiveId:id})
 }
 sealArchiveOwner(db,{kind:'observation',ownerId:999})
 const raw=db.select().from(targetSchema.platformObservationArchiveRef).all().find(r=>r.ownerId===999&&r.field==='rawFields')!
 const p=db.select().from(targetSchema.platformApplyProjection).all().find(p=>p.observationId===11)!;const {id:_,...fields}=p;db.insert(targetSchema.platformApplyProjection).values({...fields,observationId:999,sourceArchiveId:raw.archiveId}).run()
 const request=insertArchiveValue(db,{storageClass:'text',bytes:Buffer.from('{"request":"present"}'),createdAt:null});bindArchive(db,{kind:'collection',ownerId:9,field:'request',archiveId:request});sealArchiveOwner(db,{kind:'collection',ownerId:9})
 expect(bootstrapFingerprint(t,{observationId:999,collectionId:9,relationAlias:999},'ordinary')?.scheme).toBe('legacy-bootstrap-v1');t.close()
})
it('successor archive helper refuses unsafe ID and rolls back insertion/highwater even when caller catches',()=>{
 const {t,db}=fresh();t.exec("update sqlite_sequence set seq=9007199254740991 where name='platform_archive_value'");const before=t.serialize()
 t.exec('BEGIN');expect(()=>insertArchiveValue(db,{storageClass:'blob',bytes:Buffer.from('{}'),createdAt:null})).toThrow('Invalid archive identity');expect(t.serialize()).toEqual(before);t.exec('ROLLBACK');expect(t.serialize()).toEqual(before);t.close()
})
