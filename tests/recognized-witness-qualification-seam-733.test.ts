import { expect,it } from 'vitest'
import { matrix408 } from './helpers/current-qualified-408'
import { witnessReaderFixture } from './helpers/recognized-witness-target-733'
import { createCurrentQualificationAssessmentReader,createCurrentQualificationAssessmentReaderWithWitnesses } from '../lib/roster/current-qualification'
import { createTargetRecognizedWitnessReader } from '../lib/roster/recognized-witness-target'
it('injects the same-connection migrated witness into complete fixed-asOf three-title assessment without changing pure qualification fields',async()=>{
 let enterpriseId=0
 const f=await witnessReaderFixture(old=>{
  const m=matrix408(old)
  const formal=m.formal('Formal',[{eventType:'award',year:2025,decidedYear:2025,batchSeq:1}],{uscc:'91330211B733000001'})
  enterpriseId=formal.enterprise.id
  m.recognized(enterpriseId,formal.events[0]!.id,{rddqrq:'2028-12-31',whpc:'2026-2'})
 })
 try{
  const asOf=Date.parse('2026-06-01T00:00:00Z')
  const legacy=createCurrentQualificationAssessmentReader(f.old,undefined,{recognizedFactSource:'typed'}).read(enterpriseId,asOf,{},'innovative_sme')
  const target=createCurrentQualificationAssessmentReaderWithWitnesses(f.t,createTargetRecognizedWitnessReader(f.db)).read(enterpriseId,asOf,{},'innovative_sme')
  expect(target).toEqual(legacy)
  const observed=createCurrentQualificationAssessmentReaderWithWitnesses(f.t,createTargetRecognizedWitnessReader(f.db)).readTitle(enterpriseId,'innovative_sme',asOf)
  expect(observed.row.matchedValidYears).toEqual([2028])
  expect(observed.row.matchedMaintenance).toEqual([{year:2026,batch:null}])
  expect(()=>createCurrentQualificationAssessmentReaderWithWitnesses(f.t,createTargetRecognizedWitnessReader(f.db)).read(enterpriseId,asOf,{recognizedFactSource:'legacy'},'innovative_sme')).toThrow(/source selector/)
  expect(()=>createCurrentQualificationAssessmentReaderWithWitnesses(f.old,createTargetRecognizedWitnessReader(f.db))).toThrow(/same.*connection/i)
 }finally{f.close()}
},30000)
import { vi } from 'vitest'
import { listCurrentQualified,listCurrentQualifiedWithCandidatesAndWitnesses } from '../lib/roster/current-qualified-query'
import { createTargetCurrentCandidateReader } from '../lib/roster/current-candidates-target'
it('composes one target candidate enumeration with R5 witnesses across fixed days three titles and every witness filter field',async()=>{
 const f=await witnessReaderFixture(old=>{
  const m=matrix408(old),a=m.formal('Cross-year',[{eventType:'award',year:2025,decidedYear:2025,batchSeq:1}],{uscc:'91330211B733000002'})
  m.recognized(a.enterprise.id,a.events[0]!.id,{rddqrq:'2028-12-31',whpc:'2026-2'})
  const specialized=m.formal('Cross-year',[{eventType:'award',year:2023,decidedYear:2023,batchSeq:2}],{enterpriseId:a.enterprise.id,title:'specialized_sme'})
  m.recognized(a.enterprise.id,specialized.events[0]!.id,{rddqrq:'2029-12-31',whpc:'2024-1'})
  const giant=m.formal('Cross-year',[{eventType:'award',year:2025,decidedYear:2025,batchSeq:3}],{enterpriseId:a.enterprise.id,title:'little_giant'})
  m.recognized(a.enterprise.id,giant.events[0]!.id,{rddqrq:'2030-12-31',whpc:'2025-1'})
 })
 try{
  vi.useFakeTimers()
  vi.stubEnv('ROSTER_RECOGNIZED_FILTER_SOURCE','legacy')
  const candidates=createTargetCurrentCandidateReader(f.db),witnesses=createTargetRecognizedWitnessReader(f.db)
  for(const day of ['2025-06-01','2026-06-01','2028-12-31']) {
   vi.setSystemTime(new Date(day+'T00:00:00Z'))
   for(const titleCode of ['innovative_sme','specialized_sme','little_giant'] as const)for(const filter of [{},{validYear:2028},{validYear:2029},{maintenanceYear:2026},{maintenanceYear:2026,maintenanceBatch:2},{validYear:2028,maintenanceYear:2026},{recognitionFrom:'2025-01-01',recognitionTo:'2025-12-31'},{recognitionFrom:'2025-06-01',recognitionTo:'2025-12-31'},{district:'鄞州区'},{q:'Cross-year'},{sort:'name_desc' as const},{page:2,pageSize:1}]) {
    const input={...filter,titleCode}
    const old=listCurrentQualified(f.old,input,{recognizedFactSource:'typed'})
    f.trace.length=0
    const actual=listCurrentQualifiedWithCandidatesAndWitnesses(f.t,input,candidates,witnesses)
    expect(actual,JSON.stringify({day,input})).toEqual(old)
    if(day==='2026-06-01'&&!Object.keys(filter).length){expect(actual.total).toBe(1);expect(actual.rows[0]?.matchedValidYears).toEqual(titleCode==='innovative_sme'?[2028]:[]);expect(actual.rows[0]?.matchedMaintenance).toEqual(titleCode==='innovative_sme'?[{year:2026,batch:null}]:[])}
    expect(f.trace.filter(q=>/\bunion\b/i.test(q)&&/current_candidates/.test(q))).toHaveLength(1)
   }
  }
 }finally{vi.unstubAllEnvs();vi.useRealTimers();f.close()}
},30000)
import { drizzle } from 'drizzle-orm/better-sqlite3'
import * as schema733 from '../db/schema'
import { ensurePlatformObservation } from '../server/utils/platform-business-record'
import { preflightRecordCorrespondences,commitRecordCorrespondences } from '../server/utils/record-correspondence'
it('does not acquire a witness bound only to a future award outside the fixed-day current grants',async()=>{
 let enterpriseId=0
 const f=await witnessReaderFixture(old=>{
  const m=matrix408(old),formal=m.formal('Future link',[{eventType:'award',year:2025,decidedYear:2025,batchSeq:1},{eventType:'award',year:2028,decidedYear:2028,batchSeq:2}],{uscc:'91330211B733000003'})
  enterpriseId=formal.enterprise.id
  m.recognized(enterpriseId,formal.events[0]!.id,{rddqrq:'2028-12-31',whpc:'2026-2'})
  const db=drizzle(old,{schema:schema733}),q=db.insert(schema733.platformQuery).values({interface:'recognized_list',queryKey:'future link',rdjb:'1',titleCode:'innovative_sme',queriedAt:'2026-05-01T00:00:00Z',status:'success'}).returning().get()
  old.prepare('UPDATE platform_query SET collection_evidence=? WHERE id=?').run(JSON.stringify({source:'queryBusList',status:'success',fullRange:true,completeness:'complete',effectiveConditions:{combination:'and'},pages:[{status:'success',rdjb:'1',page:1,fetchedCount:1}]}),q.id)
  const r=db.insert(schema733.platformRelation).values({queryId:q.id,sequenceNo:1,enterpriseId,usccRaw:formal.enterprise.usccNorm,verificationStatus:'confirmed',rawFields:{id:'future-error',rdjb:'1',rddqrq:'2030-12-31',whpc:'2028-2'}}).returning().get();ensurePlatformObservation(db,r.id)
  const request={idempotencyKey:'future-link-733',sourceIdentity:'synthetic/future-link',actor:{type:'agent' as const,id:'733'},basis:'synthetic future link',ruleId:'manual',ruleVersion:'1',operations:[{action:'create' as const,status:'confirmed' as const,edge:{type:'event_recognized' as const,eventId:formal.events[1]!.id,relationId:r.id,role:'recognized_corrob' as const}}]}
  const plan=preflightRecordCorrespondences(db,request);commitRecordCorrespondences(db,request,plan.planHash)
 })
 try{
  const at=Date.parse('2026-06-01T00:00:00Z')
  const old=createCurrentQualificationAssessmentReader(f.old,undefined,{recognizedFactSource:'typed'}).readTitle(enterpriseId,'innovative_sme',at)
  expect(old.row.matchedValidYears).toEqual([2028])
  f.trace.length=0
  const real=createTargetRecognizedWitnessReader(f.db),calls:number[][]=[]
  const instrumented={...real,readMany(input:Parameters<typeof real.readMany>[0]){calls.push([...input.relationIds]);return real.readMany(input)}}
  const actual=createCurrentQualificationAssessmentReaderWithWitnesses(f.t,instrumented).readTitle(enterpriseId,'innovative_sme',at)
  expect(actual).toEqual(old)
  expect(calls).toEqual([[1]])
 }finally{f.close()}
},30000)
