import { afterAll, expect, it, vi } from 'vitest'
import { qualificationExportFixture } from '../current-export/fixtures/qualification-export'
import { getComparison } from '../../../lib/comparison'
import { listRosterDifferences } from '../../../lib/roster/difference-list'
import { getRosterEnterpriseDetail } from '../../../lib/roster/enterprise-roster'
import { selectEnterpriseCoordinates } from '../../../lib/roster/enterprise-list-selection'
import { listRosterDifferences as legacyDifferences } from '../../../lib/roster/enterprise-roster'
import { listDifferences } from '../../../server/utils/mcp-roster'
const f = qualificationExportFixture()
afterAll(() => { vi.useRealTimers(); return f.close() })
it('removes inherited current extras but retains source coordinates and stored history through expiry', () => {
 vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-06-01T00:00:00Z'))
 const c=f.candidate('current-overlay',[{eventType:'award',year:2025,batchSeq:1}],'specialized_sme')
 f.db.$client.prepare("insert into record (enterprise_id,title_code,source,name_raw) values (?,'innovative_sme','miit','current-overlay')").run(c.enterprise.id)
 const scope={title:['innovative_sme'],direction:['extra_in_miit'] as ['extra_in_miit']}
 expect(getComparison(f.db).rows).toContainEqual(expect.objectContaining({enterpriseId:c.enterprise.id,titleCode:'innovative_sme',direction:'extra_in_miit'}))
 expect(listRosterDifferences(f.db,scope).total).toBe(0)
 expect(legacyDifferences(f.db,scope).total).toBe(0)
 expect(selectEnterpriseCoordinates(f.db,{}).candidates.find(r=>r.id===c.enterprise.id)!.difference.count).toBe(1)
 const head=f.db.$client.prepare("insert into difference_reason (enterprise_id,title_code,direction,status,created_at,recorded_at) values (?,'innovative_sme','extra_in_miit','needs_review','2026-01-01','2026-01-01') returning *").get(c.enterprise.id)
 expect(listRosterDifferences(f.db,scope)).toMatchObject({total:1,counts:{innovative_sme:{extra_in_miit:1}},rows:[{inCurrentDifference:false,status:'needs_review'}]})
 expect(legacyDifferences(f.db,scope).rows[0]).toMatchObject({inCurrentDifference:false})
 const stored=listDifferences(f.db,{title:'innovative_sme'})
 expect(stored.rows).toMatchObject([{enterpriseId:c.enterprise.id,status:'needs_review'}])
 expect(getRosterEnterpriseDetail(f.db,c.enterprise.id)!.differences.find(r=>r.titleCode==='innovative_sme')).toMatchObject({inCurrentDifference:false})
 expect(selectEnterpriseCoordinates(f.db,{}).candidates.find(r=>r.id===c.enterprise.id)!.difference.count).toBe(2)
 vi.setSystemTime(new Date('2029-06-01T00:00:00Z'))
 expect(listRosterDifferences(f.db,scope).rows[0]).toMatchObject({inCurrentDifference:true})
 expect(listDifferences(f.db,{title:'innovative_sme'})).toEqual(stored)
 expect(f.db.$client.prepare('select * from difference_reason').get()).toEqual(head)
})

it('keeps platform-only extras without a verified higher title and recomputes after upper source changes', () => {
 vi.setSystemTime(new Date('2026-06-01T00:00:00Z'))
 const c=f.candidate('source-withdrawal',[{eventType:'award',year:2025,batchSeq:1}],'little_giant')
 f.db.$client.prepare("insert into record (enterprise_id,title_code,source,name_raw) values (?,'innovative_sme','miit','source-withdrawal')").run(c.enterprise.id)
 const read=()=>listRosterDifferences(f.db,{q:'source-withdrawal',title:['innovative_sme'],direction:['extra_in_miit'],pageSize:1})
 expect(read()).toMatchObject({total:0,rows:[],counts:{innovative_sme:{extra_in_miit:0}}})
 const before=f.db.$client.prepare('select count(*) n from record_event').get()
 f.db.$client.prepare('update record_event set year=2018 where record_id=?').run(c.record.id)
 expect(read()).toMatchObject({total:1,rows:[{enterpriseId:c.enterprise.id,inCurrentDifference:true}],counts:{innovative_sme:{extra_in_miit:1}}})
 expect(f.db.$client.prepare('select count(*) n from record_event').get()).toEqual(before)
})

it('retains an invalid own lower title as current extra without a higher basis',()=>{
 vi.setSystemTime(new Date('2026-06-01T00:00:00Z'))
 const c=f.candidate('invalid-own',[{eventType:'award',year:2018,batchSeq:1}],'innovative_sme')
 f.db.$client.prepare('update enterprise set uscc_norm=null where id=?').run(c.enterprise.id)
 f.db.$client.prepare("insert into record (enterprise_id,title_code,source,name_raw) values (?,'innovative_sme','miit','invalid-own')").run(c.enterprise.id)
 expect(listRosterDifferences(f.db,{q:'invalid-own',direction:['extra_in_miit']})).toMatchObject({total:1,rows:[{enterpriseId:c.enterprise.id,inCurrentDifference:true}]})
})
