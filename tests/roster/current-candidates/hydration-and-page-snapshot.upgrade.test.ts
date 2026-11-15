import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { beforeAll, expect, it, vi } from 'vitest'
import { chmodSync, copyFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as schema from '../../../db/schema'
import { targetSchema } from '../../../lib/platform/target-schema'
import { createTargetCurrentCandidateReader } from '../../../lib/roster/current-candidates-target'
import { createTargetRecognizedWitnessReader } from '../../../lib/roster/recognized-witness-target'
import { createCurrentQualificationAssessmentReader, createCurrentQualificationAssessmentReaderWithWitnesses } from '../../../lib/roster/current-qualification'
import { CURRENT_TITLES } from '../../../lib/roster/current-titles'
import { normalizeUscc } from '../../../lib/domain'
import { currentCandidateBindings, currentCandidateSql } from '../../../upgrade/frozen/current-candidates'
import { qualificationMatrix } from '../fixtures/qualification-matrix'
import { commitRosterImport } from '../../../server/utils/roster-import'
import { platformResultToImport } from '../../../lib/platform/recognized-evidence'
import type { PlatformLiveQueryResult } from '../../../lib/platform/live-query'
import { preflightRecordCorrespondences, commitRecordCorrespondences } from '../../../server/utils/record-correspondence'
import { reserveLegacyIds } from '../../../lib/platform/target-archive'
import { readDifferencePlatformEffectsByTitle } from '../../../lib/roster/difference-platform-effects'
import { createHash } from 'node:crypto'
import { serialize } from 'node:v8'

const fixtures=process.env.CURRENT_TARGET_762_FIXTURES, evidence=process.env.CURRENT_TARGET_762_EVIDENCE
if(!fixtures||!evidence)throw new Error('Set private CURRENT_TARGET_762_FIXTURES and CURRENT_TARGET_762_EVIDENCE')
const root=mkdtempSync(join(evidence,'readers762-')), at=Date.parse('2026-12-01T00:00:00Z')
const targetBase=join(root,'target-base.sqlite'), oldBase=join(root,'old-base.sqlite')
function copy(from:string,to:string){copyFileSync(from,to);chmodSync(to,0o600)}
beforeAll(()=>{
 copy(join(fixtures,'baseline71613.sqlite'),targetBase);copy(join(fixtures,'baseline0.sqlite'),oldBase)
 const t=new Database(targetBase),old=new Database(oldBase)
 // Physical retirement is a test condition on this owned copy only. Runtime
 // readers have no DROP, migration, repair or schema-change responsibility.
 t.pragma('foreign_keys=OFF');t.exec('DROP TABLE platform_relation; DROP TABLE platform_query');t.pragma('foreign_keys=ON')
 // Enrich once through the real import/source writers on the completed chain,
 // then COPY this one baseline per case. No per-case migration or fake reader.
 reserveLegacyIds(drizzle(t,{schema:targetSchema}),{query:9000,relation:10000})
 old.prepare("update sqlite_sequence set seq=9000 where name='platform_query'").run()
 old.prepare("update sqlite_sequence set seq=10000 where name='platform_relation'").run()
 for(const connection of [t,old]){
  const m=qualificationMatrix(connection)
  m.formal('Alpha',[{eventType:'award',year:2025,decidedYear:2025,batchSeq:1}],{enterpriseId:760,title:'little_giant'})
  m.formal('Alpha',[{eventType:'award',year:2025,decidedYear:2025,batchSeq:1}],{enterpriseId:760,title:'innovative_sme'})
  connection.exec("insert into enterprise(id,name,name_norm,uscc_norm) values(761,'Other','Other','U761'),(762,'Duplicate','Duplicate',' u761 ')")
 }
 for(const [index,title] of CURRENT_TITLES.entries()){
  const rdjb=({little_giant:'3',specialized_sme:'2',innovative_sme:'1'} as const)[title]
  const raw={id:`recognized762-${title}`,rdjb,qymc:'Alpha',tyshxydm:'9133020078041158X6',rddqrq:'2028-12-31',whpcyear:'2026',whpc:'2026-2'}
  const result:PlatformLiveQueryResult={source:'queryBusList',status:'success',queriedAt:`2026-11-13T00:00:0${index}Z`,completedAt:'2026-11-13T00:01:00Z',effectiveConditions:{uscc:'9133020078041158X6',combination:'and'},titleScope:{mode:'selected',rdjb:[rdjb]},rows:[raw,raw],dataRows:[raw,raw],
   pages:[{source:'queryBusList',rdjb,page:1,maxPage:1,fetchedCount:2,declaredTotal:2,status:'success',error:null}],fetchedCount:2,declaredTotal:2,completeness:'complete',fullRange:true,unfinished:[],error:null,limits:{maxRequests:10,maxRows:100,maxDurationMs:1000,pageSize:50}}
  for(const connection of [t,old]){
   const db=drizzle(connection,{schema})
   const request={idempotencyKey:`762-${title}`,sourceKind:'platform_archive' as const,sourceIdentity:'synthetic762',payload:{platformQueries:[platformResultToImport(result)]}}
   expect(commitRosterImport(db,request,[],{deferCandidateTasks:true}).status).toBe('committed')
   const event=connection.prepare('select e.id from record_event e join record r on r.id=e.record_id where r.enterprise_id=760 and r.title_code=? and e.event_type=? order by e.id limit 1').get(title,'award') as {id:number}
   const relationId=10001+index*2
   const link={idempotencyKey:`762-link-${title}`,sourceIdentity:'synthetic762',actor:{type:'agent' as const,id:'762'},basis:'synthetic link',ruleId:'manual',ruleVersion:'1',operations:[{action:'create' as const,status:'confirmed' as const,edge:{type:'event_recognized' as const,eventId:event.id,relationId,role:'recognized_corrob' as const}}]}
   const plan=preflightRecordCorrespondences(db,link);commitRecordCorrespondences(db,link,plan.planHash)
  }
 }
 const mixedRows=[1,2].map(id=>({id:`mixed762-${id}`,rdjb:'1',qymc:'Alpha',tyshxydm:'9133020078041158X6',cszt:'终审通过',year:'2024'}))
 const mixed:PlatformLiveQueryResult={source:'businessList',status:'success',queriedAt:'2026-11-13T01:00:00Z',completedAt:'2026-11-13T01:01:00Z',effectiveConditions:{uscc:'9133020078041158X6',combination:'and'},titleScope:{mode:'selected',rdjb:['1','2','3']},rows:mixedRows,dataRows:mixedRows,
  pages:['1','2','3'].map(rdjb=>({source:'businessList',rdjb,page:1,maxPage:1,fetchedCount:rdjb==='1'?0:1,declaredTotal:rdjb==='1'?0:1,status:'success' as const,error:null})),fetchedCount:2,declaredTotal:2,completeness:'complete',fullRange:true,unfinished:[],error:null,limits:{maxRequests:10,maxRows:100,maxDurationMs:1000,pageSize:50}}
 for(const connection of [t,old])expect(commitRosterImport(drizzle(connection,{schema}),{idempotencyKey:'762-mixed',sourceKind:'platform_archive',sourceIdentity:'synthetic762',payload:{platformQueries:[platformResultToImport(mixed)]}},[],{deferCandidateTasks:true}).status).toBe('committed')
 t.close();old.close()
})
function fixture(){
 const dir=mkdtempSync(join(root,'case-')),path=join(dir,'target.sqlite');copy(targetBase,path)
 const trace:string[]=[],t=new Database(path,{verbose:q=>trace.push(String(q))}),old=new Database(oldBase,{readonly:true})
 t.pragma('foreign_keys=ON');t.function('roster84_uscc',{deterministic:true},normalizeUscc);old.function('roster84_uscc',{deterministic:true},normalizeUscc)
 const db=drizzle(t,{schema:targetSchema})
 return {t,old,db,path,dir,trace,close(){old.close();t.close()}}
}
it('composes real completed71613 candidate iterator count page and full current workbook hydration against schema0 and literal cells',()=>{
 const f=fixture()
 try{
  expect(f.t.pragma('user_version',{simple:true})).toBe(71613)
  expect(f.t.prepare("select name from sqlite_master where name in ('platform_query','platform_relation')").all()).toEqual([])
  const candidates=createTargetCurrentCandidateReader(f.db),reader=createCurrentQualificationAssessmentReaderWithWitnesses(f.t,createTargetRecognizedWitnessReader(f.db)),old=createCurrentQualificationAssessmentReader(f.old)
  const before=f.t.prepare('select total_changes() n').get(),cells=cellDigest(f.t)
  f.trace.length=0
  for(const title of CURRENT_TITLES){
   const literal=[{id:760}]
   expect(f.old.prepare(`select id from (${currentCandidateSql}) order by id`).all(currentCandidateBindings(title))).toEqual(literal)
   expect([...candidates.iterate(title)]).toEqual(literal);expect(candidates.count(title)).toBe(literal.length);expect(candidates.page(title,0,10)).toEqual({total:literal.length,rows:literal})
   const current=reader.readCurrent(760,at,title),workbook=reader.readWorkbook(760,at,title)
   expect(current).toEqual(old.readCurrent(760,at,title));expect(workbook).toEqual(old.readWorkbook(760,at,title))
   expect(current.snapshot.assessmentVersion).toBe('enterprise-qualification-687-v4');expect(current.snapshot.ruleVersion).toBe('current-roster-116-v11')
   const assessed=current.snapshot.titles.find(t=>t.titleCode==='specialized_sme')!
   const rows=assessed.platform.observations.flatMap(o=>o.rows)
   expect(rows.find(r=>r.relationId===2004)?.status).toEqual(Buffer.from([0,255]))
   expect(rows.find(r=>r.relationId===2018)?.year).toBe(2024)
   expect(current.snapshot.titles.map(t=>t.titleCode)).toEqual(['little_giant','specialized_sme','innovative_sme'])
   expect(current.rows[2]?.group).toBe('eligible')
   expect(current.rows[CURRENT_TITLES.indexOf(title)]?.matchedValidYears).toEqual(title==='innovative_sme'?[2028]:[])
   expect(assessed.versions.observations).toMatch(/^[0-9a-f]{64}$/)
  }
  expect(f.t.prepare('select total_changes() n').get()).toEqual(before)
  expect(cellDigest(f.t)).toBe(cells)
  expect(f.trace.join('\n')).not.toMatch(/\b(?:from|join)\s+["`]?platform_(?:query|relation)["`]?(?=\s|$)/i)
  // Existing correspondence fingerprint revalidation owns original-cell
  // archives. The business effects/candidate seam must never consume them.
  f.trace.length=0
  readDifferencePlatformEffectsByTitle(drizzle(f.t,{schema}),760)
  expect(f.trace.join('\n')).not.toMatch(/\b(?:archive|bytes|json_each)\b/i)
  expect(f.trace.filter(q=>/from "platform_business_observation"/i.test(q))).toHaveLength(1)
  writeFileSync(join(f.dir,'trace.json'),JSON.stringify(f.trace,null,2))
 }finally{f.close()}
})

function corrupt(t:Database.Database,table:string,sql:string){
 // Corruption controls bypass only this case's offline barriers. Readers must
 // reject drift, never repair it or silently produce a smaller candidate set.
 for(const {name} of t.prepare("select name from sqlite_master where type='trigger' and tbl_name=?").all(table) as {name:string}[])t.exec(`DROP TRIGGER "${name}"`)
 t.pragma('ignore_check_constraints=ON');t.exec(sql)
}
it.each([
 ['unfinished_candidate',"update platform_migration_run set state='running' where transform_version='candidate-scope-offline-v1'",'platform_migration_run','Candidate migration incomplete'],
 ['unfinished_successor',"update platform_migration_run set state='running' where transform_version='collection-legacy-provenance-v1'",'platform_migration_run','migration incomplete'],
 ['missing_catalog','alter table platform_business_observation rename column candidate_scope_mask to missing_mask','platform_business_observation','Candidate migration incomplete'],
 ['capture_context_drift',"update platform_business_observation set candidate_scope_rdjb='1' where id=1100",'platform_business_observation','capture_drift'],
 ['capture_rule_drift',"update platform_business_observation set candidate_scope_rule='future-rule' where id=1100",'platform_business_observation','capture_drift'],
 ['missing_capture',"update platform_business_observation set candidate_scope_state='uncaptured' where id=1100",'platform_business_observation','uncaptured'],
 ['missing_assignment','delete from platform_observation_assignment where observation_id=1100','platform_observation_assignment','assignment_missing'],
 ['unknown_phase','pragma user_version=71614','platform_business_observation','Explicit 71609'],
] as const)('rejects completed target drift %s before candidate cursors and leaves no owned transaction',(_label,mutation,table,error)=>{
 const f=fixture()
 try{
  corrupt(f.t,table,mutation);const before=f.t.prepare('select total_changes() n').get(),reader=createTargetCurrentCandidateReader(f.db)
  f.trace.length=0
  expect(()=>[...reader.iterate('specialized_sme')]).toThrow(error)
  expect(()=>reader.count('specialized_sme')).toThrow(error)
  expect(()=>reader.page('specialized_sme',0,10)).toThrow(error)
  expect(f.trace.filter(q=>/\bunion\b/i.test(q))).toEqual([])
  expect(f.t.inTransaction).toBe(false);expect(f.t.prepare('select total_changes() n').get()).toEqual(before)
 }finally{f.close()}
})
it('releases iterator break and consumer throw while preserving caller transaction and rollback',()=>{
 const f=fixture()
 try{
  const r=createTargetCurrentCandidateReader(f.db)
  for(const row of r.iterate('specialized_sme')){expect(row.id).toBe(760);break}
  expect(f.t.inTransaction).toBe(false)
  expect(()=>{for(const _ of r.iterate('specialized_sme'))throw new Error('consumer')}).toThrow('consumer')
  expect(f.t.inTransaction).toBe(false)
  f.t.exec('BEGIN');f.t.exec("update enterprise set name='caller-write' where id=761")
  for(const row of r.iterate('specialized_sme')){expect(row.id).toBe(760);break}
  expect(()=>{for(const _ of r.iterate('specialized_sme'))throw new Error('consumer')}).toThrow('consumer')
  expect(f.t.inTransaction).toBe(true)
  const reader=createCurrentQualificationAssessmentReaderWithWitnesses(f.t,createTargetRecognizedWitnessReader(f.db))
  reader.readCurrent(760,at,'specialized_sme');reader.readWorkbook(760,at,'specialized_sme')
  expect(f.t.inTransaction).toBe(true);f.t.exec('ROLLBACK')
  expect(f.t.prepare('select name from enterprise where id=761').pluck().get()).toBe('Other')
 }finally{if(f.t.inTransaction)f.t.exec('ROLLBACK');f.close()}
})
it('uses maximum assignment revision and normalized unassigned identity for independent duplicate enterprises on the next request',()=>{
 const f=fixture()
 try{
  const reader=createTargetCurrentCandidateReader(f.db),assess=createCurrentQualificationAssessmentReaderWithWitnesses(f.t,createTargetRecognizedWitnessReader(f.db))
  const assigned=(revision:number,enterpriseId:number|null,uscc:string|null)=>f.t.prepare("insert into platform_observation_assignment(observation_id,revision,enterprise_id,uscc_raw,match_basis,verification_status,origin,basis) values(1100,?,?,?,'manual','pending','command','762')").run(revision,enterpriseId,uscc)
  assigned(2,760,null);assigned(3,761,null)
  expect(reader.page('specialized_sme',0,10).rows).toEqual([{id:760},{id:761}])
  expect(assess.readCurrent(761,at,'specialized_sme').snapshot.titles.find(t=>t.titleCode==='specialized_sme')!.platform.observations.flatMap(o=>o.rows).map(r=>r.relationId)).toContain(1100)
  assigned(4,null,' U761 ')
  expect([...reader.iterate('specialized_sme')]).toEqual([{id:760},{id:761},{id:762}])
  for(const id of [761,762]){
   const refs=readDifferencePlatformEffectsByTitle(drizzle(f.t,{schema}),id)
   expect(refs.get('specialized_sme')!.map(r=>r.id)).toEqual([1100])
  }
  assigned(5,760,null)
  expect(reader.count('specialized_sme')).toBe(1)
  expect(readDifferencePlatformEffectsByTitle(drizzle(f.t,{schema}),761).get('specialized_sme')).toEqual([])
 }finally{f.close()}
})
it('pins candidate and complete hydration to one connection snapshot across concurrent assignment changes then refreshes the next request',()=>{
 const f=fixture();f.t.pragma('journal_mode=WAL')
 const writer=new Database(f.path);writer.pragma('foreign_keys=ON')
 try{
  const r=createTargetCurrentCandidateReader(f.db),assess=createCurrentQualificationAssessmentReaderWithWitnesses(f.t,createTargetRecognizedWitnessReader(f.db))
  f.t.exec('BEGIN')
  const it=r.iterate('specialized_sme')[Symbol.iterator]();expect(it.next().value).toEqual({id:760})
  writer.prepare("insert into platform_observation_assignment(observation_id,revision,enterprise_id,match_basis,verification_status,origin,basis) values(2004,2,761,'manual','pending','command','762 concurrent')").run()
  expect(it.next().done).toBe(true)
  expect(assess.readCurrent(760,at,'specialized_sme').snapshot.titles.find(t=>t.titleCode==='specialized_sme')!.platform.observations.flatMap(o=>o.rows).map(r=>r.relationId)).toContain(2004)
  expect(f.t.inTransaction).toBe(true);f.t.exec('ROLLBACK')
  expect(r.page('specialized_sme',0,10)).toEqual({total:2,rows:[{id:760},{id:761}]})
  expect(assess.readWorkbook(760,at,'specialized_sme').snapshot.titles.find(t=>t.titleCode==='specialized_sme')!.platform.observations.flatMap(o=>o.rows).map(r=>r.relationId)).not.toContain(2004)
 }finally{writer.close();if(f.t.inTransaction)f.t.exec('ROLLBACK');f.close()}
})
function cellDigest(t:Database.Database){
 const hash=createHash('sha256')
 for(const {name} of t.prepare("select name from sqlite_master where type='table' order by name").all() as {name:string}[]){hash.update(name);hash.update(serialize(t.prepare(`select * from "${name}" order by rowid`).safeIntegers().all()))}
 return hash.digest('hex')
}
it('preserves exact mixed page scope public aliases independent same-version observations and ordered observation digests',()=>{
 const f=fixture()
 try{
  const refs=readDifferencePlatformEffectsByTitle(drizzle(f.t,{schema}),760)
  const literal={little_giant:[10001,10002,10008],specialized_sme:[10003,10004,10007],innovative_sme:[10005,10006]}
  const reader=createCurrentQualificationAssessmentReaderWithWitnesses(f.t,createTargetRecognizedWitnessReader(f.db)),old=createCurrentQualificationAssessmentReader(f.old)
  for(const title of CURRENT_TITLES){
   expect(refs.get(title)!.filter(r=>r.id>=10000).map(r=>r.id)).toEqual(literal[title])
   expect(refs.get(title)!.map(r=>r.id)).toEqual([...refs.get(title)!].map(r=>r.id).sort((a,b)=>a-b))
   expect(reader.readCurrent(760,at,title)).toEqual(old.readCurrent(760,at,title))
   expect(reader.readWorkbook(760,at,title)).toEqual(old.readWorkbook(760,at,title))
  }
  const aliases=f.t.prepare('select old_id,observation_id from platform_legacy_relation_alias where old_id in (10001,10002) order by old_id').all() as {old_id:number;observation_id:number}[]
  expect(aliases.map(r=>r.old_id)).toEqual([10001,10002]);expect(aliases.every(r=>r.old_id!==r.observation_id)).toBe(true)
  const versions=aliases.map(r=>f.t.prepare('select version_id from platform_business_observation where id=?').pluck().get(r.observation_id))
  expect(versions[0]).not.toBeNull();expect(versions[1]).toBe(versions[0])
 }finally{f.close()}
})
it('retains687 inherited eligibility for expired lower-title history without admitting new qualification rules',()=>{
 const f=fixture()
 try{
  const mutable=new Database(f.old.serialize())
  try{
   for(const connection of [f.t,mutable])connection.exec("update record_event set year=2020,decided_year=2020 where record_id in(select id from record where enterprise_id=760 and title_code='innovative_sme')")
   const target=createCurrentQualificationAssessmentReaderWithWitnesses(f.t,createTargetRecognizedWitnessReader(f.db)).readCurrent(760,at,'innovative_sme')
   expect(target).toEqual(createCurrentQualificationAssessmentReader(mutable).readCurrent(760,at,'innovative_sme'))
   expect(target.rows[2]!.group).toBe('eligible')
   expect(target.snapshot.titles[2]!.effectiveQualification!.localRuleBasis!.join('\n')).toContain('按有效小巨人资格计入')
   expect(target.snapshot.assessmentVersion).toBe('enterprise-qualification-687-v4')
  }finally{mutable.close()}
 }finally{f.close()}
})
it('reuses one three-title source batch and enumerates real candidates once before full hydration in the pinned snapshot',()=>{
 const f=fixture()
 try{
  const candidates=createTargetCurrentCandidateReader(f.db),reader=createCurrentQualificationAssessmentReaderWithWitnesses(f.t,createTargetRecognizedWitnessReader(f.db))
  f.trace.length=0;f.t.exec('BEGIN')
  const ids=[...candidates.iterate('specialized_sme')]
  for(const {id} of ids){const current=reader.readCurrent(id,at,'specialized_sme');expect(current.rows).toHaveLength(3)}
  expect(f.trace.filter(q=>/\bunion\b/i.test(q)&&/current_candidates/.test(q))).toHaveLength(1)
  expect(f.trace.filter(q=>/^select .*"candidate_scope_mask".*from "platform_business_observation".*effect_original/i.test(q))).toHaveLength(1)
  expect(f.t.inTransaction).toBe(true);f.t.exec('ROLLBACK')
 }finally{if(f.t.inTransaction)f.t.exec('ROLLBACK');f.close()}
})
it('keeps71613 page count and rows in one snapshot when current assignment changes between statements',()=>{
 const f=fixture();f.t.pragma('journal_mode=WAL')
 const writer=new Database(f.path),prepare=f.t.prepare.bind(f.t);let injected=false
 const spy=vi.spyOn(f.t,'prepare').mockImplementation(text=>{
  const statement=prepare(text)
  if(/^select count\(/i.test(text)){
   const get=statement.get.bind(statement)
   statement.get=(...args)=>{
    const row=get(...args)
    if(!injected){injected=true;writer.prepare("insert into platform_observation_assignment(observation_id,revision,enterprise_id,match_basis,verification_status,origin,basis) values(2004,2,761,'manual','pending','command','between count and page')").run()}
    return row
   }
  }
  return statement
 })
 try{
  const r=createTargetCurrentCandidateReader(f.db)
  expect(r.page('specialized_sme',0,10)).toEqual({total:1,rows:[{id:760}]})
  expect(injected).toBe(true)
  expect(r.page('specialized_sme',0,10)).toEqual({total:2,rows:[{id:760},{id:761}]})
 }finally{spy.mockRestore();writer.close();f.close()}
})
