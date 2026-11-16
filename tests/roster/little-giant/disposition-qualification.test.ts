import ExcelJS from 'exceljs'
import { eq } from 'drizzle-orm'
import { join } from 'node:path'
import { writeCurrentWorkbook } from '../../../lib/roster/current-workbook'
import { afterAll, expect, it, vi } from 'vitest'
import { qualificationExportFixture } from '../current-export/fixtures/qualification-export'
import { createCurrentQualificationAssessmentReader } from '../../../lib/roster/current-qualification'
import { currentDispositions, preflightDisposition, commitDisposition } from '../../../server/utils/title-cycle-disposition'
import * as s from '../../../db/schema'
const f = qualificationExportFixture()
function append(recordId: number, event: {eventType:'review'|'award';year:number;decidedYear?:number;batchSeq:number;reviewOutcome?:'passed'}) {
 const e=f.db.insert(s.recordEvent).values({recordId,...event}).returning().get()
 f.db.insert(s.recordEvidence).values({recordEventId:e.id,sourceFile:'synthetic.pdf'}).run()
}
afterAll(() => f.close())
const read = (id: number, day: string) => createCurrentQualificationAssessmentReader(f.db.$client).read(id, Date.parse(day+'T12:00:00Z')).snapshot.titles.find(t => t.titleCode === 'little_giant')!
function setup(kind: 'not_applied' | 'not_recommended', patch: Record<string, unknown> = {}) {
 const c = f.candidate(kind+crypto.randomUUID(),[{eventType:'award',year:2025,batchSeq:1}],'little_giant')
 const event = f.db.select().from(s.recordEvent).all().find(e => e.recordId === c.record.id)!
 const file = f.db.insert(s.storedFile).values({relPath:crypto.randomUUID()+'.pdf',filename:kind+'.pdf',ext:'pdf',bytes:1,sha256:'a'.repeat(64),createdAt:'2026-01-01'}).returning().get()
 const fact = {kind,source:{fileId:file.id,sha256:file.sha256,reference:'第1页',statement:kind},cycle:{eventId:event.id,revision:event.revision},observed:{precision:'day',value:'2026-01-01'},effective:{precision:'day',value:'2026-06-01'},effectiveBasis:'原周期自2026-06-01终止',...patch}
 const run = (operations: unknown[]) => { const request = {idempotencyKey:crypto.randomUUID(),expectedVersion:currentDispositions(f.db,[c.enterprise.id]).version,actor:{type:'agent',id:'synthetic'},basis:'synthetic verified source',operations}; return commitDisposition(f.db,{request,planHash:preflightDisposition(f.db,request).planHash}) }
 const a=run([{action:'assert',enterpriseId:c.enterprise.id,fact}]);run([{action:'confirm',id:a.ids[0],revision:1}])
 return {...c,event,file,fact,run,id:a.ids[0]}
}
it.each(['not_applied','not_recommended'] as const)('applies confirmed %s only at the supported day and restores on withdrawal',kind=>{
 const c=setup(kind)
 expect(read(c.enterprise.id,'2026-05-31').group).toBe('eligible')
 const excluded=read(c.enterprise.id,'2026-06-01')
 expect(excluded.group).toBe('excluded')
 expect(excluded.effectiveQualification!.basis).toContain(c.id)
 expect(excluded.effectiveQualification!.presentationBasis!.join(' ')).toContain('第1页')
 c.run([{action:'withdraw',id:c.id,revision:2}])
 const restored=read(c.enterprise.id,'2026-06-01')
 expect(restored.group).toBe('eligible')
 expect(restored.versions.decisions).not.toBe(excluded.versions.decisions)
})

