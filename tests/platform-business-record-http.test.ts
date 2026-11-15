import { afterEach, expect, it } from 'vitest'
import { nativeCatalogFixture } from './helpers/native-catalog-fixture'
const fixtures:ReturnType<typeof nativeCatalogFixture>[]=[]
const fixture=()=>{const f=nativeCatalogFixture();fixtures.push(f);return f}
afterEach(()=>{for(const f of fixtures.splice(0))f.close()})

it('native A B A history preserves versions and scoped observations through public business reads',async()=>{
 const f=fixture(),raw=f.raw('ABA',{sblx:'申请',year:2024,cszt:'原状态'})
 const a=f.seed('business_list',raw),b=f.seed('business_list',{...raw,cszt:'新状态'}),last=f.seed('business_list',raw)
 expect(last.observations[0]!.versionId).toBe(a.observations[0]!.versionId);expect(b.observations[0]!.versionId).not.toBe(a.observations[0]!.versionId)
 const api=await f.http();try{const data=await(await fetch(api.baseUrl+'/catalog?source=business_list')).json();expect(data).toMatchObject({total:1,rows:[{versionCount:2,observationCount:3}]})}finally{await api.close()}
})
it('native records retain separate identity namespaces across three platform interfaces',()=>{
 const f=fixture();for(const source of ['apply_list','business_list','recognized_list'] as const)f.seed(source,f.raw('SAME'))
 const ids=['apply_list','business_list','recognized_list'].map(source=>f.list(source as 'apply_list').rows.filter(row=>row.kind==='record')[0]!.record.id)
 expect(new Set(ids).size).toBe(3)
})
