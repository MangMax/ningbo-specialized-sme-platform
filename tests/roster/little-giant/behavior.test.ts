import { afterAll, expect, it } from 'vitest'
import { qualificationExportFixture } from '../current-export/fixtures/qualification-export'
import { readPostgresRosterEnterpriseDetail } from '../../../layers/sme-roster/lib/roster/enterprise-detail-postgres'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
const f = qualificationExportFixture()
const at = Date.parse('2026-06-01T00:00:00Z')
afterAll(() => f.close())
const assessment = async (db: NodePgDatabase, id: number, time: number) =>
  (await readPostgresRosterEnterpriseDetail(db, id, time))!.qualificationAssessment
it('inherits without lower official history and preserves original facts', async () => {
  for (const [name, histories, expected] of [
    ['none', [], ['eligible','eligible']],
    ['specialized', ['specialized_sme'], ['eligible','eligible']],
    ['innovative', ['innovative_sme'], ['eligible','eligible']],
    ['both', ['specialized_sme','innovative_sme'], ['eligible','eligible']],
  ] as const) {
    const c = await f.candidate(name, [{eventType:'award',year:2025,batchSeq:1}], 'little_giant')
    for (const title of histories) await f.addRecord(c.enterprise.id,name,[{eventType:'award',year:2018,batchSeq:1}],title)
    const before = await f.businessDigest()
    const snapshot = await assessment(f.db,c.enterprise.id,at)
    expect(['specialized_sme','innovative_sme'].map(title=>snapshot.titles.find(t=>t.titleCode===title)!.group),name).toEqual(expected)
    expect(await f.businessDigest()).toBe(before)
  }
})
it('retains giant inheritance beyond award age', async () => {
  const c=await f.candidate('expiry',[{eventType:'award',year:2025,batchSeq:1}],'little_giant')
  await f.addRecord(c.enterprise.id,'expiry',[{eventType:'review',year:2018,decidedYear:2021,reviewOutcome:'failed',batchSeq:1}],'specialized_sme')
  await f.addRecord(c.enterprise.id,'expiry',[{eventType:'award',year:2027,batchSeq:1}],'innovative_sme')
  const read=async(date:string)=>(await assessment(f.db,c.enterprise.id,Date.parse(date))).titles
  expect((await read('2026-06-01'))[1]!.group).toBe('eligible')
  expect((await read('2028-06-01')).find(t=>t.titleCode==='specialized_sme')!.group).toBe('eligible')
  expect((await read('2028-06-01')).find(t=>t.titleCode==='innovative_sme')!.group).toBe('eligible')
})
it('retains lower raw history while upper changes refresh dependent versions', async () => {
 const c=await f.candidate('history-boundaries',[{eventType:'award',year:2025,batchSeq:1}],'little_giant')
 await f.addRecord(c.enterprise.id,'history-boundaries',[{eventType:'review',year:2018,decidedYear:null,reviewOutcome:'passed',batchSeq:1}],'specialized_sme')
 await f.addRecord(c.enterprise.id,'history-boundaries',[{eventType:'award',year:2027,batchSeq:1}],'innovative_sme')
 const read=()=>assessment(f.db,c.enterprise.id,at)
 const before=await read()
 expect(before.titles.filter(t=>t.titleCode!=='little_giant').map(t=>t.group)).toEqual(['eligible','eligible'])
 await f.runtimeQuery('update business.record_event set year=2024 where record_id=$1', [c.record.id])
 const after=await read()
 for(const title of ['specialized_sme','innovative_sme']) expect(after.titles.find(t=>t.titleCode===title)!.versions.facts).not.toBe(before.titles.find(t=>t.titleCode===title)!.versions.facts)
})
it.each([
 ['future', [{eventType:'award',year:2027,batchSeq:1}]],
 ['platform-only', [{eventType:'maintain',year:2025,batchSeq:1}]],
 ['pending', [{eventType:'review',year:null,decidedYear:null,reviewOutcome:null}]],
 ['failed', [{eventType:'award',year:2023,batchSeq:1},{eventType:'review',year:2023,decidedYear:2026,reviewOutcome:'failed',batchSeq:1}]],
] satisfies [string, import('../current-export/fixtures/qualification-export').Event[]][])('does not inherit from %s giant and keeps own effective title', async (name,events)=>{
 const c=await f.candidate('negative-'+name,events,'little_giant')
 await f.addRecord(c.enterprise.id,name,[{eventType:'award',year:2018,batchSeq:1}],'specialized_sme')
 await f.addRecord(c.enterprise.id,name,[{eventType:'award',year:2025,batchSeq:1}],'innovative_sme')
 const snapshot=await assessment(f.db,c.enterprise.id,at)
 expect(snapshot.titles.find(t=>t.titleCode==='specialized_sme')!.group).toBe('excluded')
 expect(snapshot.titles.find(t=>t.titleCode==='innovative_sme')!.group).toBe('eligible')
})
it('retains inheritance when lower evidence is removed without changing the giant',async()=>{
 const c=await f.candidate('withdrawal',[{eventType:'award',year:2025,batchSeq:1}],'little_giant')
 const lower=await f.addRecord(c.enterprise.id,'withdrawal',[{eventType:'award',year:2018,batchSeq:1}],'specialized_sme')
 const read=()=>assessment(f.db,c.enterprise.id,at)
 const before=await read()
 expect(before.titles.find(t=>t.titleCode==='specialized_sme')!.group).toBe('eligible')
 await f.runtimeQuery('delete from business.record_evidence where record_event_id in (select id from business.record_event where record_id=$1)', [lower.id])
 const after=await read()
 expect(after.titles.find(t=>t.titleCode==='specialized_sme')!.group).toBe('eligible')
 expect(after.titles.find(t=>t.titleCode==='specialized_sme')!.versions.sources).not.toBe(before.titles.find(t=>t.titleCode==='specialized_sme')!.versions.sources)
 expect(after.titles.find(t=>t.titleCode==='little_giant')).toEqual(before.titles.find(t=>t.titleCode==='little_giant'))
})
it('specialized qualification alone supports innovative without inventing events and preserves own period', async () => {
 const c=await f.candidate('specialized-only',[{eventType:'award',year:2025,batchSeq:1}],'specialized_sme')
 const read=(day='2026-06-01')=>assessment(f.db,c.enterprise.id,Date.parse(day))
 const before=await f.businessDigest(), inherited=await read()
 expect(inherited.titles.map(t=>[t.titleCode,t.group])).toEqual([['little_giant','excluded'],['specialized_sme','eligible'],['innovative_sme','eligible']])
 const lower=inherited.titles[2]!
 expect(lower.evidence).toEqual([]);expect(lower.cycles).toEqual([])
 expect(lower.effectiveQualification!.localRuleBasis!.join(' ')).toContain('专精特新中小企业')
 expect(lower.effectiveQualification!.presentationBasis!.join(' ')).toContain('2028')
 expect(await f.businessDigest()).toBe(before)
 await f.addRecord(c.enterprise.id,'own',[{eventType:'award',year:2026,batchSeq:1}],'innovative_sme')
 const own=(await read()).titles[2]!
 expect(own.effectiveQualification!.localRuleBasis).toEqual([])
 expect(own.effectiveQualification!.presentationBasis!.join(' ')).toContain('2029')
 expect((await read('2028-01-01')).titles[2]!.group).toBe('eligible')
 expect((await read('2028-01-01')).titles[1]!.group).toBe('excluded')
})

