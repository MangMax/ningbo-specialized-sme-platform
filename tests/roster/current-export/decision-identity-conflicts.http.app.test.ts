import { nativeWorkbookFixture } from './fixtures/native-workbook'
import { submitNativePlatformQuery } from '../../platform/fixtures/native-query'
import { businessIdentity, expectedBusinessIdentity, matchesBusinessIdentity } from './fixtures/specialized-export'
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest'
import { schema as s } from '../../../db/client'
import { CURRENT_TITLES, readCurrentCandidate } from '../../../lib/roster/current-qualification'
import { specializedExportFixture, rows, year } from './fixtures/specialized-export'
import { readEvidenceToken113 } from '../../../server/utils/evidence-impact-113'
const f=nativeWorkbookFixture()
beforeAll(()=>f.start(),90000)
beforeEach(()=>f.resetBusiness())
afterAll(()=>f.close())
let serial=0
const actor={type:'agent',id:'synthetic-pr138-review'}
const scope=(id:number,direction='extra_in_miit',titleCode='specialized_sme')=>({enterpriseId:id,titleCode,direction})
async function api(body:unknown){const r=await fetch(f.url('/api/roster/decision-lifecycle/commands'),{method:'POST',headers:f.headers,body:JSON.stringify(body)});return {status:r.status,body:await r.json()}}
async function review(id:number,version:number,direction='extra_in_miit'){
  const token=readEvidenceToken113(f.db,scope(id,direction) as any)
  const r=await api({...scope(id,direction),action:'maintain',expectedCurrentId:version,idempotencyKey:'pr138-review-'+(++serial),actor,basis:'Synthetic explicit review',ruleVersion:'synthetic-pr138',effectiveAt:`${year-1}-01-01T00:00:00Z`,reviewedEvidence:{latestRevisionId:token.latestRevisionId,projectionReady:true}})
  expect(r.status,JSON.stringify(r.body)).toBe(200)
}
function source(id:number,raw?:string,assigned=true){
  const e=f.db.select().from(s.enterprise).all().find(e=>e.id===id)!
  const native=submitNativePlatformQuery(f.db,{interface:'business_list',queryKey:e.usccNorm!,rdjb:'2',titleCode:'specialized_sme',queriedAt:new Date(Date.now()+(++serial)).toISOString(),status:'success',rawResponse:'Synthetic process source',relations:[{enterpriseId:assigned?id:null,sequenceNo:1,usccRaw:raw?.trim()??e.usccNorm,nameRaw:e.name,rawFields:{id:'PR138-'+serial,qymc:e.name,tyshxydm:raw??e.usccNorm},verificationStatus:assigned?'confirmed':'pending',matchBasis:'uscc'}]})
  const q={id:native.queryId},r={id:native.relationIds[0]!}
  return {q,r}
}
async function inbound(id:number,extra:any={},raw?:string){
  const {q,r}=source(id,raw)
  const command={...scope(id),action:'replace',expectedCurrentId:null,idempotencyKey:'pr138-inbound-'+(++serial),actor,basis:'Synthetic independently confirmed inbound and external qualification',ruleVersion:'synthetic-pr138',effectiveAt:`${year-1}-01-01T00:00:00Z`,decision:{status:'confirmed_reason',reasonCode:'moved_in',measureCode:'record_moved_in',verificationStatus:'confirmed',evidenceQueryId:q.id,evidenceRelationId:r.id,currentQualification:{titleCode:'specialized_sme',validFrom:`${year-1}-01-01T00:00:00Z`,validUntil:`${year+2}-01-01T00:00:00Z`,basis:'Synthetic independently verified external qualification',publicationCheck:{status:'not_found',scope:'New grant publications only; preserve older Ningbo history'},...extra}}}
  return {result:await api(command),command,q,r}
}
const occurrences=(wb:any,id:number):Array<{sheet:string;row:any[]}>=>wb.worksheets.slice(0,5).flatMap((sh:any)=>rows(wb,sh.name).filter(r=>matchesBusinessIdentity(f.db, r, id)).map(row=>({sheet:sh.name,row})))
it('rejects bound source identity conflicts without creating decision history',async()=>{
  const c=f.candidate('Rejected explicit bound conflict',[])
  const before=f.db.$client.prepare('select count(*) n from difference_reason where enterprise_id=?').get(c.enterprise.id) as any
  const {result}=await inbound(c.enterprise.id,{},'DIFFERENT-LEGAL-ENTITY')
  expect(result.status,JSON.stringify(result.body)).toBe(422)
  expect(f.db.$client.prepare('select count(*) n from difference_reason where enterprise_id=?').get(c.enterprise.id)).toEqual(before)
})
it('keeps later conflicting observations separate from retained decision audit',async()=>{
  const c=f.candidate('Historical source conflict',[]),{result,r}=await inbound(c.enterprise.id)
  expect(result.status).toBe(200);await review(c.enterprise.id,result.body.versionId)
  // Append the new source observation; the original binding remains immutable.
  const correction=source(c.enterprise.id,'OTHER-ENTITY',false)
  expect(correction.r.id).not.toBe(r.id)
  const before=f.db.$client.prepare('select * from difference_reason where id=?').get(result.body.versionId)
  const {wb}=await f.workbook('pr138-historical-conflict')
  const actual=occurrences(wb,c.enterprise.id)
  expect(actual.map(x=>x.sheet)).toEqual(['有效企业'])
  expect(actual[0]!.row[12]).toContain('工信部企业信息查询')
  expect(f.db.$client.prepare('select * from difference_reason where id=?').get(result.body.versionId)).toEqual(before)
},60000)
it('admits independently confirmed inbound qualification despite unrelated diagnostic heads',async()=>{
  const ids:number[]=[]
  for(const kind of ['other','unknown','identity','subject'] as const){
    const c=f.candidate('Sticky inbound blocker '+kind,kind==='identity'?[{eventType:'award',year:year-6,batchSeq:1}]:[])
    if(kind==='identity')f.db.$client.prepare('update record set uscc_raw=? where id=?').run('CONFLICT-IDENTITY',c.record.id)
    const {result}=await inbound(c.enterprise.id);expect(result.status).toBe(200);await review(c.enterprise.id,result.body.versionId)
    if(kind==='other'||kind==='unknown'){
      const d=f.decision(c.enterprise.id,'other',{direction:'missing_in_miit',...(kind==='unknown'?{lifecycleAction:null}:{}),reasonNote:'Unresolved qualification evidence; no automatic text interpretation'})
      if(kind==='other')await review(c.enterprise.id,d.id,'missing_in_miit')
    }
    if(kind==='subject')f.decision(c.enterprise.id,'moved_out',{titleCode:'little_giant',verificationStatus:'pending'})
    ids.push(c.enterprise.id)
  }
  const {wb}=await f.workbook('pr138-sticky-blockers')
  for(const [index,id] of ids.entries())expect.soft(occurrences(wb,id).map(x=>x.sheet),String(id)).toEqual(['有效企业'])
},60000)
it('admits current inbound qualification while preserving expired formal grant history',async()=>{
  const c=f.candidate('Historical local returning enterprise',[{eventType:'award',year:year-6,batchSeq:1}])
  const {result}=await inbound(c.enterprise.id);expect(result.status).toBe(200);await review(c.enterprise.id,result.body.versionId)
  const {wb}=await f.workbook('pr138-returning-history'),actual=occurrences(wb,c.enterprise.id)
  expect(actual.map(x=>x.sheet)).toEqual(['有效企业'])
  expect(actual[0]!.row[7]).toContain('年第1批认定')
  expect(actual[0]!.row[7]).toContain('independently verified external qualification')
  expect(actual[0]!.row[10]).toContain('已见本称号宁波公布')
  expect(actual[0]!.row[11]??'').toContain('New grant publications only')
  expect(actual[0]!.row[11]).not.toContain('已到复核年份')
  expect(readCurrentCandidate(f.db.$client,c.enterprise.id,'little_giant',year).group).toBe('excluded')
},60000)
it('keeps formal failures and undated grants in the expired sheet despite inbound intervals',async()=>{
  const cases=[
    {id:'later failure',events:[{eventType:'award',year:year-6,batchSeq:1},{eventType:'review',year:year-6,decidedYear:year,reviewOutcome:'failed',batchSeq:1}]},
    {id:'same year failure',events:[{eventType:'award',year:year-6,batchSeq:1},{eventType:'review',year:year-6,decidedYear:year-1,reviewOutcome:'failed',batchSeq:1}]},
    {id:'earlier failure without explicit reaward',events:[{eventType:'award',year:year-6,batchSeq:1},{eventType:'review',year:year-6,decidedYear:year-2,reviewOutcome:'failed',batchSeq:1}]},
    {id:'unknown time',events:[{eventType:'award',year:null,batchSeq:null}]},
    {id:'unknown review cycle',events:[{eventType:'award',year:year-6,batchSeq:1},{eventType:'review',year:null,decidedYear:year,reviewOutcome:'failed',batchSeq:null}]},
  ] as const
  const ids:number[]=[]
  for(const cse of cases){const c=f.candidate('Inbound formal boundary '+cse.id,[...cse.events] as any);const {result}=await inbound(c.enterprise.id);expect(result.status).toBe(200);await review(c.enterprise.id,result.body.versionId);ids.push(c.enterprise.id)}
  const {wb}=await f.workbook('pr138-formal-boundaries')
  for(const id of ids)expect.soft(occurrences(wb,id).map(x=>x.sheet)).toEqual(['已到期'])
},60000)
it('separates earlier failures from same year and later formal failure conflicts',async()=>{
  const expected:Array<[number,string]>=[]
  for(const [label,failureYear,awardYear] of [['later',year-2,year-1],['unknown-origin-later',year-2,year-1],['same-year',year-1,year-1],['later-failure',year,year-1]] as const){
    const c=f.candidate('Explicit external recovery '+label,[{eventType:'award',year:year-6,batchSeq:1},{eventType:'review',year:label==='unknown-origin-later'?null:year-6,decidedYear:failureYear,reviewOutcome:'failed',batchSeq:null}])
    const {result}=await inbound(c.enterprise.id,{awardYear});expect(result.status,JSON.stringify(result.body)).toBe(200);await review(c.enterprise.id,result.body.versionId);expected.push([c.enterprise.id,label==='later'||label==='unknown-origin-later'?'有效企业':'已到期'])
  }
  const {wb}=await f.workbook('pr138-explicit-reaward')
  for(const [id,group] of expected)expect(occurrences(wb,id).map(x=>x.sheet)).toEqual([group])
},60000)
it('keeps normalized unassigned candidates and references without confirming ownership or qualification',async()=>{
  const ids:Array<[number,number]>=[]
  for(const [label,raw] of [['lower','synthetic-normalized-a'],['whitespace',' \tSYNTHETIC - NORMALIZED - B\u3000']] as const){
    const c=f.candidate('Normalized candidate '+label,[])
    f.db.$client.prepare('update enterprise set uscc_norm=? where id=?').run(label==='lower'?'SYNTHETIC-NORMALIZED-A':'SYNTHETIC-NORMALIZED-B',c.enterprise.id)
    f.db.$client.prepare('delete from record where id=?').run(c.record.id)
    const {r}=source(c.enterprise.id,raw,false);ids.push([c.enterprise.id,r.id])
  }
  const {wb}=await f.workbook('pr138-normalized-unassigned')
  for(const [id,rid] of ids){const actual=occurrences(wb,id);expect(actual.map(x=>x.sheet)).toEqual(['未认定']);expect(actual[0]!.row[12]).toContain('工信部企业信息查询');expect(actual[0]!.row.join(' ')).not.toContain('platform-relation:'+rid);expect(f.db.$client.prepare('select a.enterprise_id,a.verification_status from platform_observation_assignment a join platform_legacy_relation_alias l on l.observation_id=a.observation_id where l.old_id=? order by a.revision desc limit 1').get(rid)).toEqual({enterprise_id:null,verification_status:'pending'})}
},60000)