it.each([
 ['unknown-cycle',{cycle:null}], ['unknown-day',{effective:{precision:'unknown',value:null}}],
 ['coarse-day',{effective:{precision:'month',value:'2026-06'}}], ['unknown-basis',{effectiveBasis:null}],
] as const)('retains qualification with %s rather than inventing an exclusion',(_,patch)=>{
 const c=setup('not_applied',patch)
 expect(read(c.enterprise.id,'2026-06-02').group).toBe('eligible')
})
it('re-evaluates source changes and keeps immutable successful receipts',()=>{
 const c=setup('not_applied'), before=read(c.enterprise.id,'2026-06-02')
 f.db.$client.prepare('update stored_file set removed_at=? where id=?').run('2026-06-02',c.file.id)
 const after=read(c.enterprise.id,'2026-06-02')
 expect(after.group).toBe('eligible');expect(after.versions.sources).not.toBe(before.versions.sources)
 expect(currentDispositions(f.db,[c.enterprise.id]).rows[0]!.sourceCurrent).toBe(false)
})
it('new award survives old-cycle disposition while a pass cannot erase it',()=>{
 const c=setup('not_recommended')
 append(c.record.id,{eventType:'review',year:2025,decidedYear:2026,batchSeq:1,reviewOutcome:'passed'})
 expect(read(c.enterprise.id,'2026-06-02').group).toBe('excluded')
 append(c.record.id,{eventType:'award',year:2026,batchSeq:2})
 expect(read(c.enterprise.id,'2026-06-02').group).toBe('eligible')
})
it('formal failure of an older cycle cannot cancel a new award or become a re-award through a pass',()=>{
 const c=f.candidate('formal old',[{eventType:'award',year:2024,batchSeq:1},{eventType:'review',year:2024,decidedYear:2026,batchSeq:1,reviewOutcome:'failed'},{eventType:'review',year:2024,decidedYear:2027,batchSeq:1,reviewOutcome:'passed'}],'little_giant')
 expect(read(c.enterprise.id,'2027-06-02').group).toBe('excluded')
 append(c.record.id,{eventType:'award',year:2025,batchSeq:2})
 expect(read(c.enterprise.id,'2026-06-02').group).toBe('eligible')
})
it('retains an explicit continuation until the linked failed review is published',()=>{
 const c=f.candidate('future failed review',[
  {eventType:'award',year:2022,batchSeq:1},
  {eventType:'review',year:2022,decidedYear:2026,batchSeq:1,reviewOutcome:'failed'},
 ],'little_giant')
 const events=f.db.select().from(s.recordEvent).all().filter(e=>e.recordId===c.record.id)
 const award=events.find(e=>e.eventType==='award')!, review=events.find(e=>e.eventType==='review')!
 const evidence=f.db.select().from(s.recordEvidence).all().find(e=>e.recordEventId===review.id)!
 const file=f.db.insert(s.storedFile).values({relPath:'future-failed-review.pdf',filename:'future-failed-review.pdf',ext:'pdf',bytes:1,sha256:'c'.repeat(64)}).returning().get()
 f.db.update(s.recordEvidence).set({sourceFile:file.relPath,page:1}).where(eq(s.recordEvidence.id,evidence.id)).run()
 f.db.update(s.recordEvent).set({formalValidity:{evidenceId:evidence.id,sourceSha256:file.sha256,statementPages:[1],originAwardEventId:award.id,publishedOn:'2026-06-01',continuation:'until_this_review_results'}}).where(eq(s.recordEvent.id,review.id)).run()
 expect(read(c.enterprise.id,'2026-05-31').group).toBe('eligible')
 expect(read(c.enterprise.id,'2026-06-01').group).toBe('excluded')
 expect(read(c.enterprise.id,'2026-06-02').group).toBe('excluded')
 const reader=createCurrentQualificationAssessmentReader(f.db.$client)
 for(const [day,status] of [['2026-05-31','effective'],['2026-06-01','expired']] as const){
  const statuses=f.db.$client.transaction(()=>reader.readEffectiveTitles([c.enterprise.id],Date.parse(day+'T12:00:00Z'),'little_giant'))()
  expect(statuses.get(c.enterprise.id)).toBe(status)
 }
})
it('replacement retires the old exclusion while unconfirmed and coarse replacement facts remain observations',()=>{
 const c=setup('not_applied')
 const replacement=c.run([{action:'replace',id:c.id,revision:2,fact:{...c.fact,kind:'not_recommended',effective:{precision:'year',value:'2026'}}}])
 expect(read(c.enterprise.id,'2026-06-02').group).toBe('eligible')
 c.run([{action:'confirm',id:replacement.ids[0],revision:1}])
 expect(read(c.enterprise.id,'2026-06-02').group).toBe('eligible')
})
it('lower-title formal failure cannot cancel the giant',()=>{
 const c=f.candidate('low title failure',[{eventType:'award',year:2025,batchSeq:1}],'little_giant')
 f.addRecord(c.enterprise.id,'low title failure',[{eventType:'award',year:2024,batchSeq:1},{eventType:'review',year:2024,decidedYear:2026,batchSeq:1,reviewOutcome:'failed'}],'specialized_sme')
 expect(read(c.enterprise.id,'2026-06-02').group).toBe('eligible')
})
it('batched effective reads agree with full assessments at literal date boundaries',()=>{
 const c=setup('not_applied'), reader=createCurrentQualificationAssessmentReader(f.db.$client)
 for(const [day,status] of [['2026-05-31','effective'],['2026-06-01','expired'],['2026-06-02','expired']] as const){
  const result=f.db.$client.transaction(()=>reader.readEffectiveTitles([c.enterprise.id],Date.parse(day+'T12:00:00Z'),'little_giant'))()
  expect(result.get(c.enterprise.id)).toBe(status)
 }
})
it('normal review pass supports its period without manufacturing an award',()=>{
 const c=f.candidate('orphan pass',[{eventType:'review',year:2024,decidedYear:2026,batchSeq:1,reviewOutcome:'passed'}],'little_giant')
 expect(read(c.enterprise.id,'2026-06-02').group).toBe('eligible')
 expect(read(c.enterprise.id,'2029-01-01').group).toBe('excluded')
})

