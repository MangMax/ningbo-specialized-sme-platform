import Database from 'better-sqlite3'
import { join } from 'node:path'
import { targetSchema } from '../lib/platform/target-schema'
import { expect,it } from 'vitest'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import * as s from '../db/schema'
import { ensurePlatformObservation } from '../server/utils/platform-business-record'
import { witnessReaderFixture } from './helpers/recognized-witness-target-733'
import { createTargetRecognizedWitnessReader } from '../lib/roster/recognized-witness-target'
it('reads migrated typed witness conditions and exact JS position through original aliases without source bodies',async()=>{
 const f=await witnessReaderFixture(old=>{
  const db=drizzle(old,{schema:s})
  db.insert(s.enterprise).values({id:1,name:'Witness',nameNorm:'Witness',usccNorm:'U1'}).run()
  old.prepare("INSERT INTO platform_query(id,interface,query_key,rdjb,queried_at,status,collection_evidence,created_at) VALUES(1,'recognized_list','U1','1,2,3','t','success',?,'c')").run('{"source":"queryBusList","status":"success","completeness":"complete","fullRange":1,"effectiveConditions":{"combination":"and","rddqrq":"2028"},"pages":[{"status":"success","rdjb":"2","rdjb":"1","page":1,"fetchedCount":1}],"pages":[]}')
  db.insert(s.platformRelation).values({id:1,queryId:1,sequenceNo:1,enterpriseId:1,verificationStatus:'confirmed',relationKey:'A',rawFields:{id:'A',rdjb:'3',rddqrq:'2028-12-31',whpc:'2026-2'}}).run()
  ensurePlatformObservation(db,1)
 })
 try{
  const prior=new Database(join(f.root,'a-source.sqlite'),{readonly:true})
  try{expect(()=>createTargetRecognizedWitnessReader(drizzle(prior,{schema:targetSchema}))).toThrow(/completed_A_required/)}finally{prior.close()}
  const reader=createTargetRecognizedWitnessReader(f.db)
  const result=reader.readMany({enterpriseId:1,uscc:'U1',relationIds:[1]}).get(1)
  expect(result).toMatchObject({kind:'available',source:{queryId:1,sequenceNo:1,rdjb:'1,2,3',rawValid:'2028-12-31',rawMaintenanceYear:null,rawMaintenanceBatch:'2026-2',conditionValidYear:'2028',position:{state:'matched',ordinal:0,rdjbKey:'1',pageKind:'number'}}})
  expect(f.trace.join('\n')).not.toMatch(/json_extract|json_each|witness_rdjb_value|witness_page_value|candidate_scope_mask|"validity_date_raw"|"maintenance_year"|"maintenance_batch"|"title_raw"|"bytes"|(?:from|join)\s+["`]?platform_(?:query|relation)["`]?\s/i)
 }finally{f.close()}
},30000)
it('keeps different observations of one verified version bound to their own collection gate and original page',async()=>{
 const f=await witnessReaderFixture(old=>{
  const db=drizzle(old,{schema:s});db.insert(s.enterprise).values({id:1,name:'Shared',nameNorm:'Shared'}).run()
  for(const id of [1,2]){
   const evidence={source:'queryBusList',status:'success',fullRange:true,completeness:'complete',effectiveConditions:{combination:'and'},pages:[{status:'success',rdjb:String(id),page:1,fetchedCount:1}]}
   old.prepare("INSERT INTO platform_query(id,interface,query_key,rdjb,queried_at,status,collection_evidence,created_at) VALUES(?,'recognized_list',?,'1,2,3','t','success',?,'c')").run(id,String(id),JSON.stringify(evidence))
   db.insert(s.platformRelation).values({id,queryId:id,sequenceNo:1,enterpriseId:1,verificationStatus:'confirmed',relationKey:'shared',rawFields:{id:'shared',rdjb:'3',rddqrq:'2028-12-31',whpc:'2026-2'}}).run();ensurePlatformObservation(db,id)
  }
 })
 try{
  expect(f.old.prepare('SELECT count(DISTINCT version_id) n FROM platform_business_observation').get()).toEqual({n:1})
  const rows=createTargetRecognizedWitnessReader(f.db).readMany({enterpriseId:1,uscc:null,relationIds:[1,2]})
  expect(rows.get(1)).toMatchObject({kind:'available',source:{queryId:1,position:{state:'matched',rdjbKey:'1'}}})
  expect(rows.get(2)).toMatchObject({kind:'available',source:{queryId:2,position:{state:'matched',rdjbKey:'2'}}})
 }finally{f.close()}
},30000)
