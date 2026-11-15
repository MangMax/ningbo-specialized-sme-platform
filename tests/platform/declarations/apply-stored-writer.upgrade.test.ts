import Database from 'better-sqlite3'
import { expect,it } from 'vitest'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { copyFileSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { upgradeCollections } from '../../../upgrade/collections'
import { upgradeObservations } from '../../../upgrade/observations'
import { upgradeProjections } from '../../../upgrade/projections'
import { finalizeObservations, finalizeCollectionScopes } from '../../../upgrade/finalize-observations'
import { finalizeFingerprintBasis } from '../../../upgrade/fingerprint-basis'
import { finalizeApplyStored } from '../../../upgrade/apply-stored'
function fixture() {
 const root=mkdtempSync(join(process.env.APPLY_STORED_EVIDENCE_DIR??tmpdir(),'apply-stored-'))
 const legacy=join(root,'legacy.sqlite'),target=join(root,'target.sqlite'),source=join(root,'71607.sqlite')
 const s=new Database(legacy);migrate(drizzle(s),{migrationsFolder:'db/migrations'})
 s.exec(`INSERT INTO platform_query(id,interface,query_key,rdjb,queried_at,status,created_at) VALUES(1,'apply_list','Q','2','t','success','c');
 INSERT INTO platform_relation(id,query_id,sequence_no,status,raw_fields,created_at) VALUES(1,1,1,' pending ','{"rdjb":"2","rdjb":"3","cszt":"pending"}','c'),(2,1,2,'pending','{"rdjb":"1","rdjb":"3","cszt":"pending"}','c');
 UPDATE platform_relation SET title_raw='X';`)

 s.close();copyFileSync(legacy,target)
 upgradeCollections({source:legacy,target,runId:'collections',batchSize:10})
 upgradeObservations({source:legacy,target,runId:'observations',collectionRunId:'collections',batchSize:10})
 upgradeProjections({source:legacy,target,runId:'projections',observationRunId:'observations',collectionRunId:'collections',batchSize:10})
 const opts={source:legacy,target,runId:'final',projectionRunId:'projections',observationRunId:'observations',collectionRunId:'collections'}
 finalizeObservations(opts);finalizeCollectionScopes({...opts,runId:'scopes',finalizationRunId:'final'})
 const p=join(root,'71606.sqlite');copyFileSync(target,p)
 finalizeFingerprintBasis({source:p,target,runId:'basis',predecessorRunId:'scopes',legacySource:legacy})
 copyFileSync(target,source)
 return {source,target,legacySource:legacy,runId:'stored',predecessorRunId:'basis'}
}

import { targetSchema } from '../../../upgrade/target-schema'
import { writeApplyTarget, type ApplyTargetInput } from '../../../upgrade/frozen/apply-target-writer'
import { verifyFingerprint } from '../../../upgrade/frozen/fingerprint-verifier'
import { createHash } from 'node:crypto'
function ready(){const f=fixture();finalizeApplyStored(f);const t=new Database(f.target);t.pragma('foreign_keys=ON');return {f,t,db:drizzle(t,{schema:targetSchema})}}
function input():ApplyTargetInput{return {collectionId:1,position:{sequenceNo:3,positionState:'unknown'},row:{sequenceNo:3,relationKey:' K ',status:' pending ',declareKind:'申请',year:2024,nameRaw:' Old ',usccRaw:' U ',rawFields:{rdjb:' 2 ',cszt:'pending'}},assignment:{nameRaw:'Old',usccRaw:'U',matchBasis:'none',verificationStatus:'pending',origin:'command',actor:{type:'agent',id:'W'},basis:'explicit'}}}
it('71608 direct writer captures literal legacy materialization and preserves original canonical bytes',()=>{
 const {t,db}=ready();const v=input(),r=writeApplyTarget(db,v)
 expect(t.prepare('SELECT exact_status,exact_declare_kind,exact_applied_at,exact_year,exact_title_raw,sql_fact_title,exact_stored_origin FROM platform_apply_projection WHERE observation_id=?').get(r.observationId)).toEqual({exact_status:'pending',exact_declare_kind:'apply',exact_applied_at:null,exact_year:2024,exact_title_raw:'2',sql_fact_title:'2',exact_stored_origin:'command_materialized'})
 const literal='{"assignment":{"actor":{"id":"W","type":"agent"},"basis":"explicit","matchBasis":"none","nameRaw":"Old","origin":"command","usccRaw":"U","verificationStatus":"pending"},"collectionId":1,"position":{"positionState":"unknown","sequenceNo":3},"row":{"declareKind":"申请","nameRaw":" Old ","rawFields":{"cszt":"pending","rdjb":" 2 "},"relationKey":" K ","sequenceNo":3,"status":" pending ","usccRaw":" U ","year":2024}}'
 expect(t.prepare('SELECT cast(a.bytes AS TEXT) bytes,o.input_fingerprint hash,o.source_relation_key key FROM platform_business_observation o JOIN platform_observation_fingerprint_basis b ON b.observation_id=o.id JOIN platform_archive_value a ON a.id=b.input_archive_id WHERE o.id=?').get(r.observationId)).toEqual({bytes:literal,hash:createHash('sha256').update(literal).digest('hex'),key:'K'})
 expect(()=>verifyFingerprint(t,{observationId:r.observationId,collectionId:1,relationAlias:r.relationAlias})).not.toThrow()
 const before=t.serialize();expect(writeApplyTarget(db,v).reused).toBe(true);expect(t.serialize().equals(before), 'database bytes remain unchanged').toBe(true);t.close()
})
import { writeCollectionTarget, type NewCollectionTargetCommand } from '../../../upgrade/frozen/collection-target-command'
function command():NewCollectionTargetCommand{return {queryText:JSON.stringify({interface:'apply_list',queryKey:'new',queriedAt:'time',status:'success',rawResponse:'{}',relations:[{sequenceNo:1,status:' pending ',declareKind:'申请',rawFields:{rdjb:' 2 ',cszt:'pending',year:'2e3'}}]}),evidenceText:null,createdAt:'creation',assignments:[{matchBasis:'none',verificationStatus:'pending',origin:'command',actor:{type:'agent',id:'W'},basis:'explicit'}]}}
function fileBytes(t:Database.Database){const b=t.serialize();for(const offset of [24,92])b.fill(0,offset,offset+4);return b}
it('71608 full command ordinary and explicit reference authenticate literal materialization without writes',()=>{
 const {t,db}=ready(),c=command(),r=writeCollectionTarget(db,c)
 expect(t.prepare('SELECT exact_status,exact_declare_kind,exact_year,exact_title_raw,sql_fact_title,declaration_year FROM platform_apply_projection WHERE observation_id=?').get(r.observations[0]!.observationId)).toEqual({exact_status:'pending',exact_declare_kind:'apply',exact_year:2000,exact_title_raw:'2',sql_fact_title:'2',declaration_year:null})
 const before=fileBytes(t)
 expect(writeCollectionTarget(db,c).reused).toBe(true)
 const q=JSON.parse(c.queryText);q.reuseExisting=true;delete q.rawResponse;delete q.status;q.relations=[{sequenceNo:1}]
 expect(writeCollectionTarget(db,{...c,queryText:JSON.stringify(q),assignments:[]}).reused).toBe(true)
 expect(fileBytes(t)).toEqual(before);t.close()
})
it.each(['omit','null','blank'] as const)('71608 direct materialization preserves own-key fingerprint distinction %s',mode=>{
 const {t,db}=ready(),v=input();v.row={sequenceNo:3,...(mode==='omit'?{}:mode==='null'?{status:null,rawFields:null}:{status:' \t ',appliedAt:' ',declareKind:' ',rawFields:{rdjb:' \t '}})};v.assignment={...v.assignment,nameRaw:null,usccRaw:null}
 const r=writeApplyTarget(db,v)
 expect(t.prepare('SELECT exact_status,exact_declare_kind,exact_applied_at,exact_year,exact_title_raw,sql_fact_title FROM platform_apply_projection WHERE observation_id=?').get(r.observationId)).toEqual({exact_status:null,exact_declare_kind:null,exact_applied_at:null,exact_year:null,exact_title_raw:null,sql_fact_title:null})
 expect(()=>verifyFingerprint(t,{observationId:r.observationId,collectionId:1,relationAlias:r.relationAlias})).not.toThrow();t.close()
})
it('71608 rejects assignment provenance mismatch and existing REAL year predecessor boundary with zero writes',()=>{
 const {t,db}=ready(),v=input(),before=t.serialize()
 expect(()=>writeApplyTarget(db,{...v,assignment:{...v.assignment,nameRaw:' Old '}})).toThrow(/revision1/)
 expect(()=>writeApplyTarget(db,{...v,row:{...v.row,year:2024.5}})).toThrow(/Unrepresentable legacy process year/)
 expect(t.serialize().equals(before), 'database bytes remain unchanged').toBe(true);t.close()
})
it('71608 same raw different stored input remains distinct and reused input conflict is atomic',()=>{
 const {t,db}=ready(),v=input(),a=writeApplyTarget(db,v),b=writeApplyTarget(db,{...v,position:{...v.position,sequenceNo:4},row:{...v.row,sequenceNo:4,status:'rejected'}})
 expect(t.prepare('SELECT exact_status FROM platform_apply_projection WHERE observation_id IN (?,?) ORDER BY observation_id').all(a.observationId,b.observationId)).toEqual([{exact_status:'pending'},{exact_status:null}])
 const before=t.serialize();expect(()=>writeApplyTarget(db,{...v,row:{...v.row,status:'rejected'}})).toThrow(/conflict/);expect(t.serialize().equals(before), 'database bytes remain unchanged').toBe(true);t.close()
})
it.each(['platform_observation_assignment','platform_observation_archive_ref','platform_apply_projection','platform_legacy_relation_alias','platform_observation_fingerprint_basis'])('71608 caller caught failure rolls back complete savepoint at %s',table=>{
 const {t,db}=ready();t.exec(`CREATE TRIGGER inject BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'injected'); END`);const before=fileBytes(t)
 db.transaction(tx=>{expect(()=>writeApplyTarget(tx,input())).toThrow('injected')});expect(fileBytes(t)).toEqual(before);expect(t.pragma('foreign_key_check')).toEqual([]);t.close()
})
it.each(['FK OFF','observation exhaustion','alias exhaustion'] as const)('71608 %s refuses atomically',mode=>{
 const {t,db}=ready()
 if(mode==='FK OFF')t.pragma('foreign_keys=OFF')
 if(mode==='observation exhaustion')t.exec("DELETE FROM sqlite_sequence WHERE name='platform_business_observation';INSERT INTO sqlite_sequence(name,seq) VALUES('platform_business_observation',9007199254740991)")
 if(mode==='alias exhaustion')t.exec("UPDATE platform_legacy_alias_sequence SET high_water=9007199254740991 WHERE namespace='relation'")
 const before=t.serialize()
 expect(()=>writeApplyTarget(db,input())).toThrow(mode==='FK OFF'?/foreign_keys/:mode==='observation exhaustion'?/identity exhausted/:/Invalid archive identity/)
 expect(t.serialize().equals(before), 'database bytes remain unchanged').toBe(true);t.close()
})

it.each(['projection','title-capture','exact-capture'] as const)('71608 outer COMMIT refuses missing %s after RELEASE',mode=>{
 const {t,db}=ready();t.exec('BEGIN');writeApplyTarget(db,input());t.exec('DROP TRIGGER platform_apply_stored_no_delete; DROP TRIGGER platform_apply_stored_no_update; SAVEPOINT nested')
 if(mode==='projection')t.exec('DELETE FROM platform_apply_projection WHERE observation_id=3')
 else {const column=mode==='title-capture'?'sql_fact_title_state':'exact_stored_state';t.exec('PRAGMA ignore_check_constraints=ON');t.exec(`UPDATE platform_apply_projection SET ${column}='uncaptured' WHERE observation_id=3`)}
 t.exec('RELEASE nested');expect(()=>t.exec('COMMIT')).toThrow(/FOREIGN KEY/);t.exec('ROLLBACK');t.close()
})
it('71608 historical S snapshot ordinary bootstrap and reference retain exact whitespace and duplicate SQL title',()=>{
 const {t,db}=ready(),before=t.serialize()
 const ref={queryText:JSON.stringify({interface:'apply_list',queryKey:'Q',rdjb:'2',queriedAt:'t',reuseExisting:true,relations:[{sequenceNo:1},{sequenceNo:2}]}),evidenceText:null,createdAt:'unused',assignments:[]}
 expect(writeCollectionTarget(db,ref).reused).toBe(true);expect(t.serialize().equals(before), 'database bytes remain unchanged').toBe(true)
 const ordinary={...ref,queryText:JSON.stringify({interface:'apply_list',queryKey:'Q',rdjb:'2',queriedAt:'t',status:'success',relations:[{sequenceNo:1,status:'pending',rawFields:{rdjb:'3',cszt:'pending'}},{sequenceNo:2,status:'pending',rawFields:{rdjb:'3',cszt:'pending'}}]})}
 try{expect(writeCollectionTarget(db,ordinary).reused).toBe(true)}catch(e){throw new Error(JSON.stringify(Reflect.get(e as object,'result')), {cause:e})}
 expect(t.prepare('SELECT exact_status,exact_title_raw,sql_fact_title FROM platform_apply_projection WHERE observation_id IS NOT NULL ORDER BY observation_id').all()).toEqual([{exact_status:' pending ',exact_title_raw:'X',sql_fact_title:'2'},{exact_status:'pending',exact_title_raw:'X',sql_fact_title:'1'}])
 expect(()=>verifyFingerprint(t,{observationId:1,collectionId:1,relationAlias:1})).not.toThrow();expect(t.pragma('foreign_key_check')).toEqual([]);t.close()
})
it('71608 historical S command profile is accepted without changing IDs hashes aliases or time',()=>{
 const f=fixture(),old=new Database(f.target);old.pragma('foreign_keys=ON');const v=input();v.row={...v.row,relationKey:'K'};const r=writeApplyTarget(drizzle(old,{schema:targetSchema}),v);const facts=old.prepare('SELECT id,input_fingerprint,indexed_at,source_relation_key FROM platform_business_observation WHERE id=?').get(r.observationId);old.close();copyFileSync(f.target,f.source);finalizeApplyStored(f)
 const t=new Database(f.target);t.pragma('foreign_keys=ON');expect(()=>verifyFingerprint(t,{observationId:r.observationId,collectionId:1,relationAlias:r.relationAlias})).not.toThrow();expect(t.prepare('SELECT id,input_fingerprint,indexed_at,source_relation_key FROM platform_business_observation WHERE id=?').get(r.observationId)).toEqual(facts);t.close()
})
it.each(['exact_status','exact_year','sql_fact_title','exact_stored_rule','sql_fact_title_rule','exact_stored_origin','revision1','unrelated-extra','missing'] as const)('71608 command ordinary reference and direct reuse reject drift %s without repair',field=>{
 const {t,db}=ready(),c=command(),r=writeCollectionTarget(db,c),id=r.observations[0]!.observationId
 t.exec('DROP TRIGGER platform_apply_stored_no_update; DROP TRIGGER platform_apply_stored_no_delete; PRAGMA ignore_check_constraints=ON')
 if(field==='revision1'){for(const row of t.prepare("SELECT name FROM sqlite_schema WHERE type='trigger' AND tbl_name='platform_observation_assignment'").all() as {name:string}[])t.exec(`DROP TRIGGER "${row.name}"`)}
 if(field==='missing')t.pragma('foreign_keys=OFF')
 if(field==='revision1')t.prepare("UPDATE platform_observation_assignment SET name_raw='tampered' WHERE observation_id=? AND revision=1").run(id)
 else if(field==='unrelated-extra')t.prepare("UPDATE platform_apply_projection SET parsed_status='tampered' WHERE observation_id=?").run(id)
 else if(field==='missing')t.prepare('DELETE FROM platform_apply_projection WHERE observation_id=?').run(id)
 else t.prepare(`UPDATE platform_apply_projection SET ${field}=? WHERE observation_id=?`).run(field==='exact_year'?2025:'tampered',id)
 t.pragma('foreign_keys=ON');const before=t.serialize();expect(()=>writeCollectionTarget(db,c)).toThrow()
 const q=JSON.parse(c.queryText);q.reuseExisting=true;delete q.rawResponse;delete q.status;q.relations=[{sequenceNo:1}];expect(()=>writeCollectionTarget(db,{...c,queryText:JSON.stringify(q),assignments:[]})).toThrow();expect(t.serialize().equals(before), 'database bytes remain unchanged').toBe(true);t.close()
})
it('71608 revision2 changes current attribution without altering original command authentication',()=>{
 const {t,db}=ready(),v=input(),r=writeApplyTarget(db,v)
 t.prepare("INSERT INTO platform_observation_assignment(observation_id,revision,name_raw,uscc_raw,match_basis,verification_status,origin,actor,basis) VALUES(?,2,'New','NEW','none','pending','command','{\"type\":\"agent\",\"id\":\"W\"}','correction')").run(r.observationId)
 expect(()=>verifyFingerprint(t,{observationId:r.observationId,collectionId:1,relationAlias:r.relationAlias})).not.toThrow();t.close()
})
it('71607 direct writer remains compatible and 71608 catalog stays unchanged during writes',()=>{
 const f=fixture(),t=new Database(f.target);t.pragma('foreign_keys=ON');const v=input();const r=writeApplyTarget(drizzle(t,{schema:targetSchema}),v);expect(t.prepare('SELECT source_relation_key FROM platform_business_observation WHERE id=?').get(r.observationId)).toEqual({source_relation_key:' K '});expect(()=>verifyFingerprint(t,{observationId:r.observationId,collectionId:1,relationAlias:r.relationAlias})).not.toThrow();t.close()
 const readyDb=ready();const catalog=readyDb.t.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all();writeApplyTarget(readyDb.db,input());expect(readyDb.t.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all()).toEqual(catalog);expect(readyDb.t.pragma('integrity_check',{simple:true})).toBe('ok');readyDb.t.close()
})
it.each(['exact_status','exact_declare_kind','exact_applied_at','exact_year','exact_title_raw','sql_fact_title','exact_stored_rule','sql_fact_title_rule','exact_stored_origin','revision1'] as const)('71608 historical sealed source rejects independent cell drift %s including unindexed reference',field=>{
 const {t,db}=ready();t.exec('DROP TRIGGER platform_apply_stored_no_update; PRAGMA ignore_check_constraints=ON; DROP TRIGGER platform_assignment_no_update')
 if(field==='revision1')t.exec("UPDATE platform_observation_assignment SET name_raw='wrong' WHERE observation_id=1 AND revision=1")
 else t.prepare(`UPDATE platform_apply_projection SET ${field}=? WHERE observation_id=1`).run(field==='exact_year'?2026:'wrong')
 const before=t.serialize(),ref={queryText:JSON.stringify({interface:'apply_list',queryKey:'Q',rdjb:'2',queriedAt:'t',reuseExisting:true,relations:[{sequenceNo:1}]}),evidenceText:null,createdAt:'unused',assignments:[]}
 expect(()=>writeCollectionTarget(db,ref)).toThrow();expect(t.serialize().equals(before), 'database bytes remain unchanged').toBe(true);t.close()
})
it('71608 uncaptured states are refused without replay supplementation',()=>{
 const {t,db}=ready();t.exec("DROP TRIGGER platform_apply_stored_no_update; PRAGMA ignore_check_constraints=ON; PRAGMA foreign_keys=OFF; UPDATE platform_apply_projection SET exact_stored_state='uncaptured' WHERE observation_id=1; PRAGMA foreign_keys=ON")
 const before=t.serialize();expect(()=>writeCollectionTarget(db,{queryText:JSON.stringify({interface:'apply_list',queryKey:'Q',rdjb:'2',queriedAt:'t',reuseExisting:true,relations:[{sequenceNo:1}]}),evidenceText:null,createdAt:'unused',assignments:[]})).toThrow();expect(t.serialize().equals(before), 'database bytes remain unchanged').toBe(true);t.close()
})
it('71608 direct reuse authenticates exact cells and original rev1 while new ID reaches the last safe integer',()=>{
 const {t,db}=ready(),v=input(),r=writeApplyTarget(db,v)
 t.exec('DROP TRIGGER platform_apply_stored_no_update');t.prepare("UPDATE platform_apply_projection SET exact_status='tampered' WHERE observation_id=?").run(r.observationId);const before=t.serialize();expect(()=>writeApplyTarget(db,v)).toThrow();expect(t.serialize().equals(before), 'database bytes remain unchanged').toBe(true)
 t.exec("DELETE FROM sqlite_sequence WHERE name='platform_business_observation';INSERT INTO sqlite_sequence(name,seq) VALUES('platform_business_observation',9007199254740990)")
 expect(writeApplyTarget(db,{...v,position:{...v.position,sequenceNo:4},row:{...v.row,sequenceNo:4}}).observationId).toBe(Number.MAX_SAFE_INTEGER);expect(t.pragma('foreign_key_check')).toEqual([]);t.close()
})
