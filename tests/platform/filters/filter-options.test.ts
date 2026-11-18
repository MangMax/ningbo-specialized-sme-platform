import { afterEach, expect, it } from 'vitest'
import { nativeCatalogFixture } from '../fixtures/native-catalog'
const fixtures:ReturnType<typeof nativeCatalogFixture>[]=[]
const fixture=()=>{const f=nativeCatalogFixture();fixtures.push(f);return f}
afterEach(()=>{for(const f of fixtures.splice(0))f.close()})

import { readTargetDeclarationOptions } from '../../../layers/sme-roster/server/utils/platform-declarations-target'
import { readTargetBusinessProcessOptions } from '../../../layers/sme-roster/server/utils/platform-business-processes-target'
import { readTargetRecognizedOptions } from '../../../layers/sme-roster/server/utils/platform-recognized-target'
import { platformFilterOptionsQueryFromQuery } from '../../../layers/sme-roster/lib/platform/filter-options'
it('native filter options preserve source-specific literal values without inventing facts',()=>{
 const f=fixture();f.seed('apply_list',f.raw('APPLY',{sblx:'申请',year:2024,cszt:'原状态'}));f.seed('business_list',f.raw('PROCESS',{sblx:'复核',year:2025,whpc:'原批次'}));f.seed('recognized_list',f.raw('DIRECTORY',{rddqrq:'非日期',whpcyear:'2026',whpc:'目录批次',szq:'3302'}))
 expect(readTargetDeclarationOptions('records',f.db)).toMatchObject({declareKinds:['apply'],years:[2024],statuses:['原状态']})
 expect(readTargetBusinessProcessOptions('records',f.db)).toMatchObject({declareKinds:['review'],years:[2025],batches:['原批次']})
 expect(readTargetRecognizedOptions('records',f.db)).toMatchObject({validityDates:['非日期'],batches:['目录批次'],districts:['3302']})
})
it('filter option query validation rejects unsupported source and repeated view',()=>{
 expect(()=>platformFilterOptionsQueryFromQuery({source:'unknown'})).toThrow()
 expect(()=>platformFilterOptionsQueryFromQuery({source:'declarations',view:['records','isolated']})).toThrow()
})
