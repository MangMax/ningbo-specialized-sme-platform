import { submitNativePlatformQuery } from '../../platform/fixtures/native-query'
import { createRuntimeSchema } from '../../../db/create-runtime'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { afterEach, expect, it } from 'vitest'
import * as schema from '../../../db/schema'
import { refreshEnterpriseDifferences, readEnterpriseDifferenceComparisons } from '../../../layers/sme-roster/server/utils/enterprise-difference-refresh'
import { createCurrentQualificationAssessmentReader } from '../../../layers/sme-roster/lib/roster/current-qualification'
import { selectEnterpriseCoordinates } from '../../../layers/sme-roster/lib/roster/enterprise-list-selection'
const close: Database.Database[]=[]
afterEach(()=>{for(const d of close.splice(0))d.close()})
function fixture(){
 const sqlite=new Database(':memory:');close.push(sqlite)
 createRuntimeSchema(sqlite); const db=drizzle(sqlite,{schema})
 const ids=[1,2].map(i=>{const e=db.insert(schema.enterprise).values({name:`刷新${i}`,nameNorm:`刷新${i}`,usccNorm:`9133021125599445${i}P`}).returning().get();db.insert(schema.record).values({enterpriseId:e.id,titleCode:'specialized_sme',source:'jxj',nameRaw:e.name}).run();return e.id})
 db.insert(schema.rosterLegacyMember).values(ids.map(enterpriseId=>({enterpriseId}))).run()
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
 const observe=(time:string)=>submitNativePlatformQuery(db,{interface:'business_list',queryKey:'91330211255994451P',rdjb:'2',titleCode:'specialized_sme',queriedAt:time,status:'success',rawResponse:JSON.stringify({executionTime:time}),relations:[{sequenceNo:1,enterpriseId:id,relationKey:'fixed-business-key',nameRaw:'业务名',status:'通过'}]})
 observe('2026-11-04T00:00:00Z')
 const first=refreshEnterpriseDifferences(db,{enterpriseIds:[id]},at)
 db.insert(schema.differenceReason).values({enterpriseId:id,titleCode:'specialized_sme',direction:'missing_in_miit',status:'confirmed_no_diff',recordedAt:'2026-11-06T00:00:01.000Z'}).run()
 observe('2026-11-05T00:00:00Z')
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
 const observe=(index:number,businessYear:number)=>submitNativePlatformQuery(db,{interface:'business_list',queryKey:'91330211255994451P',titleCode:'specialized_sme',rdjb:'2',queriedAt:`2026-11-0${index}T00:00:00Z`,status:'success',rawResponse:JSON.stringify({executionTime:index}),relations:[{sequenceNo:1,enterpriseId:id,relationKey:'business-1',nameRaw:'同名',year:businessYear,rawFields:{id:'business-1',qymc:'同名',year:String(businessYear),executionTime:index}}]})
 observe(1,2024);const before=refreshEnterpriseDifferences(db,{enterpriseIds:[id]},at)
 observe(2,2024);const same=refreshEnterpriseDifferences(db,{enterpriseIds:[id]},at)
 expect(same.refreshed).toBe(0);expect(same.unchanged).toBe(3)
 expect(same.enterprises[0]!.comparisons).toEqual(before.enterprises[0]!.comparisons)
 observe(3,2025);const changed=refreshEnterpriseDifferences(db,{enterpriseIds:[id]},at)
 expect(changed.refreshed).toBe(1);expect(changed.unchanged).toBe(2)
 expect(changed.enterprises[0]!.comparisons.find(c=>c.titleCode==='specialized_sme')!.status).toBe('needs_review')
})

it('new native source row title changes reset only the affected business comparison',()=>{
 const {db,ids}=fixture(),id=ids[0]!
 const observe=(day:number,title:string)=>submitNativePlatformQuery(db,{interface:'business_list',queryKey:'91330211255994451P',rdjb:'2',titleCode:'specialized_sme',queriedAt:`2026-11-0${day}T00:00:00Z`,status:'success',rawResponse:JSON.stringify({id:'row-title',rdjb:title}),relations:[{sequenceNo:1,enterpriseId:id,relationKey:'row-title',rawFields:{id:'row-title',rdjb:title}}]})
 observe(1,'2'); const before=refreshEnterpriseDifferences(db,{enterpriseIds:[id]},at)
 observe(2,'2'); const same=refreshEnterpriseDifferences(db,{enterpriseIds:[id]},at)
 expect(same.refreshed).toBe(0);expect(same.enterprises[0]!.comparisons).toEqual(before.enterprises[0]!.comparisons)
 observe(3,'3');const changed=refreshEnterpriseDifferences(db,{enterpriseIds:[id]},at)
 expect(changed.refreshed).toBeGreaterThan(0)
 expect(changed.enterprises[0]!.comparisons.find(c=>c.titleCode==='specialized_sme')!.status).toBe('needs_review')
})
