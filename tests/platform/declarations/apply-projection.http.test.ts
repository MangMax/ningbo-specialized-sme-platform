import { afterEach, expect, it } from 'vitest'
import { nativeCatalogFixture } from '../fixtures/native-catalog'
const fixtures:ReturnType<typeof nativeCatalogFixture>[]=[]
const fixture=()=>{const f=nativeCatalogFixture();fixtures.push(f);return f}
afterEach(()=>{for(const f of fixtures.splice(0))f.close()})

it('apply_list native writer exposes literal source fields through HTTP without raw JSON',async()=>{
 const f=fixture();f.seed('apply_list',f.raw('SOURCE-1',{...{sblx:'申请',year:'2024',sqsj:'2024-03-01',cszt:'待审核'},privateMarker:'PRIVATE-SOURCE-RAW'}))
 const api=await f.http()
 try{const response=await fetch(api.baseUrl+'/catalog?source=apply_list');expect(response.status).toBe(200);expect(response.headers.get('cache-control')).toBe('no-store');const data=await response.json();expect(data).toMatchObject({total:1,rows:[{matchedVersion:{declareKind:'apply',declarationYear:2024,status:'待审核'}}]});expect(JSON.stringify(data)).not.toContain('PRIVATE-SOURCE-RAW')}finally{await api.close()}
})
it('apply_list native repeated content reuses a version while changed content creates independent history',()=>{
 const f=fixture(),raw=f.raw('SOURCE-1',{sblx:'申请',year:'2024',sqsj:'2024-03-01',cszt:'待审核'})
 const a=f.seed('apply_list',raw),b=f.seed('apply_list',raw),c=f.seed('apply_list',{...raw,sourceRevision:'changed'})
 expect(a.observations[0]!.versionId).toBe(b.observations[0]!.versionId);expect(c.observations[0]!.versionId).not.toBe(a.observations[0]!.versionId)
 expect(f.list('apply_list')).toMatchObject({total:1,rows:[{versionCount:2,observationCount:3}]})
 expect(f.detail('apply_list',a.observations[0]!.recordId!)).toMatchObject({versions:expect.any(Array)})
})
