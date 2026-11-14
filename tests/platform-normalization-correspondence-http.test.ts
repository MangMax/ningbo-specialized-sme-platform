import {expect,it} from 'vitest'
import * as schema from '../db/schema'
import {relationSource} from '../server/utils/record-correspondence-read'
import {preflightRecordCorrespondences,commitRecordCorrespondences} from '../server/utils/record-correspondence'
import {listPlatformQueries} from '../lib/platform/read'
import {nativeImportDb,businessSource,commitNativeSource} from './helpers/native-import'
it('uses native normalized source facts for an explicit correspondence without changing original raw bytes',()=>{
 const db=nativeImportDb()
 try{
 const e=db.insert(schema.enterprise).values({name:'Native source',nameNorm:'native source',usccNorm:'91330211255994457P'}).returning().get()
 const r=db.insert(schema.record).values({enterpriseId:e.id,titleCode:'specialized_sme',source:'jxj'}).returning().get()
 const event=db.insert(schema.recordEvent).values({recordId:r.id,eventType:'award',year:2025}).returning().get()
 const raw={id:'B-native',rdjb:'2',sblx:'申请',sqsj:'2025-01-01',cszt:'终审通过',year:'2025',qymc:e.name,tyshxydm:e.usccNorm}
 expect(commitNativeSource(db,businessSource(e.usccNorm!,[{sequenceNo:1,relationKey:raw.id,enterpriseId:e.id,nameRaw:e.name,usccRaw:e.usccNorm,matchBasis:'uscc',verificationStatus:'confirmed',rawFields:raw}]),'normalized-correspondence').status).toBe('committed')
 const row=listPlatformQueries(db).rows[0]!.relations[0]!,before=JSON.stringify(row.rawFields)
 expect(relationSource(db,row.id)).toMatchObject({status:'终审通过',declareKind:'apply',appliedAt:'2025-01-01',normalizationConflicts:[]})
 const request={idempotencyKey:'native-context',sourceIdentity:'native',actor:{type:'agent' as const,id:'test'},basis:'Explicit synthetic context',ruleId:'manual',ruleVersion:'1',operations:[{action:'create' as const,status:'candidate' as const,edge:{type:'event_process' as const,eventId:event.id,relationId:row.id,role:'context_only' as const}}]}
 const plan=preflightRecordCorrespondences(db,request),result=commitRecordCorrespondences(db,request,plan.planHash)
 expect(result.correspondenceIds).toHaveLength(1)
 expect(JSON.stringify(listPlatformQueries(db).rows[0]!.relations[0]!.rawFields)).toBe(before)
 }finally{db.$client.close()}
})