it('rejects future reaward assertions and keeps unrelated title qualification gaps scoped',async()=>{
  const c=f.candidate('Qualification scope control',[])
  const rejected=await inbound(c.enterprise.id,{awardYear:year+1})
  expect(rejected.result.status).toBe(400)
  const {result}=await inbound(c.enterprise.id)
  expect(result.status).toBe(200);await review(c.enterprise.id,result.body.versionId)
  f.decision(c.enterprise.id,'other',{titleCode:'little_giant',direction:'missing_in_miit'})
  const {wb}=await f.workbook('pr138-title-gap-scope')
  expect(occurrences(wb,c.enterprise.id).map(x=>x.sheet)).toEqual(['有效企业'])
},60000)

it('keeps later pending observations separate from reviewed inbound history',async()=>{
  const c=f.candidate('Unconfirmed historical source',[]),{result,r}=await inbound(c.enterprise.id)
  expect(result.status).toBe(200);await review(c.enterprise.id,result.body.versionId)
  const next=source(c.enterprise.id,undefined,false)
  expect(next.r.id).not.toBe(r.id)
  const {wb}=await f.workbook('pr138-source-confirmation-defense')
  expect(occurrences(wb,c.enterprise.id).map(x=>x.sheet)).toEqual(['有效企业'])
},60000)
it('preserves a later definite formal qualification when the inbound interval belongs to older history',async()=>{
  const c=f.candidate('Later definite local award',[{eventType:'award',year,batchSeq:1}])
  const {result}=await inbound(c.enterprise.id)
  expect(result.status).toBe(200);await review(c.enterprise.id,result.body.versionId)
  const {wb}=await f.workbook('pr138-later-definite-local-control'),actual=occurrences(wb,c.enterprise.id)
  expect(actual.map(x=>x.sheet)).toEqual(['有效企业'])
  expect(actual[0]!.row[7]).toContain('年第1批认定')
  expect(actual[0]!.row[7]).not.toContain('independently verified external qualification')
  expect(actual[0]!.row[11]).not.toContain('顺序尚未消解')
},60000)

