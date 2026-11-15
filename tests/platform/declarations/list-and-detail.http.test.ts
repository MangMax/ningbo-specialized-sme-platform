import { afterEach, expect, it } from 'vitest'
import { nativeCatalogFixture } from '../../helpers/native-catalog-fixture'
const fixtures:ReturnType<typeof nativeCatalogFixture>[]=[]
const fixture=()=>{const f=nativeCatalogFixture();fixtures.push(f);return f}
afterEach(()=>{for(const f of fixtures.splice(0))f.close()})

it('native declaration HTTP filters the matched content version and bounds pages',async()=>{
 const f=fixture();f.seed('apply_list',f.raw('A',{sblx:'申请',year:2024,cszt:'通过'}));f.seed('apply_list',f.raw('A',{sblx:'复核',year:2025,cszt:'待审'}));f.seed('apply_list',f.raw('B',{sblx:'申请',year:2024,cszt:'通过'}))
 const api=await f.http();try{const result=await(await fetch(api.baseUrl+'/catalog?source=apply_list&year=2024&declareKind=apply&pageSize=1')).json();expect(result).toMatchObject({total:2,pageSize:1});expect(result.rows).toHaveLength(1);expect(result.rows[0].matchedVersion).toMatchObject({declarationYear:2024,declareKind:'apply'});expect((await fetch(api.baseUrl+'/catalog?source=apply_list&pageSize=201')).status).toBe(400)}finally{await api.close()}
})
