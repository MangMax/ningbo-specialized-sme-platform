import { afterAll, expect, it } from 'vitest'
import { qualificationExportFixture } from '../current-export/fixtures/qualification-export'
import { readCurrentQualificationAssessment } from '../../../layers/sme-roster/lib/roster/current-qualification'
const f = qualificationExportFixture()
const at = Date.parse('2026-06-01T00:00:00Z')
afterAll(() => f.close())
it('inherits without lower official history and preserves original facts', () => {
  for (const [name, histories, expected] of [
    ['none', [], ['eligible','eligible']],
    ['specialized', ['specialized_sme'], ['eligible','eligible']],
    ['innovative', ['innovative_sme'], ['eligible','eligible']],
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
it('retains giant inheritance beyond award age and keeps frozen v3 semantics', () => {
  const c=f.candidate('expiry',[{eventType:'award',year:2025,batchSeq:1}],'little_giant')
  f.addRecord(c.enterprise.id,'expiry',[{eventType:'review',year:2018,decidedYear:2021,reviewOutcome:'failed',batchSeq:1}],'specialized_sme')
  f.addRecord(c.enterprise.id,'expiry',[{eventType:'award',year:2027,batchSeq:1}],'innovative_sme')
  const read=(date:string)=>readCurrentQualificationAssessment(f.db.$client,c.enterprise.id,Date.parse(date)).titles
  expect(read('2026-06-01')[1]!.group).toBe('eligible')
  expect(read('2028-06-01').find(t=>t.titleCode==='specialized_sme')!.group).toBe('eligible')
  expect(read('2028-06-01').find(t=>t.titleCode==='innovative_sme')!.group).toBe('eligible')
  expect(readCurrentQualificationAssessment(f.db.$client,c.enterprise.id,at,{assessmentVersion:'enterprise-qualification-478-v3'}).titles.find(t=>t.titleCode==='specialized_sme')!.group).toBe('excluded')
})
it('retains lower raw history while upper changes refresh dependent versions', () => {
 const c=f.candidate('history-boundaries',[{eventType:'award',year:2025,batchSeq:1}],'little_giant')
 f.addRecord(c.enterprise.id,'history-boundaries',[{eventType:'review',year:2018,decidedYear:null,reviewOutcome:'passed',batchSeq:1}],'specialized_sme')
 f.addRecord(c.enterprise.id,'history-boundaries',[{eventType:'award',year:2027,batchSeq:1}],'innovative_sme')
 const read=()=>readCurrentQualificationAssessment(f.db.$client,c.enterprise.id,at)
 const before=read()
 expect(before.titles.filter(t=>t.titleCode!=='little_giant').map(t=>t.group)).toEqual(['eligible','eligible'])
 f.db.$client.prepare('update record_event set year=2024 where record_id=?').run(c.record.id)
 const after=read()
 for(const title of ['specialized_sme','innovative_sme']) expect(after.titles.find(t=>t.titleCode===title)!.versions.facts).not.toBe(before.titles.find(t=>t.titleCode===title)!.versions.facts)
})
it.each([
 ['future', [{eventType:'award',year:2027,batchSeq:1}]],
 ['platform-only', [{eventType:'maintain',year:2025,batchSeq:1}]],
 ['pending', [{eventType:'review',year:null,decidedYear:null,reviewOutcome:null}]],
 ['failed', [{eventType:'award',year:2023,batchSeq:1},{eventType:'review',year:2023,decidedYear:2026,reviewOutcome:'failed',batchSeq:1}]],
] satisfies [string, import('../current-export/fixtures/qualification-export').Event[]][])('does not inherit from %s giant and keeps own effective title', (name,events)=>{
 const c=f.candidate('negative-'+name,events,'little_giant')
 f.addRecord(c.enterprise.id,name,[{eventType:'award',year:2018,batchSeq:1}],'specialized_sme')
 f.addRecord(c.enterprise.id,name,[{eventType:'award',year:2025,batchSeq:1}],'innovative_sme')
 const snapshot=readCurrentQualificationAssessment(f.db.$client,c.enterprise.id,at)
 expect(snapshot.titles.find(t=>t.titleCode==='specialized_sme')!.group).toBe('excluded')
 expect(snapshot.titles.find(t=>t.titleCode==='innovative_sme')!.group).toBe('eligible')
})
it('retains inheritance when lower evidence is removed without changing the giant',()=>{
 const c=f.candidate('withdrawal',[{eventType:'award',year:2025,batchSeq:1}],'little_giant')
 const lower=f.addRecord(c.enterprise.id,'withdrawal',[{eventType:'award',year:2018,batchSeq:1}],'specialized_sme')
 const read=()=>readCurrentQualificationAssessment(f.db.$client,c.enterprise.id,at)
 const before=read()
 expect(before.titles.find(t=>t.titleCode==='specialized_sme')!.group).toBe('eligible')
 f.db.$client.prepare('delete from record_evidence where record_event_id in (select id from record_event where record_id=?)').run(lower.id)
 const after=read()
 expect(after.titles.find(t=>t.titleCode==='specialized_sme')!.group).toBe('eligible')
 expect(after.titles.find(t=>t.titleCode==='specialized_sme')!.versions.sources).not.toBe(before.titles.find(t=>t.titleCode==='specialized_sme')!.versions.sources)
 expect(after.titles.find(t=>t.titleCode==='little_giant')).toEqual(before.titles.find(t=>t.titleCode==='little_giant'))
})
it.each(['award', 'review'] as const)('uses verified publication for undated %s history without filling business years', eventType => {
 const c=f.candidate('published-'+eventType,[{eventType:'award',year:2025,batchSeq:1}],'little_giant')
 const lower=f.addRecord(c.enterprise.id,'published-'+eventType,[{eventType,year:null,decidedYear:null,reviewOutcome:eventType==='review'?'passed':null}],'specialized_sme')
 const event=f.db.$client.prepare('select id from record_event where record_id=?').get(lower.id) as {id:number}
 const evidence=f.db.$client.prepare('select id,source_file as path from record_evidence where record_event_id=?').get(event.id) as {id:number;path:string}
 evidence.path='owned/history-'+event.id+'.pdf'
 f.db.$client.prepare('update record_evidence set source_file=? where id=?').run(evidence.path,evidence.id)
 const sha='a'.repeat(64)
 f.db.$client.prepare('insert into stored_file (rel_path,filename,ext,bytes,sha256,created_at) values (?,?,?,?,?,0)').run(evidence.path,'history.pdf','pdf',1,sha)
 const install=(publishedOn?:string,sourceSha256=sha)=>f.db.$client.prepare('update record_event set formal_validity=? where id=?').run(JSON.stringify({evidenceId:evidence.id,sourceSha256,statementPages:[1],...(publishedOn?{publishedOn}:{}),interval:{validFrom:'2018-06-01',validThrough:'2021-05-31'}}),event.id)
 const read=(day='2026-06-01')=>readCurrentQualificationAssessment(f.db.$client,c.enterprise.id,Date.parse(day+'T00:00:00Z'),{assessmentVersion:'enterprise-qualification-687-v4'}).titles.find(t=>t.titleCode==='specialized_sme')!
 install('2018-06-01')
 const before=f.businessDigest()
 expect(read().group).toBe('eligible')
 expect(read().evidence[0]).toMatchObject({year:null,decidedYear:null})
 expect(f.businessDigest()).toBe(before)
 install('2026-06-02'); expect(read().group).toBe('excluded')
 install('2026-06-01'); expect(read().group).toBe('eligible')
 install(); expect(read().group).toBe('excluded')
 install('2018-06-01','b'.repeat(64)); expect(read().group).toBe('excluded')
 install('2018-06-01')
 f.db.$client.prepare('update stored_file set removed_at=? where rel_path=?').run('2026-01-01',evidence.path)
 expect(read().group).toBe('excluded')
})

it('specialized qualification alone supports innovative without inventing events and preserves own period', () => {
 const c=f.candidate('specialized-only',[{eventType:'award',year:2025,batchSeq:1}],'specialized_sme')
 const read=(day='2026-06-01')=>readCurrentQualificationAssessment(f.db.$client,c.enterprise.id,Date.parse(day))
 const before=f.businessDigest(), inherited=read()
 expect(inherited.titles.map(t=>[t.titleCode,t.group])).toEqual([['little_giant','excluded'],['specialized_sme','eligible'],['innovative_sme','eligible']])
 const lower=inherited.titles[2]!
 expect(lower.evidence).toEqual([]);expect(lower.cycles).toEqual([])
 expect(lower.effectiveQualification!.localRuleBasis!.join(' ')).toContain('专精特新中小企业')
 expect(lower.effectiveQualification!.presentationBasis!.join(' ')).toContain('2028')
 expect(f.businessDigest()).toBe(before)
 expect(readCurrentQualificationAssessment(f.db.$client,c.enterprise.id,at,{assessmentVersion:'enterprise-qualification-687-v4'}).titles[2]!.group).toBe('excluded')
 f.addRecord(c.enterprise.id,'own',[{eventType:'award',year:2026,batchSeq:1}],'innovative_sme')
 const own=read().titles[2]!
 expect(own.effectiveQualification!.localRuleBasis).toEqual([])
 expect(own.effectiveQualification!.presentationBasis!.join(' ')).toContain('2029')
 expect(read('2028-01-01').titles[2]!.group).toBe('eligible')
 expect(read('2028-01-01').titles[1]!.group).toBe('excluded')
})

it('upper-only candidates are deduplicated in common lists filters and XLSX with literal identities', async () => {
 const { listCurrentQualified } = await import('../../../layers/sme-roster/lib/roster/current-qualified-query')
 const { writeCurrentWorkbook } = await import('../../../layers/sme-roster/lib/roster/current-workbook')
 const { readExportWorkbook } = await import('../../support/read-workbook')
 const { readFileSync } = await import('node:fs')
 const { join } = await import('node:path')
 const { vi } = await import('vitest')
 const isolated=qualificationExportFixture()
 vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-06-01T00:00:00Z'))
 try {
  const giant=isolated.candidate('only-giant',[{eventType:'award',year:2025,batchSeq:1}],'little_giant')
  isolated.candidate('only-specialized',[{eventType:'award',year:2025,batchSeq:1}],'specialized_sme')
  isolated.addRecord(giant.enterprise.id,'failed-lower',[{eventType:'award',year:2020,batchSeq:1},{eventType:'review',year:2020,decidedYear:2023,batchSeq:1,reviewOutcome:'failed'}],'innovative_sme')
  const both=isolated.candidate('overlap',[{eventType:'award',year:2025,batchSeq:1}],'little_giant')
  isolated.addRecord(both.enterprise.id,'overlap',[{eventType:'award',year:2025,batchSeq:1}],'specialized_sme')
  const before=isolated.businessDigest()
  const list=listCurrentQualified(isolated.db.$client,{titleCode:'innovative_sme',page:1,pageSize:200})
  const identities=['SYNTHETIC-118-only-giant','SYNTHETIC-118-only-specialized','SYNTHETIC-118-overlap']
  expect(list.total).toBe(3);expect(list.rows.map(r=>r.uscc)).toEqual(identities)
  const filtered=listCurrentQualified(isolated.db.$client,{titleCode:'innovative_sme',district:'鄞州区',q:'only-specialized'})
  expect(filtered.total).toBe(1);expect(filtered.rows.map(r=>r.uscc)).toEqual(['SYNTHETIC-118-only-specialized'])
  const path=join(isolated.dir,'chain.xlsx')
  await writeCurrentWorkbook(isolated.db.$client,'innovative_sme',path,()=>{})
  const workbook=await readExportWorkbook(readFileSync(path)),sheet=workbook.getWorksheet('有效企业')!
  expect(Array.from({length:sheet.rowCount-1},(_,i)=>sheet.getRow(i+2).getCell(3).value)).toEqual(identities)
  expect(JSON.stringify(sheet.getRow(3).values)).toContain('2028')
  expect(JSON.stringify(sheet.getRow(3).values)).toContain('专精特新中小企业')
  expect(isolated.businessDigest()).toBe(before)
 } finally {vi.useRealTimers();await isolated.close()}
},30000)

it('upper source changes recompute lower dependencies without borrowing platform authority', () => {
 const c=f.candidate('source-dependent',[{eventType:'award',year:2025,batchSeq:1}],'specialized_sme')
 const before=readCurrentQualificationAssessment(f.db.$client,c.enterprise.id,at)
 f.db.$client.prepare('update record_evidence set source_file=? where record_event_id in (select id from record_event where record_id=?)').run('synthetic/replaced-source.pdf',c.record.id)
 const after=readCurrentQualificationAssessment(f.db.$client,c.enterprise.id,at)
 expect(after.titles[2]!.group).toBe('eligible')
 expect(after.titles[2]!.versions.sources).not.toBe(before.titles[2]!.versions.sources)
 expect(after.titles[2]!.references.join(' ')).toContain('replaced-source.pdf')
 expect(after.titles[2]!.evidence).toEqual([])
})

it('retains an old giant award without fabricating lower official history', () => {
 const c=f.candidate('retained-old-award',[{eventType:'award',year:2018,batchSeq:1}],'little_giant')
 const before=f.businessDigest()
 const snapshot=readCurrentQualificationAssessment(f.db.$client,c.enterprise.id,at)
 expect(snapshot.titles.map(t=>[t.titleCode,t.group])).toEqual([['little_giant','eligible'],['specialized_sme','eligible'],['innovative_sme','eligible']])
 expect(snapshot.titles.slice(1).map(t=>t.evidence)).toEqual([[],[]])
 expect(f.businessDigest()).toBe(before)
})
it('honors source-bound formal giant interval endpoints and re-evaluates a changed source', () => {
 const c=f.candidate('formal-period',[{eventType:'award',year:2018,batchSeq:1}],'little_giant')
 const event=f.db.$client.prepare('select id from record_event where record_id=?').get(c.record.id) as {id:number}
 const evidence=f.db.$client.prepare('select id from record_evidence where record_event_id=?').get(event.id) as {id:number}
 const path='owned/giant-formal-period.pdf',sha='c'.repeat(64)
 f.db.$client.prepare('update record_evidence set source_file=?,page=1 where id=?').run(path,evidence.id)
 f.db.$client.prepare('insert into stored_file (rel_path,filename,ext,bytes,sha256,created_at) values (?,?,?,?,?,0)').run(path,'period.pdf','pdf',1,sha)
 f.db.$client.prepare('update record_event set formal_validity=? where id=?').run(JSON.stringify({evidenceId:evidence.id,sourceSha256:sha,statementPages:[1],interval:{validFrom:'2026-05-01',validThrough:'2026-06-01'}}),event.id)
 const read=(day:string)=>readCurrentQualificationAssessment(f.db.$client,c.enterprise.id,Date.parse(day+'T12:00:00Z'))
 for(const [day,group] of [['2026-04-30','excluded'],['2026-05-01','eligible'],['2026-06-01','eligible'],['2026-06-02','excluded']] as const) {
  expect(read(day).titles.map(t=>t.group),day).toEqual([group,group,group])
 }
 const expired=read('2026-06-02')
 f.db.$client.prepare('update stored_file set sha256=? where rel_path=?').run('d'.repeat(64),path)
 const changed=read('2026-06-02')
 // Source drift is diagnostic: it neither erases the recorded interval nor revokes all titles.
 expect(changed.titles.map(t=>t.group)).toEqual(['excluded','excluded','excluded'])
 expect(read('2026-06-01').titles.map(t=>t.group)).toEqual(['eligible','eligible','eligible'])
 expect(changed.titles[0]!.evidence[0]).toMatchObject({validityInvalid:true})
 expect(changed.titles[0]!.versions.sources).not.toBe(expired.titles[0]!.versions.sources)
})
