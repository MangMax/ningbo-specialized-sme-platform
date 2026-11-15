import { afterEach, expect, it } from 'vitest'
import { nativeCatalogFixture } from '../fixtures/native-catalog'
import { listCurrentQualified } from '../../../lib/roster/current-qualified-query'
import { schema } from '../../../db/client'
const fixtures:ReturnType<typeof nativeCatalogFixture>[]=[]
const fixture=()=>{const f=nativeCatalogFixture();fixtures.push(f);return f}
afterEach(()=>{for(const f of fixtures.splice(0))f.close()})
it('native directory raw validity versions retain independent formal eligibility',()=>{
 const f=fixture()
 const eligibility=()=>{const result=listCurrentQualified(f.db.$client,{titleCode:'specialized_sme'});return {total:result.total,rows:result.rows.map(row=>({enterpriseId:row.enterpriseId,firstYear:row.firstYear,recognition:row.recognition}))}}
 const expected={total:1,rows:[{enterpriseId:f.enterprise.id,firstYear:null,recognition:{precision:'year',year:2024}}]}
 expect(eligibility()).toEqual(expected)
 f.seed('recognized_list',f.raw('DIRECTORY',{rddqrq:'2099-12-31',whpcyear:'2099'}))
 expect(f.list('recognized_list')).toMatchObject({total:1});expect(eligibility()).toEqual(expected)
 f.seed('recognized_list',f.raw('DIRECTORY',{rddqrq:'原样未知',whpcyear:'2024'}))
 expect(eligibility()).toEqual(expected)
})
it('native directory presence cannot grant a title without an official award',()=>{
 const f=fixture();f.db.delete(schema.recordEvent).run()
 f.seed('recognized_list',f.raw('DIRECTORY-ONLY',{rddqrq:'2099-12-31',whpcyear:'2099'}))
 expect(f.list('recognized_list')).toMatchObject({total:1})
 expect(listCurrentQualified(f.db.$client,{titleCode:'specialized_sme'})).toMatchObject({total:0,rows:[]})
})
