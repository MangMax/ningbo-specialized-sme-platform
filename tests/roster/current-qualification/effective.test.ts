import { afterAll, expect, it } from 'vitest'
import { currentExport409Fixture } from '../../helpers/current-export-409'
import { createCurrentQualificationAssessmentReader, PREVIOUS_QUALIFICATION_ASSESSMENT_VERSION } from '../../../lib/roster/current-qualification'
import { schema } from '../../../db/client'
const f = currentExport409Fixture()
afterAll(() => f.close())
const asOf = Date.parse('2026-11-05T12:00:00Z')
function read(id: number) { return createCurrentQualificationAssessmentReader(f.db.$client).read(id, asOf).snapshot.titles.find(t => t.titleCode === 'specialized_sme')! }
function fact(id: number, kind: string, status = 'confirmed', reference = 'official reference', effective = '2026-01-01') {
  f.db.insert(schema.enterpriseFactRevision).values({ enterpriseId:id,factId:1,revision:1,status:status as 'confirmed',fact:{kind,source:{reference,statement:'official statement'},effective:{precision:'day',value:effective},observed:{precision:'day',value:'2026-01-01'},city:null},action:'assert',actor:{type:'agent',id:'test478'},basis:'verified basis',createdAt:'2026-01-01T00:00:00Z' }).run()
}
it.each(['cancelled','moved_out'])('excludes only a complete confirmed %s fact', kind => {
 const c = f.candidate('complete-'+kind,[{eventType:'award',year:2025,batchSeq:1}]); fact(c.enterprise.id,kind)
 expect(read(c.enterprise.id)).toMatchObject({group:'excluded',effectiveQualification:{status:kind === 'cancelled' ? 'terminated' : 'moved_out'}})
})
it.each(['cancelled','moved_out'])('retains eligibility for incomplete or unconfirmed %s', kind => {
 for (const [status,reference,date] of [['pending','ref','2026-01-01'],['confirmed','','2026-01-01'],['confirmed','ref','2027-01-01']]) {
  const c=f.candidate('incomplete-'+kind+status+reference+date,[{eventType:'award',year:2025,batchSeq:1}]); fact(c.enterprise.id,kind,status,reference,date)
  expect(read(c.enterprise.id)).toMatchObject({group:'eligible',effectiveQualification:{status:'effective'}})
 }
})
it.each(['moved_in','registration_status'])('does not let %s establish eligibility', kind => {
 const c=f.candidate('nonaward-'+kind,[{eventType:'nurture',year:2025}]); fact(c.enterprise.id,kind)
 expect(read(c.enterprise.id)).toMatchObject({group:'excluded',effectiveQualification:{status:'unrecognized'}})
})
it('retains previous assessment behavior explicitly while source and identity gaps become notes', () => {
 const c=f.candidate('source-gap',[{eventType:'award',year:2025,batchSeq:1}])
 f.db.$client.prepare('delete from record_evidence where record_event_id in (select id from record_event where record_id=?)').run(c.record.id)
 expect(read(c.enterprise.id)).toMatchObject({group:'eligible',effectiveQualification:{status:'effective'}})
 const old=createCurrentQualificationAssessmentReader(f.db.$client).read(c.enterprise.id,asOf,{assessmentVersion:PREVIOUS_QUALIFICATION_ASSESSMENT_VERSION}).snapshot
 expect(old.titles.find(t=>t.titleCode==='specialized_sme')!.group).toBe('pending')
 expect(old.assessmentVersion).toBe('enterprise-qualification-407-v2')
})
it.each(['passed','failed',null] as const)('formal review-only %s preserves missing origin coordinates', outcome=>{
 const c=f.candidate('review-only-'+outcome,[{eventType:'review',year:null,decidedYear:2026,batchSeq:null,reviewOutcome:outcome}])
 const result=read(c.enterprise.id)
 expect(result.group).toBe(outcome==='passed'?'eligible':'excluded')
 expect(result.evidence[0]).toMatchObject({year:null,batchSeq:null,decidedYear:2026,reviewOutcome:outcome})
})
