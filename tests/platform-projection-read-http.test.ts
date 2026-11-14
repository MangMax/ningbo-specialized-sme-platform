import { afterEach, expect, it } from 'vitest'
import { nativeCatalogFixture } from './helpers/native-catalog-fixture'
const fixtures:ReturnType<typeof nativeCatalogFixture>[]=[]
const fixture=()=>{const f=nativeCatalogFixture();fixtures.push(f);return f}
afterEach(()=>{for(const f of fixtures.splice(0))f.close()})

it('three native public catalogs distinguish missing facts from literal values without raw hydration',async()=>{
 const f=fixture();for(const source of ['apply_list','business_list','recognized_list'] as const){f.seed(source,f.raw('EMPTY'));f.seed(source,f.raw('LITERAL',{sblx:'申请',year:'2024',cszt:'unknown-status',rddqrq:'原值日期',whpc:'0'}))}
 const api=await f.http();try{for(const source of ['apply_list','business_list','recognized_list']){const response=await fetch(api.baseUrl+'/catalog?source='+source);expect(response.status).toBe(200);const data=await response.json();expect(data.total).toBe(2);const empty=data.rows.find((r:any)=>r.record.platformKey==='EMPTY');expect(empty.matchedVersion.ruleVersion).toBeTruthy();if(source==='recognized_list')expect(empty.matchedVersion.validityDateRaw).toBeNull();else expect(empty.matchedVersion.status).toBeNull();expect(JSON.stringify(data)).not.toContain('rawFields')}}finally{await api.close()}
})
