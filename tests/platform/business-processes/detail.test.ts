import { afterEach, expect, it } from 'vitest'
import { nativeCatalogFixture } from '../fixtures/native-catalog'
const fixtures:ReturnType<typeof nativeCatalogFixture>[]=[]
const fixture=()=>{const f=nativeCatalogFixture();fixtures.push(f);return f}
afterEach(()=>{for(const f of fixtures.splice(0))f.close()})

import { getRosterEnterpriseDetail } from '../../../layers/sme-roster/lib/roster/enterprise-roster'
it('native enterprise detail retains business identity with A B A and independent interface records',()=>{
 const f=fixture(),raw=f.raw('DETAIL',{sblx:'申请',year:2024,cszt:'通过'})
 f.seed('business_list',raw);f.seed('business_list',{...raw,cszt:'退回'});f.seed('business_list',raw);f.seed('apply_list',raw)
 const detail=getRosterEnterpriseDetail(f.db,f.enterprise.id)
 expect(detail!.platform.businessRecords).toHaveLength(2)
 expect(detail!.platform.businessRecords.find(row=>row.businessRecord.interface==='business_list')).toMatchObject({versionCount:2,observationCount:3})
 expect(detail!.platform.businessRecords.find(row=>row.businessRecord.interface==='apply_list')).toMatchObject({versionCount:1,observationCount:1})
 const business=f.list('business_list');expect(business).toMatchObject({total:1,rows:[{versionCount:2,observationCount:3}]})
 expect(f.list('apply_list')).toMatchObject({total:1,rows:[{versionCount:1,observationCount:1}]})
})