it('upper-only candidates are deduplicated in common lists filters and XLSX with literal identities', async () => {
 const { listPostgresCurrentQualified } = await import('../../../layers/sme-roster/lib/roster/current-qualified-query-postgres')
 const { writePostgresCurrentWorkbook } = await import('../../../layers/sme-roster/lib/roster/current-workbook-postgres')
 const { readExportWorkbook } = await import('../../support/read-workbook')
 const { readFileSync } = await import('node:fs')
 const { join } = await import('node:path')
 const { vi } = await import('vitest')
 const isolated=qualificationExportFixture()
 vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-06-01T00:00:00Z'))
 try {
  const giant=await isolated.candidate('only-giant',[{eventType:'award',year:2025,batchSeq:1}],'little_giant')
  await isolated.candidate('only-specialized',[{eventType:'award',year:2025,batchSeq:1}],'specialized_sme')
  await isolated.addRecord(giant.enterprise.id,'failed-lower',[{eventType:'award',year:2020,batchSeq:1},{eventType:'review',year:2020,decidedYear:2023,batchSeq:1,reviewOutcome:'failed'}],'innovative_sme')
  const both=await isolated.candidate('overlap',[{eventType:'award',year:2025,batchSeq:1}],'little_giant')
  await isolated.addRecord(both.enterprise.id,'overlap',[{eventType:'award',year:2025,batchSeq:1}],'specialized_sme')
  const before=await isolated.businessDigest()
  const list=await listPostgresCurrentQualified(isolated.db,{titleCode:'innovative_sme',page:1,pageSize:200})
  const identities=['SYNTHETIC-118-only-giant','SYNTHETIC-118-only-specialized','SYNTHETIC-118-overlap']
  expect(list.total).toBe(3);expect(list.rows.map(r=>r.uscc)).toEqual(identities)
  const filtered=await listPostgresCurrentQualified(isolated.db,{titleCode:'innovative_sme',district:'鄞州区',q:'only-specialized'})
  expect(filtered.total).toBe(1);expect(filtered.rows.map(r=>r.uscc)).toEqual(['SYNTHETIC-118-only-specialized'])
  const path=join(isolated.dir,'chain.xlsx')
  await writePostgresCurrentWorkbook(isolated.db,'innovative_sme',path,async()=>{})
  const workbook=await readExportWorkbook(readFileSync(path)),sheet=workbook.getWorksheet('有效企业')!
  expect(Array.from({length:sheet.rowCount-1},(_,i)=>sheet.getRow(i+2).getCell(3).value)).toEqual(identities)
  expect(JSON.stringify(sheet.getRow(3).values)).toContain('2028')
  expect(JSON.stringify(sheet.getRow(3).values)).toContain('专精特新中小企业')
  expect(await isolated.businessDigest()).toBe(before)
 } finally {vi.useRealTimers();await isolated.close()}
},30000)

