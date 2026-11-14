import { afterEach, expect, it } from 'vitest'
import { nativeCatalogFixture } from './helpers/native-catalog-fixture'
const fixtures:ReturnType<typeof nativeCatalogFixture>[]=[]
const fixture=()=>{const f=nativeCatalogFixture();fixtures.push(f);return f}
afterEach(()=>{for(const f of fixtures.splice(0))f.close()})

it('recognized_list native writer exposes literal source fields through HTTP without raw JSON',async()=>{
 const f=fixture();f.seed('recognized_list',f.raw('SOURCE-1',{...{rddqrq:'2028/12/31',whpcyear:'2024',whpc:'原批次',szq:'3302',rdxx:'原认定说明'},privateMarker:'PRIVATE-SOURCE-RAW'}))
 const api=await f.http()
 try{const response=await fetch(api.baseUrl+'/catalog?source=recognized_list');expect(response.status).toBe(200);expect(response.headers.get('cache-control')).toBe('no-store');const data=await response.json();expect(data).toMatchObject({total:1,rows:[{matchedVersion:{validityDateRaw:'2028/12/31',maintenanceYear:2024,maintenanceBatch:'原批次',district:'3302',awardNote:'原认定说明'}}]});expect(JSON.stringify(data)).not.toContain('PRIVATE-SOURCE-RAW')}finally{await api.close()}
})
it('recognized_list native repeated content reuses a version while changed content creates independent history',()=>{
 const f=fixture(),raw=f.raw('SOURCE-1',{rddqrq:'2028/12/31',whpcyear:'2024',whpc:'原批次',szq:'3302',rdxx:'原认定说明'})
 const a=f.seed('recognized_list',raw),b=f.seed('recognized_list',raw),c=f.seed('recognized_list',{...raw,sourceRevision:'changed'})
 expect(a.observations[0]!.versionId).toBe(b.observations[0]!.versionId);expect(c.observations[0]!.versionId).not.toBe(a.observations[0]!.versionId)
 expect(f.list('recognized_list')).toMatchObject({total:1,rows:[{versionCount:2,observationCount:3}]})
 expect(f.detail('recognized_list',a.observations[0]!.recordId!)).toMatchObject({versions:expect.any(Array)})
})
