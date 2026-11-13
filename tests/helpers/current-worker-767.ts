import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { expect } from 'vitest'
import { chmodSync, copyFileSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as schema from '../../db/schema'
import { targetSchema } from '../../lib/platform/target-schema'
import { matrix408 } from './current-qualified-408'
import { commitRosterImport } from '../../server/utils/roster-import'
import { platformResultToImport } from '../../lib/platform/recognized-evidence'
import type { PlatformLiveQueryResult } from '../../lib/platform/live-query'
import { preflightRecordCorrespondences, commitRecordCorrespondences } from '../../server/utils/record-correspondence'
import { reserveLegacyIds } from '../../lib/platform/target-archive'
import { CURRENT_TITLES } from '../../lib/roster/current-titles'
import { getEnterpriseFacts, preflightEnterpriseFact, commitEnterpriseFact } from '../../server/utils/enterprise-facts'

export const AT767 = Date.parse('2026-12-01T00:00:00Z')
export const literalMembers767 = {effective:[760,770],expired:[771],terminated:[772],moved_out:[773],unrecognized:[774]}
export function copy767(from:string,to:string) { copyFileSync(from,to); chmodSync(to,0o600) }
/** The accepted #765 real-owner fixture, built once per source variant, never per case. */
export function prepare767(fixtures:string, root:string) {
 const targetBase=join(root,'target-base.sqlite'),oldBase=join(root,'old-base.sqlite')
 if(existsSync(join(root,'prepared.json'))) return {targetBase,oldBase}
 copy767(join(fixtures,'baseline71613.sqlite'),targetBase);copy767(join(fixtures,'baseline0.sqlite'),oldBase)
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
  const m=matrix408(connection)
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
 enrich(t);enrich(old)
 t.close();old.close()
 for(const file of [targetBase,oldBase])chmodSync(file,0o400)
 writeFileSync(join(root,'prepared.json'),JSON.stringify({targetBase,oldBase,fixture:'accepted765-real-owner-three-titles'}))
 return {targetBase,oldBase}
}
function enrich(connection: Database.Database) {
 const m=matrix408(connection)
 connection.exec("insert into enterprise(id,name,name_norm,uscc_norm,district,city) values(770,'Zulu','Zulu',NULL,'海曙区','宁波市'),(771,'same','same','','鄞州区','宁波市'),(772,'Same','Same','U772','鄞州区','宁波市'),(773,'Moved','Moved','U773','鄞州区','宁波市'),(774,'Nurture','Nurture',NULL,'鄞州区','宁波市')")
 for(const title of CURRENT_TITLES) {
  m.formal('unused',undefined,{enterpriseId:770,title})
  m.formal('unused',[{eventType:'award',year:2020,decidedYear:2020,batchSeq:1}],{enterpriseId:771,title})
  m.formal('unused',undefined,{enterpriseId:772,title})
  m.formal('unused',undefined,{enterpriseId:773,title})
  const db=drizzle(connection,{schema})
  const record=db.insert(schema.record).values({enterpriseId:774,titleCode:title,source:'jxj',nameRaw:'Nurture'}).returning().get()
  db.insert(schema.recordEvent).values({recordId:record.id,eventType:'nurture',year:2025,batchSeq:1}).run()
 }
 m.alias(770,'旧名检索','confirmed')
 const db=drizzle(connection,{schema})
 for(const [id,kind] of [[772,'cancelled'],[773,'moved_out']] as const) {
  const command=(change: object,suffix:string)=>{
   const request={expectedVersion:getEnterpriseFacts(db,id).version,idempotencyKey:`765-${id}-${suffix}`,actor:{type:'agent',id:'765'},basis:'合成正式来源逐项核实',...change}
   const plan=preflightEnterpriseFact(db,id,request)
   return commitEnterpriseFact(db,id,{request,planHash:plan.planHash})
  }
  const result=command({action:'assert',fact:{kind,source:{reference:`synthetic:765:${id}`,statement:'合成明确主体状态'},observed:{precision:'day',value:'2026-01-01'},effective:{precision:'day',value:'2026-01-01'},city:null}},'assert')
  command({action:'confirm',factId:result.factId},'confirm')
 }
 // Exercise the existing full-text appendix using actual source text.
 connection.prepare("update record_evidence set attachment=? where record_event_id in (select e.id from record_event e join record r on r.id=e.record_id where r.enterprise_id=770)").run('完整附件段落\n'.repeat(80))
}