it('upper source changes recompute lower dependencies without borrowing platform authority', async () => {
 const c=await f.candidate('source-dependent',[{eventType:'award',year:2025,batchSeq:1}],'specialized_sme')
 const before=await assessment(f.db,c.enterprise.id,at)
 await f.runtimeQuery('update business.record_evidence set source_file=$1 where record_event_id in (select id from business.record_event where record_id=$2)', ['synthetic/replaced-source.pdf', c.record.id])
 const after=await assessment(f.db,c.enterprise.id,at)
 expect(after.titles[2]!.group).toBe('eligible')
 expect(after.titles[2]!.versions.sources).not.toBe(before.titles[2]!.versions.sources)
 expect(after.titles[2]!.references.join(' ')).toContain('replaced-source.pdf')
 expect(after.titles[2]!.evidence).toEqual([])
})

it('retains an old giant award without fabricating lower official history', async () => {
 const c=await f.candidate('retained-old-award',[{eventType:'award',year:2018,batchSeq:1}],'little_giant')
 const before=await f.businessDigest()
 const snapshot=await assessment(f.db,c.enterprise.id,at)
 expect(snapshot.titles.map(t=>[t.titleCode,t.group])).toEqual([['little_giant','eligible'],['specialized_sme','eligible'],['innovative_sme','eligible']])
 expect(snapshot.titles.slice(1).map(t=>t.evidence)).toEqual([[],[]])
 expect(await f.businessDigest()).toBe(before)
})
it('honors source-bound formal giant interval endpoints and re-evaluates a changed source', async () => {
 const c=await f.candidate('formal-period',[{eventType:'award',year:2018,batchSeq:1}],'little_giant')
 const event=(await f.runtimeQuery('select id from business.record_event where record_id=$1', [c.record.id])).rows[0]!
 const evidence=(await f.runtimeQuery('select id from business.record_evidence where record_event_id=$1', [event.id])).rows[0]!
 const path='owned/giant-formal-period.pdf',sha='c'.repeat(64)
 await f.runtimeQuery('update business.record_evidence set source_file=$1,page=1 where id=$2', [path,evidence.id])
 await f.runtimeQuery("insert into business.stored_file (rel_path, filename, ext, bytes, sha256, created_at) values ($1, 'period.pdf', 'pdf', 1, $2, '2026-01-01')", [path, sha])
 await f.runtimeQuery('update business.record_event set formal_validity=$1 where id=$2', [JSON.stringify({evidenceId:Number(evidence.id),sourceSha256:sha,statementPages:[1],interval:{validFrom:'2026-05-01',validThrough:'2026-06-01'}}),event.id])
 const read=(day:string)=>assessment(f.db,c.enterprise.id,Date.parse(day+'T12:00:00Z'))
 for(const [day,group] of [['2026-04-30','excluded'],['2026-05-01','eligible'],['2026-06-01','eligible'],['2026-06-02','excluded']] as const) {
  expect((await read(day)).titles.map(t=>t.group),day).toEqual([group,group,group])
 }
 const expired=await read('2026-06-02')
 await f.runtimeQuery('update business.stored_file set sha256=$1 where rel_path=$2', ['d'.repeat(64), path])
 const changed=await read('2026-06-02')
 // Source drift is diagnostic: it neither erases the recorded interval nor revokes all titles.
 expect(changed.titles.map(t=>t.group)).toEqual(['excluded','excluded','excluded'])
 expect((await read('2026-06-01')).titles.map(t=>t.group)).toEqual(['eligible','eligible','eligible'])
 expect(changed.titles[0]!.evidence[0]).toMatchObject({validityInvalid:true})
 expect(changed.titles[0]!.versions.sources).not.toBe(expired.titles[0]!.versions.sources)
})
