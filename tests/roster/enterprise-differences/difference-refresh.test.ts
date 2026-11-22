import { seedPostgresPlatformQuery } from '../../platform/fixtures/postgres-query'
import { expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import * as schema from '../fixtures/postgres-tables'
import { enterpriseDifferenceComparison } from '../../../db/postgresql/roster-selection-tables'
import { useIsolatedPostgresCases, singlePostgresFixtureRow } from '../../support/isolated-postgres-cases'
import { refreshPostgresEnterpriseDifferences, readPostgresEnterpriseDifferenceComparisons } from '../../../layers/sme-roster/server/utils/enterprise-difference-refresh-postgres'
import { readPostgresCurrentQualification } from '../../../layers/sme-roster/lib/roster/current-qualification-postgres'
import { listPostgresRosterEnterprises } from '../../../layers/sme-roster/lib/roster/enterprise-list-postgres'

const openDatabase = useIsolatedPostgresCases()
async function fixture() {
  const db = openDatabase()
  const ids: number[] = []
  for (const i of [1, 2]) {
    const enterprise = singlePostgresFixtureRow(await db.insert(schema.enterprise).values({
      name: `刷新${i}`, nameNorm: `刷新${i}`, usccNorm: `9133021125599445${i}P`,
    }).returning())
    await db.insert(schema.record).values({enterpriseId:enterprise.id,titleCode:'specialized_sme',source:'jxj',nameRaw:enterprise.name})
    await db.insert(schema.rosterLegacyMember).values({ enterpriseId: enterprise.id })
    ids.push(enterprise.id)
  }
  return { db, ids }
}
const at='2026-11-06T00:00:00.000Z'
it('refresh defaults to pending, scopes enterprise IDs and preserves qualifications', async () => {
 const {db,ids}=await fixture()
 const assessment = () => db.transaction(tx => readPostgresCurrentQualification(tx, ids[0]!, Date.parse(at)), { isolationLevel: 'repeatable read', accessMode: 'read only' })
 const before=await assessment()
 const result=await refreshPostgresEnterpriseDifferences(db,{enterpriseIds:[ids[0]!] },at)
 expect(result.refreshed).toBe(3);expect(result.enterprises.map(e=>e.enterpriseId)).toEqual([ids[0]])
 expect(result.enterprises[0]!.comparisons.every(c=>c.status==='needs_review')).toBe(true)
 expect(await db.select().from(enterpriseDifferenceComparison).where(eq(enterpriseDifferenceComparison.enterpriseId, ids[1]!))).toEqual([])
 expect(await assessment()).toEqual(before)
 expect((await listPostgresRosterEnterprises(db,{page:1,pageSize:20})).rows.find(e=>e.enterpriseId===ids[0])!.difference.status).toBe('needs_review')
})
it('same business rows with new query ID and collection time preserve existing judgment', async () => {
 const {db,ids}=await fixture(),id=ids[0]!
 const observe=(time:string)=>seedPostgresPlatformQuery(db,{interface:'business_list',queryKey:'91330211255994451P',rdjb:'2',titleCode:'specialized_sme',queriedAt:time,status:'success',rawResponse:JSON.stringify({executionTime:time}),relations:[{sequenceNo:1,enterpriseId:id,relationKey:'fixed-business-key',nameRaw:'业务名',status:'通过'}]})
 await observe('2026-11-04T00:00:00Z')
 const first=await refreshPostgresEnterpriseDifferences(db,{enterpriseIds:[id]},at)
 await db.insert(schema.differenceReason).values({enterpriseId:id,titleCode:'specialized_sme',direction:'missing_in_miit',status:'confirmed_no_diff',recordedAt:'2026-11-06T00:00:01.000Z',createdAt:'2026-11-06T00:00:01.000Z'})
 await observe('2026-11-05T00:00:00Z')
 const repeat=await refreshPostgresEnterpriseDifferences(db,{enterpriseIds:[id]},'2026-11-06T00:00:02.000Z')
 expect(repeat.refreshed).toBe(0);expect(repeat.unchanged).toBe(3)
 expect(repeat.enterprises[0]!.comparisons.find(c=>c.titleCode==='specialized_sme')!.status).toBe('confirmed_no_diff')
 expect(repeat.enterprises[0]!.comparisons.map(c=>[c.titleCode,c.businessFingerprint,c.comparisonState])).toEqual(first.enterprises[0]!.comparisons.map(c=>[c.titleCode,c.businessFingerprint,c.comparisonState]))
 expect((await listPostgresRosterEnterprises(db,{page:1,pageSize:20})).rows.find(e=>e.enterpriseId===id)!.difference.status).toBe('confirmed_no_diff') // preserve existing list aggregation priority
})
it('business field change resets only the affected title to pending', async () => {
 const {db,ids}=await fixture(),id=ids[0]!
 const r=(await db.select().from(schema.record).orderBy(schema.record.id))[0]!
 await refreshPostgresEnterpriseDifferences(db,{enterpriseIds:[id]},at)
 await db.insert(schema.differenceReason).values({enterpriseId:id,titleCode:'specialized_sme',direction:'missing_in_miit',status:'confirmed_no_diff',recordedAt:'2026-11-06T00:00:01.000Z',createdAt:'2026-11-06T00:00:01.000Z'})
 await db.update(schema.record).set({ nameRaw: '变更后的正式业务名' }).where(eq(schema.record.id,r.id))
 const changed=await refreshPostgresEnterpriseDifferences(db,{enterpriseIds:[id]},'2026-11-06T00:00:02.000Z')
 expect(changed.refreshed).toBe(1);expect(changed.unchanged).toBe(2)
 expect(changed.enterprises[0]!.comparisons.find(c=>c.titleCode==='specialized_sme')!.status).toBe('needs_review')
 expect(await db.select().from(schema.differenceReason)).toHaveLength(1)
})
it('invalid empty duplicate unknown and malformed scopes fail without writes', async () => {
 const {db,ids}=await fixture()
 for(const input of [{enterpriseIds:[]},{enterpriseIds:[ids[0],ids[0]]},{enterpriseIds:[999]},{enterpriseIds:['1']},{enterpriseIds:[0]},{unexpected:true}])await expect(refreshPostgresEnterpriseDifferences(db,input,at)).rejects.toThrow()
 expect(await db.select().from(enterpriseDifferenceComparison)).toEqual([])
})
it('default scope is published enterprises and GET reads persisted current results', async () => {
 const {db}=await fixture()
 const r=await refreshPostgresEnterpriseDifferences(db,{},at)
 expect(r.enterprises).toHaveLength(2)
 expect((await readPostgresEnterpriseDifferenceComparisons(db,{})).enterprises).toEqual(r.enterprises)
})
it('new content version hashes with identical typed business fields preserve the comparison', async () => {
 const {db,ids}=await fixture(),id=ids[0]!
 const observe=(index:number,businessYear:number)=>seedPostgresPlatformQuery(db,{interface:'business_list',queryKey:'91330211255994451P',titleCode:'specialized_sme',rdjb:'2',queriedAt:`2026-11-0${index}T00:00:00Z`,status:'success',rawResponse:JSON.stringify({executionTime:index}),relations:[{sequenceNo:1,enterpriseId:id,relationKey:'business-1',nameRaw:'同名',year:businessYear,rawFields:{id:'business-1',qymc:'同名',year:String(businessYear),executionTime:index}}]})
 await observe(1,2024);const before=await refreshPostgresEnterpriseDifferences(db,{enterpriseIds:[id]},at)
 await observe(2,2024);const same=await refreshPostgresEnterpriseDifferences(db,{enterpriseIds:[id]},at)
 expect(same.refreshed).toBe(0);expect(same.unchanged).toBe(3)
 expect(same.enterprises[0]!.comparisons).toEqual(before.enterprises[0]!.comparisons)
 await observe(3,2025);const changed=await refreshPostgresEnterpriseDifferences(db,{enterpriseIds:[id]},at)
 expect(changed.refreshed).toBe(1);expect(changed.unchanged).toBe(2)
 expect(changed.enterprises[0]!.comparisons.find(c=>c.titleCode==='specialized_sme')!.status).toBe('needs_review')
})

it('new native source row title changes reset only the affected business comparison', async () => {
 const {db,ids}=await fixture(),id=ids[0]!
 const observe=(day:number,title:string)=>seedPostgresPlatformQuery(db,{interface:'business_list',queryKey:'91330211255994451P',rdjb:'2',titleCode:'specialized_sme',queriedAt:`2026-11-0${day}T00:00:00Z`,status:'success',rawResponse:JSON.stringify({id:'row-title',rdjb:title}),relations:[{sequenceNo:1,enterpriseId:id,relationKey:'row-title',rawFields:{id:'row-title',rdjb:title}}]})
 await observe(1,'2'); const before=await refreshPostgresEnterpriseDifferences(db,{enterpriseIds:[id]},at)
 await observe(2,'2'); const same=await refreshPostgresEnterpriseDifferences(db,{enterpriseIds:[id]},at)
 expect(same.refreshed).toBe(0);expect(same.enterprises[0]!.comparisons).toEqual(before.enterprises[0]!.comparisons)
 await observe(3,'3');const changed=await refreshPostgresEnterpriseDifferences(db,{enterpriseIds:[id]},at)
 expect(changed.refreshed).toBeGreaterThan(0)
 expect(changed.enterprises[0]!.comparisons.find(c=>c.titleCode==='specialized_sme')!.status).toBe('needs_review')
})
