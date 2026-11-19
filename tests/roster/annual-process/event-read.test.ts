import { afterEach, expect, it } from 'vitest'
import { nativeCatalogFixture } from '../../platform/fixtures/native-catalog'
const fixtures:ReturnType<typeof nativeCatalogFixture>[]=[]
const fixture=()=>{const f=nativeCatalogFixture();fixtures.push(f);return f}
afterEach(()=>{for(const f of fixtures.splice(0))f.close()})

import { readEventAnnualProcess } from '../../../layers/sme-roster/server/utils/event-annual-process-read'
import { handleEventAnnualProcessRequest, dispatchEventAnnualProcessMcp } from '../../../layers/sme-roster/server/utils/event-annual-process-api'
it('native annual facts retain A B A versions and selected observation decisions without writes',()=>{
 const f=fixture(),raw=f.raw('ANNUAL',{sblx:'申请',year:2024,sqsj:'2024-03-01',cszt:'终审通过'})
 const a=f.seed('business_list',raw);f.seed('business_list',{...raw,cszt:'终审不通过'});f.seed('business_list',raw)
 f.save(f.request('old-confirmation',[{action:'create',status:'confirmed',edge:f.edge(a.relationIds[0]!)}]))
 const before=f.db.$client.prepare('select total_changes() n').get(),annual=readEventAnnualProcess(f.db,f.event.id)!
 expect(annual.process.steps).toHaveLength(1);expect(annual.sourceRefs.observations).toHaveLength(3)
 const rest=handleEventAnnualProcessRequest({method:'GET',id:f.event.id,query:{pageSize:1}},{db:f.db})
 expect(rest.status).toBe(200);expect(dispatchEventAnnualProcessMcp({eventId:f.event.id,pageSize:1},{db:f.db})).toEqual(rest.body)
 expect(f.db.$client.prepare('select total_changes() n').get()).toEqual(before)
})
it('native annual generation changes for appended sources while retaining historical observations',()=>{
 const f=fixture();f.seed('business_list',f.raw('OLD',{sblx:'申请',year:2024,sqsj:'2024-01-01',cszt:'终审通过'}));const old=readEventAnnualProcess(f.db,f.event.id)!
 f.seed('business_list',f.raw('NEW',{sblx:'申请',year:2024,sqsj:'2024-12-01',cszt:'终审不通过'}));const current=readEventAnnualProcess(f.db,f.event.id)!
 expect(current.sourceGeneration).not.toBe(old.sourceGeneration);expect(current.sourceRefs.observations).toHaveLength(2);expect(current.process.finalCandidateStepId).toBeNull()
})
