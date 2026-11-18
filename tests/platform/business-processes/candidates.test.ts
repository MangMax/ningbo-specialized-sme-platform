import { afterEach, expect, it } from 'vitest'
import { nativeCatalogFixture } from '../fixtures/native-catalog'
const fixtures:ReturnType<typeof nativeCatalogFixture>[]=[]
const fixture=()=>{const f=nativeCatalogFixture();fixtures.push(f);return f}
afterEach(()=>{for(const f of fixtures.splice(0))f.close()})

import { z } from 'zod'
const observationRefs = (row: Record<string, unknown>) => z.array(z.object({relationId:z.number()})).parse(row.observationRefs)
import { generateCandidates } from '../../../layers/sme-roster/server/utils/record-correspondence-candidates'
it('native candidates group identical versions and retain opposite observation-local decisions',()=>{
 const f=fixture(),raw=f.raw('CANDIDATE',{sblx:'申请',year:2024}),a=f.seed('business_list',raw),b=f.seed('business_list',raw)
 for(const [seed,status] of [[a,'confirmed'],[b,'rejected']] as const)f.save(f.request(status,[{action:'create',status,edge:f.edge(seed.relationIds[0]!)}]))
 const result=generateCandidates(f.db,{eventId:f.event.id,queryIds:[a.queryId,b.queryId],exportBatchIds:[],ruleVersion:'native',page:1,pageSize:25})!
 expect(result).toMatchObject({total:1,rows:[{conflicts:expect.arrayContaining(['correspondence_decision_conflict'])}]})
 expect(observationRefs(result.rows[0]!).map(r=>r.relationId)).toEqual([a.relationIds[0],b.relationIds[0]])
 expect(result.rows[0]!.existingCorrespondenceIds).toHaveLength(2)
})
it('native candidates use only explicitly selected query sources',()=>{
 const f=fixture(),a=f.seed('business_list',f.raw('SELECTED',{sblx:'申请',year:2024})),b=f.seed('business_list',f.raw('UNSELECTED',{sblx:'申请',year:2024}))
 const result=generateCandidates(f.db,{eventId:f.event.id,queryIds:[a.queryId],exportBatchIds:[],ruleVersion:'native',page:1,pageSize:25})!
 expect(result.total).toBe(1);expect(result.rows.flatMap(observationRefs).map(r=>r.relationId)).toEqual([a.relationIds[0]])
 expect(result.rows.flatMap(observationRefs).some(r=>r.relationId===b.relationIds[0])).toBe(false)
})
