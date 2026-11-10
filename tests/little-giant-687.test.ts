import { afterAll, expect, it } from 'vitest'
import { currentExport409Fixture } from './helpers/current-export-409'
import { readCurrentQualificationAssessment } from '../lib/roster/current-qualification'
const f = currentExport409Fixture()
const at = Date.parse('2026-06-01T00:00:00Z')
afterAll(() => f.close())
it('requires each lower title own applicable official history and preserves original facts', () => {
  for (const [name, histories, expected] of [
    ['none', [], ['excluded','excluded']],
    ['specialized', ['specialized_sme'], ['eligible','excluded']],
    ['innovative', ['innovative_sme'], ['excluded','eligible']],
    ['both', ['specialized_sme','innovative_sme'], ['eligible','eligible']],
  ] as const) {
    const c = f.candidate(name, [{eventType:'award',year:2025,batchSeq:1}], 'little_giant')
    for (const title of histories) f.addRecord(c.enterprise.id,name,[{eventType:'award',year:2018,batchSeq:1}],title)
    const before = f.businessDigest()
    const snapshot = readCurrentQualificationAssessment(f.db.$client,c.enterprise.id,at)
    expect(['specialized_sme','innovative_sme'].map(title=>snapshot.titles.find(t=>t.titleCode===title)!.group),name).toEqual(expected)
    expect(f.businessDigest()).toBe(before)
  }
})
it('withdraws derived eligibility on giant expiry, keeps independent validity and frozen v3 semantics', () => {
  const c=f.candidate('expiry',[{eventType:'award',year:2025,batchSeq:1}],'little_giant')
  f.addRecord(c.enterprise.id,'expiry',[{eventType:'review',year:2018,decidedYear:2021,reviewOutcome:'failed',batchSeq:1}],'specialized_sme')
  f.addRecord(c.enterprise.id,'expiry',[{eventType:'award',year:2027,batchSeq:1}],'innovative_sme')
  const read=(date:string)=>readCurrentQualificationAssessment(f.db.$client,c.enterprise.id,Date.parse(date)).titles
  expect(read('2026-06-01')[1]!.group).toBe('eligible')
  expect(read('2028-06-01').find(t=>t.titleCode==='specialized_sme')!.group).toBe('excluded')
  expect(read('2028-06-01').find(t=>t.titleCode==='innovative_sme')!.group).toBe('eligible')
  expect(readCurrentQualificationAssessment(f.db.$client,c.enterprise.id,at,{assessmentVersion:'enterprise-qualification-478-v3'}).titles.find(t=>t.titleCode==='specialized_sme')!.group).toBe('excluded')
})
it('rejects future unknown platform and other-title history and refreshes dependent versions', () => {
 const c=f.candidate('history-boundaries',[{eventType:'award',year:2025,batchSeq:1}],'little_giant')
 f.addRecord(c.enterprise.id,'history-boundaries',[{eventType:'review',year:2018,decidedYear:null,reviewOutcome:'passed',batchSeq:1}],'specialized_sme')
 f.addRecord(c.enterprise.id,'history-boundaries',[{eventType:'award',year:2027,batchSeq:1}],'innovative_sme')
 const read=()=>readCurrentQualificationAssessment(f.db.$client,c.enterprise.id,at)
 const before=read()
 expect(before.titles.filter(t=>t.titleCode!=='little_giant').map(t=>t.group)).toEqual(['excluded','excluded'])
 f.db.$client.prepare('update record_event set year=2024 where record_id=?').run(c.record.id)
 const after=read()
 for(const title of ['specialized_sme','innovative_sme']) expect(after.titles.find(t=>t.titleCode===title)!.versions.facts).not.toBe(before.titles.find(t=>t.titleCode===title)!.versions.facts)
})
it.each([
 ['expired', [{eventType:'award',year:2018,batchSeq:1}]],
 ['future', [{eventType:'award',year:2027,batchSeq:1}]],
 ['platform-only', [{eventType:'maintain',year:2025,batchSeq:1}]],
 ['pending', [{eventType:'review',year:null,decidedYear:null,reviewOutcome:null}]],
 ['failed', [{eventType:'award',year:2023,batchSeq:1},{eventType:'review',year:2023,decidedYear:2026,reviewOutcome:'failed',batchSeq:1}]],
] satisfies [string, import('./helpers/current-export-409').Event[]][])('does not inherit from %s giant and keeps own effective title', (name,events)=>{
 const c=f.candidate('negative-'+name,events,'little_giant')
 f.addRecord(c.enterprise.id,name,[{eventType:'award',year:2018,batchSeq:1}],'specialized_sme')
 f.addRecord(c.enterprise.id,name,[{eventType:'award',year:2025,batchSeq:1}],'innovative_sme')
 const snapshot=readCurrentQualificationAssessment(f.db.$client,c.enterprise.id,at)
 expect(snapshot.titles.find(t=>t.titleCode==='specialized_sme')!.group).toBe('excluded')
 expect(snapshot.titles.find(t=>t.titleCode==='innovative_sme')!.group).toBe('eligible')
})
it('revokes inheritance when own official evidence is removed without changing the giant',()=>{
 const c=f.candidate('withdrawal',[{eventType:'award',year:2025,batchSeq:1}],'little_giant')
 const lower=f.addRecord(c.enterprise.id,'withdrawal',[{eventType:'award',year:2018,batchSeq:1}],'specialized_sme')
 const read=()=>readCurrentQualificationAssessment(f.db.$client,c.enterprise.id,at)
 const before=read()
 expect(before.titles.find(t=>t.titleCode==='specialized_sme')!.group).toBe('eligible')
 f.db.$client.prepare('delete from record_evidence where record_event_id in (select id from record_event where record_id=?)').run(lower.id)
 const after=read()
 expect(after.titles.find(t=>t.titleCode==='specialized_sme')!.group).toBe('excluded')
 expect(after.titles.find(t=>t.titleCode==='specialized_sme')!.versions.sources).not.toBe(before.titles.find(t=>t.titleCode==='specialized_sme')!.versions.sources)
 expect(after.titles.find(t=>t.titleCode==='little_giant')).toEqual(before.titles.find(t=>t.titleCode==='little_giant'))
})