it.each(CURRENT_TITLES)('keeps a later formal failure excluded after an expired inbound assertion for %s',async titleCode=>{
  const c=f.candidate('Expired inbound before failure '+titleCode,[
    {eventType:'award',year:year-6,batchSeq:1},
    {eventType:'review',year:year-6,decidedYear:year-2,reviewOutcome:'failed',batchSeq:1},
  ],titleCode)
  expect(readCurrentCandidate(f.db.$client,c.enterprise.id,titleCode,year).group).toBe('excluded')
  const native=submitNativePlatformQuery(f.db,{interface:'business_list',queryKey:c.enterprise.usccNorm!,rdjb:{little_giant:'3',specialized_sme:'2',innovative_sme:'1'}[titleCode],titleCode,queriedAt:new Date().toISOString(),status:'success',rawResponse:'Synthetic title process',relations:[{enterpriseId:c.enterprise.id,sequenceNo:1,usccRaw:c.enterprise.usccNorm,verificationStatus:'confirmed',matchBasis:'uscc'}]})
  const q={id:native.queryId},r={id:native.relationIds[0]!}
  const sc=scope(c.enterprise.id,'extra_in_miit',titleCode)
  const result=await api({...sc,action:'replace',expectedCurrentId:null,idempotencyKey:'pr138-expired-'+(++serial),actor,basis:'Synthetic verified historical migration and expired grant',ruleVersion:'synthetic-pr138',effectiveAt:`${year-1}-01-01T00:00:00Z`,decision:{status:'confirmed_reason',reasonCode:'moved_in',measureCode:'record_moved_in',verificationStatus:'confirmed',evidenceQueryId:q.id,evidenceRelationId:r.id,currentQualification:{titleCode,awardYear:year-6,validFrom:`${year-6}-01-01T00:00:00Z`,validUntil:`${year-3}-01-01T00:00:00Z`,basis:'Synthetic expired external grant retained for audit',publicationCheck:{status:'not_found',scope:'Historical grant scope only'}}}})
  expect(result.status,JSON.stringify(result.body)).toBe(200)
  const token=readEvidenceToken113(f.db,sc as any)
  const maintained=await api({...sc,action:'maintain',expectedCurrentId:result.body.versionId,idempotencyKey:'pr138-expired-review-'+(++serial),actor,basis:'Synthetic explicit review of historical evidence',ruleVersion:'synthetic-pr138',effectiveAt:`${year-1}-01-01T00:00:00Z`,reviewedEvidence:{latestRevisionId:token.latestRevisionId,projectionReady:true}})
  expect(maintained.status,JSON.stringify(maintained.body)).toBe(200)
  const auditBefore=f.db.$client.prepare('select * from difference_reason where enterprise_id=? order by id').all(c.enterprise.id)
  const eventsBefore=f.db.$client.prepare('select * from record_event where record_id=? order by id').all(c.record.id)
  const path={little_giant:'little-giant',specialized_sme:'specialized-sme',innovative_sme:'innovative-sme'}[titleCode]
  const {wb}=await f.workbook('pr138-expired-export-'+titleCode,titleCode),actual=occurrences(wb,c.enterprise.id)
  expect(actual.map(x=>x.sheet)).toEqual(['已到期'])
  expect(actual[0]!.row[7]).toContain('年第1批认定')
  expect(actual[0]!.row[7]).not.toContain('Synthetic expired external grant retained for audit')
  expect(actual[0]!.row[7]).toContain('复核未通过')
  expect(actual[0]!.row[11]).toContain(titleCode==='little_giant'?'本称号原认定周期已有生效的已确认处置':'复核明确不通过')
  expect(actual[0]!.row[11]).not.toContain('日期顺序尚未消解')
  expect(actual[0]!.row.join(' ')).not.toContain('decision:'+result.body.versionId)
  expect(actual[0]!.row[12]).toContain('synthetic-118.xlsx')
  expect(f.db.$client.prepare('select * from difference_reason where enterprise_id=? order by id').all(c.enterprise.id)).toEqual(auditBefore)
  expect(f.db.$client.prepare('select * from record_event where record_id=? order by id').all(c.record.id)).toEqual(eventsBefore)
})

it.each(['not_found','not_checked'] as const)('keeps a formal failure excluded despite inbound publication status %s',async status=>{
  const c=f.candidate('Current unresolved inbound '+status,[
    {eventType:'award',year:year-6,batchSeq:1},
    {eventType:'review',year:year-6,decidedYear:year-2,reviewOutcome:'failed',batchSeq:1},
  ])
  const {result}=await inbound(c.enterprise.id,{publicationCheck:{status,scope:'Synthetic current assertion; publication scope recorded explicitly'}})
  expect(result.status,JSON.stringify(result.body)).toBe(200)
  await review(c.enterprise.id,result.body.versionId)
  const {wb}=await f.workbook('pr138-current-unresolved-'+status),actual=occurrences(wb,c.enterprise.id)
  expect(actual.map(x=>x.sheet)).toEqual(['已到期'])
  expect(actual[0]!.row[11]??'').not.toContain('日期顺序尚未消解')
})
