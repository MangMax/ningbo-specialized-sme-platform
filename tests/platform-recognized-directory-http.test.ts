import { afterEach, expect, it } from 'vitest'
import { nativeCatalogFixture } from './helpers/native-catalog-fixture'
const fixtures:ReturnType<typeof nativeCatalogFixture>[]=[]
const fixture=()=>{const f=nativeCatalogFixture();fixtures.push(f);return f}
afterEach(()=>{for(const f of fixtures.splice(0))f.close()})

it('native directory uses exact raw validity dates and same-version filter conjunctions',async()=>{
 const f=fixture();f.seed('recognized_list',f.raw('DIR',{rddqrq:'2028',whpcyear:'2024',whpc:'A'}));f.seed('recognized_list',f.raw('DIR',{rddqrq:'2028-12-31',whpcyear:'2025',whpc:'B'}))
 const api=await f.http();try{const exact=await(await fetch(api.baseUrl+'/catalog?source=recognized_list&rddqrq=2028')).json();expect(exact.total).toBe(1);expect(exact.rows[0].matchedVersion.validityDateRaw).toBe('2028');const cross=await(await fetch(api.baseUrl+'/catalog?source=recognized_list&rddqrq=2028&whpcyear=2025')).json();expect(cross.total).toBe(0);expect((await fetch(api.baseUrl+'/catalog?source=recognized_list&unknown=1')).status).toBe(400)}finally{await api.close()}
})
it('native directory keeps original row title apart from explicit collection scope',()=>{
 const f=fixture();f.seed('recognized_list',f.raw('TITLE',{rdjb:'3'}),'2')
 expect(f.list('recognized_list',{titleRaw:'3'})).toMatchObject({total:1})
 expect(f.list('recognized_list',{titleRaw:'2'})).toMatchObject({total:0})
 expect(f.list('recognized_list').rows[0]!.conflicts).toContain('title_conflict')
})
