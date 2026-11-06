import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { afterEach, expect, it } from 'vitest'
import * as schema from '../db/schema'
import { TITLE_SEED } from '../db/titles'
import { refreshEnterpriseDifferences, readEnterpriseDifferenceComparisons } from '../server/utils/enterprise-difference-refresh'
import { createCurrentQualificationAssessmentReader } from '../lib/roster/current-qualification'
import { selectEnterpriseCoordinates } from '../lib/roster/enterprise-list-selection'
const close: Database.Database[]=[]
afterEach(()=>{for(const d of close.splice(0))d.close()})
function fixture(){
 const sqlite=new Database(':memory:');close.push(sqlite)
 const db=drizzle(sqlite,{schema});migrate(db,{migrationsFolder:'db/migrations'});db.insert(schema.title).values([...TITLE_SEED]).run()
 const ids=[1,2].map(i=>{const e=db.insert(schema.enterprise).values({name:`刷新${i}`,nameNorm:`刷新${i}`,usccNorm:`9133021125599445${i}P`}).returning().get();db.insert(schema.record).values({enterpriseId:e.id,titleCode:'specialized_sme',source:'jxj',nameRaw:e.name}).run();return e.id})
 return {db,sqlite,ids}
}
const at='2026-11-06T00:00:00.000Z'
it('refresh defaults to pending, scopes enterprise IDs and preserves qualifications',()=>{
 const {db,sqlite,ids}=fixture(),reader=createCurrentQualificationAssessmentReader(sqlite)
 const before=reader.read(ids[0]!,Date.parse(at))
 const result=refreshEnterpriseDifferences(db,{enterpriseIds:[ids[0]!] },at)
 expect(result.refreshed).toBe(3);expect(result.enterprises.map(e=>e.enterpriseId)).toEqual([ids[0]])
 expect(result.enterprises[0]!.comparisons.every(c=>c.status==='needs_review')).toBe(true)
 expect(sqlite.prepare('select count(*) n from enterprise_difference_comparison where enterprise_id=?').get(ids[1])).toEqual({n:0})
 expect(reader.read(ids[0]!,Date.parse(at))).toEqual(before)
 expect(selectEnterpriseCoordinates(db,{}).candidates.find(e=>e.id===ids[0])!.difference.status).toBe('needs_review')
})
it('same business rows with new query ID and collection time preserve existing judgment',()=>{
 const {db,ids}=fixture(),id=ids[0]!
 const query=(time:string)=>db.insert(schema.platformQuery).values({interface:'business_list',queryKey:'91330211255994451P',rdjb:'2',titleCode:'specialized_sme',queriedAt:time,status:'success',rawResponse:JSON.stringify({executionTime:time})}).returning().get()
 const relation=(qid:number)=>db.insert(schema.platformRelation).values({queryId:qid,sequenceNo:1,enterpriseId:id,relationKey:'fixed-business-key',nameRaw:'业务名',status:'通过'}).run()
 relation(query('2026-11-04T00:00:00Z').id)
 const first=refreshEnterpriseDifferences(db,{enterpriseIds:[id]},at)
 db.insert(schema.differenceReason).values({enterpriseId:id,titleCode:'specialized_sme',direction:'missing_in_miit',status:'confirmed_no_diff',recordedAt:'2026-11-06T00:00:01.000Z'}).run()
 relation(query('2026-11-05T00:00:00Z').id)
 const repeat=refreshEnterpriseDifferences(db,{enterpriseIds:[id]},'2026-11-06T00:00:02.000Z')
 expect(repeat.refreshed).toBe(0);expect(repeat.unchanged).toBe(3)
 expect(repeat.enterprises[0]!.comparisons.find(c=>c.titleCode==='specialized_sme')!.status).toBe('confirmed_no_diff')
 expect(repeat.enterprises[0]!.comparisons.map(c=>[c.titleCode,c.businessFingerprint,c.comparisonState])).toEqual(first.enterprises[0]!.comparisons.map(c=>[c.titleCode,c.businessFingerprint,c.comparisonState]))
 expect(selectEnterpriseCoordinates(db,{}).candidates.find(e=>e.id===id)!.difference.status).toBe('confirmed_no_diff') // preserve existing list aggregation priority
})
it('business field change resets only the affected title to pending',()=>{
 const {db,sqlite,ids}=fixture(),id=ids[0]!
 const r=db.select().from(schema.record).all()[0]!
 refreshEnterpriseDifferences(db,{enterpriseIds:[id]},at)
 db.insert(schema.differenceReason).values({enterpriseId:id,titleCode:'specialized_sme',direction:'missing_in_miit',status:'confirmed_no_diff',recordedAt:'2026-11-06T00:00:01.000Z'}).run()
 sqlite.prepare('update record set name_raw=? where id=?').run('变更后的正式业务名',r.id)
 const changed=refreshEnterpriseDifferences(db,{enterpriseIds:[id]},'2026-11-06T00:00:02.000Z')
 expect(changed.refreshed).toBe(1);expect(changed.unchanged).toBe(2)
 expect(changed.enterprises[0]!.comparisons.find(c=>c.titleCode==='specialized_sme')!.status).toBe('needs_review')
 expect(sqlite.prepare('select count(*) n from difference_reason').get()).toEqual({n:1})
})
it('invalid empty duplicate unknown and malformed scopes fail without writes',()=>{
 const {db,sqlite,ids}=fixture()
 for(const input of [{enterpriseIds:[]},{enterpriseIds:[ids[0],ids[0]]},{enterpriseIds:[999]},{enterpriseIds:['1']},{enterpriseIds:[0]},{unexpected:true}])expect(()=>refreshEnterpriseDifferences(db,input,at)).toThrow()
 expect(sqlite.prepare('select count(*) n from enterprise_difference_comparison').get()).toEqual({n:0})
})
it('default scope is published enterprises and GET reads persisted current results',()=>{
 const {db}=fixture()
 const r=refreshEnterpriseDifferences(db,{},at)
 expect(r.enterprises).toHaveLength(2)
 expect(readEnterpriseDifferenceComparisons(db,{}).enterprises).toEqual(r.enterprises)
})
it('new content version hashes with identical typed business fields preserve the comparison',()=>{
 const {db,ids}=fixture(),id=ids[0]!
 const record=db.insert(schema.platformBusinessRecord).values({interface:'business_list',platformKey:'business-1',identityRuleVersion:'synthetic'}).returning().get()
 const observe=(index:number,businessYear:number)=>{
  const query=db.insert(schema.platformQuery).values({interface:'business_list',queryKey:'91330211255994451P',titleCode:'specialized_sme',rdjb:'2',queriedAt:`2026-11-0${index}T00:00:00Z`,status:'success'}).returning().get()
  const relation=db.insert(schema.platformRelation).values({queryId:query.id,sequenceNo:1,enterpriseId:id,relationKey:'business-1',nameRaw:'同名'}).returning().get()
  const version=db.insert(schema.platformBusinessRecordVersion).values({recordId:record.id,hashAlgorithm:'platform-row-json-v1',contentHash:String(index).repeat(64),canonicalRawJson:JSON.stringify({id:'business-1',executionTime:index,businessYear})}).returning().get()
  db.insert(schema.platformBusinessObservation).values({relationId:relation.id,recordId:record.id,versionId:version.id,identityState:'resolved',contentState:'verified',keySource:'both',projectionRuleVersion:'synthetic',inputFingerprint:`metadata-${index}`}).run()
  db.insert(schema.platformBusinessProjection).values({recordId:record.id,versionId:version.id,businessYear,nameRaw:'同名',ruleVersion:'synthetic'}).run()
 }
 observe(1,2024);const before=refreshEnterpriseDifferences(db,{enterpriseIds:[id]},at)
 observe(2,2024);const same=refreshEnterpriseDifferences(db,{enterpriseIds:[id]},at)
 expect(same.refreshed).toBe(0);expect(same.unchanged).toBe(3)
 expect(same.enterprises[0]!.comparisons).toEqual(before.enterprises[0]!.comparisons)
 observe(3,2025);const changed=refreshEnterpriseDifferences(db,{enterpriseIds:[id]},at)
 expect(changed.refreshed).toBe(1);expect(changed.unchanged).toBe(2)
 expect(changed.enterprises[0]!.comparisons.find(c=>c.titleCode==='specialized_sme')!.status).toBe('needs_review')
})