it('streamed XLSX retains stable identities source and effective day with the same common decision',async()=>{
 const c=setup('not_recommended')
 vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-06-01T12:00:00Z'))
 try {
  const path=join(f.dir,'dispositions.xlsx')
  await writeCurrentWorkbook(f.db.$client,'little_giant',path,()=>{})
  const wb=new ExcelJS.Workbook();await wb.xlsx.readFile(path)
  const expired=wb.getWorksheet('已到期')!
  const rows=Array.from({length:expired.rowCount-1},(_,i)=>expired.getRow(i+2))
  const own=rows.filter(row=>row.getCell(3).value===c.enterprise.usccNorm)
  expect(own).toHaveLength(1)
  expect(JSON.stringify(own[0]!.values)).toContain('第1页')
  expect(JSON.stringify(own[0]!.values)).toContain('2026-06-01')
  const effective=wb.getWorksheet('有效企业')!
  expect(Array.from({length:effective.rowCount-1},(_,i)=>effective.getRow(i+2).getCell(3).value)).not.toContain(c.enterprise.usccNorm)
 } finally {vi.useRealTimers()}
},30000)
it('failure with unknown original cycle cannot exclude a known award',()=>{
 const c=f.candidate('unknown failure cycle',[{eventType:'award',year:2025,batchSeq:1},{eventType:'review',year:2025,decidedYear:2026,batchSeq:null,reviewOutcome:'failed'}],'little_giant')
 expect(read(c.enterprise.id,'2026-06-02').group).toBe('eligible')
})