it('derived row title backfill preserves judgments while original rdjb changes reset them',()=>{
 const {db,sqlite,ids}=fixture(),id=ids[0]!
 const q=db.insert(schema.platformQuery).values({interface:'business_list',queryKey:'91330211255994451P',rdjb:'2',titleCode:'specialized_sme',queriedAt:at,status:'success'}).returning().get()
 const r=db.insert(schema.platformRelation).values({queryId:q.id,sequenceNo:1,enterpriseId:id,relationKey:'row-title',rawFields:{id:'row-title',rdjb:'2'}}).returning().get()
 const record=db.insert(schema.platformBusinessRecord).values({interface:'business_list',platformKey:'row-title',identityRuleVersion:'fixture'}).returning().get()
 const v=db.insert(schema.platformBusinessRecordVersion).values({recordId:record.id,hashAlgorithm:'platform-row-json-v1',contentHash:'a'.repeat(64),canonicalRawJson:JSON.stringify({id:'row-title',rdjb:'2'})}).returning().get()
 db.insert(schema.platformBusinessObservation).values({relationId:r.id,recordId:record.id,versionId:v.id,identityState:'resolved',contentState:'verified',keySource:'both',projectionRuleVersion:'fixture',inputFingerprint:'fixture'}).run()
 db.insert(schema.platformBusinessProjection).values({recordId:record.id,versionId:v.id,titleRaw:null,ruleVersion:'fixture'}).run()
 const before=refreshEnterpriseDifferences(db,{enterpriseIds:[id]},at)
 db.insert(schema.differenceReason).values({enterpriseId:id,titleCode:'specialized_sme',direction:'missing_in_miit',status:'confirmed_no_diff',recordedAt:'2026-11-06T00:00:01.000Z'}).run()
 sqlite.prepare('update platform_business_projection set title_raw=? where version_id=?').run('2',v.id)
 const same=refreshEnterpriseDifferences(db,{enterpriseIds:[id]},'2026-11-06T00:00:02.000Z')
 expect(same.refreshed).toBe(0);expect(same.unchanged).toBe(3)
 expect(same.enterprises[0]!.comparisons.map(c=>c.businessFingerprint)).toEqual(before.enterprises[0]!.comparisons.map(c=>c.businessFingerprint))
 expect(same.enterprises[0]!.comparisons.find(c=>c.titleCode==='specialized_sme')!.status).toBe('confirmed_no_diff')
 sqlite.prepare('update platform_relation set raw_fields=? where id=?').run(JSON.stringify({id:'row-title',rdjb:'3'}),r.id)
 const changed=refreshEnterpriseDifferences(db,{enterpriseIds:[id]},'2026-11-06T00:00:03.000Z')
 expect(changed.refreshed).toBe(1);expect(changed.unchanged).toBe(2)
 expect(changed.enterprises[0]!.comparisons.find(c=>c.titleCode==='specialized_sme')!.status).toBe('needs_review')
})