it('G normal known and unknown batch passes retain the 2025 renewal through 2027',()=>{
 const c=f.candidate('G normal passes',[
  {eventType:'review',year:2022,decidedYear:2025,batchSeq:1,reviewOutcome:'passed'},
  {eventType:'review',year:2022,decidedYear:2025,batchSeq:null,reviewOutcome:'passed'},
 ],'little_giant')
 const actual=read(c.enterprise.id,'2026-06-02')
 expect(actual.group).toBe('eligible')
 expect(actual.effectiveQualification!.presentationBasis).toContain('默认年度规则：最近一次认定或复核通过 2025 年 + 3 = 2028 年；自 2028 年起到期（仅年份精度）')
 expect(read(c.enterprise.id,'2028-01-01').group).toBe('excluded')
})
it('C same-cycle failure cannot renew the 2018 award through a 2025 pass',()=>{
 const c=f.candidate('C failed pass',[
  {eventType:'award',year:2018,batchSeq:1},
  {eventType:'review',year:2018,decidedYear:2022,batchSeq:1,reviewOutcome:'failed'},
  {eventType:'review',year:2018,decidedYear:2025,batchSeq:1,reviewOutcome:'passed'},
 ],'little_giant')
 expect(read(c.enterprise.id,'2026-06-02').group).toBe('excluded')
})
it('D independent 2022 cycle pass retains its 2025 period without an award row',()=>{
 const c=f.candidate('D renewal only',[
  {eventType:'award',year:2018,batchSeq:1,decidedYear:2023},
  {eventType:'review',year:2022,decidedYear:2025,batchSeq:1,reviewOutcome:'passed'},
 ],'little_giant')
 const actual=read(c.enterprise.id,'2026-06-02')
 expect(actual.group).toBe('eligible')
 expect(actual.effectiveQualification!.presentationBasis).toContain('默认年度规则：最近一次认定或复核通过 2025 年 + 3 = 2028 年；自 2028 年起到期（仅年份精度）')
})
it('A failed second batch does not cancel the first batch 2025 renewal',()=>{
 const c=f.candidate('A two batches',[
  {eventType:'award',year:2022,batchSeq:1},{eventType:'award',year:2022,batchSeq:2},
  {eventType:'review',year:2022,decidedYear:2025,batchSeq:1,reviewOutcome:'passed'},
  {eventType:'review',year:2022,decidedYear:2025,batchSeq:2,reviewOutcome:'failed'},
 ],'little_giant')
 expect(read(c.enterprise.id,'2026-06-02').group).toBe('eligible')
})
it('R3 independent failed review cycle cannot recover through pass without a new award',()=>{
 const c=f.candidate('R3 independent failure',[
  {eventType:'award',year:2010,batchSeq:1},
  {eventType:'review',year:2018,decidedYear:2022,batchSeq:1,reviewOutcome:'failed'},
  {eventType:'review',year:2018,decidedYear:2025,batchSeq:1,reviewOutcome:'passed'},
 ],'little_giant')
 expect(read(c.enterprise.id,'2026-06-02').group).toBe('excluded')
})
it('a new 2023 grant and its 2025 renewal survive a 2022 failure even with coarse shared coordinates',()=>{
 const c=f.candidate('new grant renewed',[
  {eventType:'review',year:2018,decidedYear:2022,batchSeq:1,reviewOutcome:'failed'},
  {eventType:'award',year:2018,decidedYear:2023,batchSeq:1},
  {eventType:'review',year:2018,decidedYear:2025,batchSeq:1,reviewOutcome:'passed'},
 ],'little_giant')
 const actual=read(c.enterprise.id,'2026-06-02')
 expect(actual.group).toBe('eligible')
 expect(actual.effectiveQualification!.presentationBasis).toContain('默认年度规则：最近一次认定或复核通过 2025 年 + 3 = 2028 年；自 2028 年起到期（仅年份精度）')
})
it.each([
 {kind:'future-year',grantYear:2027,before:'2026-12-31',effective:'2027-01-01',after:'2027-01-02'},
 {kind:'unpublished',grantYear:2026,before:'2026-05-31',effective:'2026-06-01',after:'2026-06-02'},
] as const)('does not use a $kind grant to restore a failed cycle before it applies',({kind,grantYear,before,effective,after})=>{
 const c=f.candidate(kind+' new grant',[
  {eventType:'review',year:2018,decidedYear:2022,batchSeq:1,reviewOutcome:'failed'},
  {eventType:'review',year:2018,decidedYear:2025,batchSeq:1,reviewOutcome:'passed'},
  {eventType:'award',year:2018,decidedYear:grantYear,batchSeq:1},
 ],'little_giant')
 if(kind==='unpublished'){
  const award=f.db.select().from(s.recordEvent).all().find(e=>e.recordId===c.record.id&&e.eventType==='award')!
  const evidence=f.db.select().from(s.recordEvidence).all().find(e=>e.recordEventId===award.id)!
  const file=f.db.insert(s.storedFile).values({relPath:'unpublished-new-grant.pdf',filename:'unpublished-new-grant.pdf',ext:'pdf',bytes:1,sha256:'d'.repeat(64)}).returning().get()
  f.db.update(s.recordEvidence).set({sourceFile:file.relPath,page:1}).where(eq(s.recordEvidence.id,evidence.id)).run()
  f.db.update(s.recordEvent).set({formalValidity:{evidenceId:evidence.id,sourceSha256:file.sha256,statementPages:[1],publishedOn:effective,interval:{validFrom:effective,validThrough:'2029-05-31'}}}).where(eq(s.recordEvent.id,award.id)).run()
 }
 expect(read(c.enterprise.id,before).group).toBe('excluded')
 expect(read(c.enterprise.id,effective).group).toBe('eligible')
 expect(read(c.enterprise.id,after).group).toBe('eligible')
 const reader=createCurrentQualificationAssessmentReader(f.db.$client)
 for(const [day,status] of [[before,'expired'],[effective,'effective'],[after,'effective']] as const){
  const statuses=f.db.$client.transaction(()=>reader.readEffectiveTitles([c.enterprise.id],Date.parse(day+'T12:00:00Z'),'little_giant'))()
  expect(statuses.get(c.enterprise.id)).toBe(status)
 }
})
it.each(['none','future-year','unpublished'] as const)('an inapplicable duplicate grant cannot hide a current failure: $0',kind=>{
 const events:Parameters<typeof f.candidate>[1]=[
  {eventType:'award',year:2025,batchSeq:1},
  {eventType:'review',year:2025,decidedYear:2026,batchSeq:1,reviewOutcome:'failed'},
 ]
 if(kind!=='none') events.push({eventType:'award',year:2025,decidedYear:kind==='future-year'?2027:2026,batchSeq:1})
 const c=f.candidate('current failure '+kind,events,'little_giant')
 if(kind==='unpublished'){
  const award=f.db.select().from(s.recordEvent).all().find(e=>e.recordId===c.record.id&&e.eventType==='award'&&e.decidedYear===2026)!
  const evidence=f.db.select().from(s.recordEvidence).all().find(e=>e.recordEventId===award.id)!
  const file=f.db.insert(s.storedFile).values({relPath:'unpublished-duplicate-grant.pdf',filename:'unpublished-duplicate-grant.pdf',ext:'pdf',bytes:1,sha256:'e'.repeat(64)}).returning().get()
  f.db.update(s.recordEvidence).set({sourceFile:file.relPath,page:1}).where(eq(s.recordEvidence.id,evidence.id)).run()
  f.db.update(s.recordEvent).set({formalValidity:{evidenceId:evidence.id,sourceSha256:file.sha256,statementPages:[1],publishedOn:'2026-07-01',interval:{validFrom:'2026-07-01',validThrough:'2029-06-30'}}}).where(eq(s.recordEvent.id,award.id)).run()
 }
 expect(read(c.enterprise.id,'2026-06-02').group).toBe('excluded')
 const reader=createCurrentQualificationAssessmentReader(f.db.$client)
 const statuses=f.db.$client.transaction(()=>reader.readEffectiveTitles([c.enterprise.id],Date.parse('2026-06-02T12:00:00Z'),'little_giant'))()
 expect(statuses.get(c.enterprise.id)).toBe('expired')
})
