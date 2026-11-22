import ExcelJS from 'exceljs'
import { eq } from 'drizzle-orm'
import { join } from 'node:path'
import { writePostgresCurrentWorkbook } from '../../../layers/sme-roster/lib/roster/current-workbook-postgres'
import { afterAll, expect, it, vi } from 'vitest'
import { qualificationExportFixture } from '../current-export/fixtures/qualification-export'
import { readPostgresCurrentStatusBatch } from '../../../layers/sme-roster/lib/roster/current-qualification-postgres'
import { readPostgresRosterEnterpriseDetail } from '../../../layers/sme-roster/lib/roster/enterprise-detail-postgres'
import { dispositionRequestSchema } from '../../../layers/sme-roster/server/utils/title-cycle-disposition-model'
import { commitPostgresDisposition, preflightPostgresDisposition, readPostgresDispositions } from '../../../layers/sme-roster/server/utils/title-cycle-disposition-postgres'
import type { CurrentTitle } from '../../../layers/sme-roster/lib/roster/current-titles'
import { singlePostgresFixtureRow } from '../../support/isolated-postgres-cases'
import * as s from '../fixtures/postgres-tables'
const f = qualificationExportFixture()
async function append(recordId: number, event: {eventType:'review'|'award';year:number;decidedYear?:number;batchSeq:number;reviewOutcome?:'passed'}) {
 const e=singlePostgresFixtureRow(await f.db.insert(s.recordEvent).values({recordId,...event}).returning())
 await f.db.insert(s.recordEvidence).values({recordEventId:e.id,sourceFile:'synthetic.pdf'})
}
afterAll(() => f.close())
const at = (day: string) => Date.parse(day + 'T12:00:00Z')
async function snapshot(id: number, day: string) {
 return (await readPostgresRosterEnterpriseDetail(f.db, id, at(day)))!.qualificationAssessment
}
const read = async (id: number, day: string, title: CurrentTitle = 'little_giant') => (await snapshot(id, day)).titles.find(t => t.titleCode === title)!
const readEffective = (id: number, day: string) => f.db.transaction(tx => readPostgresCurrentStatusBatch(tx, [id], 'little_giant', at(day)), { isolationLevel: 'repeatable read', accessMode: 'read only' })

async function setup(kind: 'not_applied' | 'not_recommended', patch: Record<string, unknown> = {}) {
 const c = await f.candidate(kind+crypto.randomUUID(),[{eventType:'award',year:2025,batchSeq:1}],'little_giant')
 const event = singlePostgresFixtureRow(await f.db.select().from(s.recordEvent).where(eq(s.recordEvent.recordId, c.record.id)))
 const file = singlePostgresFixtureRow(await f.db.insert(s.storedFile).values({
  relPath:crypto.randomUUID()+'.pdf',filename:kind+'.pdf',ext:'pdf',bytes: 1n,sha256:'a'.repeat(64),createdAt:'2026-01-01',
 }).returning())
 const fact = {kind,source:{fileId:file.id,sha256:file.sha256,reference:'第1页',statement:kind},cycle:{eventId:event.id,revision:event.revision},observed:{precision:'day',value:'2026-01-01'},effective:{precision:'day',value:'2026-06-01'},effectiveBasis:'原周期自2026-06-01终止',...patch}
 const run = async (operations: unknown[]) => {
  const current = await readPostgresDispositions(f.db, [c.enterprise.id], true)
  if (!('version' in current)) throw new Error('Expected current disposition version')
  const request = dispositionRequestSchema.parse({ idempotencyKey:crypto.randomUUID(), expectedVersion:current.version,
   actor:{type:'agent',id:'synthetic'}, basis:'synthetic verified source', operations })
  const { planHash } = await preflightPostgresDisposition(f.db, request)
  return commitPostgresDisposition(f.db, request, planHash)
 }
 const assertion = await run([{ action:'assert', enterpriseId:c.enterprise.id, fact }])
 await run([{ action:'confirm', id:assertion.ids[0], revision:1 }])
 return {...c,event,file,fact,run,id:assertion.ids[0]}
}
it.each(['not_applied','not_recommended'] as const)('applies confirmed %s only at the supported day and restores on withdrawal',async kind=>{
 const c=await setup(kind)
 expect((await read(c.enterprise.id,'2026-05-31')).group).toBe('eligible')
 const excluded=await read(c.enterprise.id,'2026-06-01')
 expect(excluded.group).toBe('excluded')
 expect(excluded.effectiveQualification!.basis).toContain(c.id)
 expect(excluded.effectiveQualification!.presentationBasis!.join(' ')).toContain('第1页')
 await c.run([{action:'withdraw',id:c.id,revision:2}])
 const restored=await read(c.enterprise.id,'2026-06-01')
 expect(restored.group).toBe('eligible')
 expect(restored.versions.decisions).not.toBe(excluded.versions.decisions)
})

it.each([
 ['unknown-cycle',{cycle:null}], ['unknown-day',{effective:{precision:'unknown',value:null}}],
 ['coarse-day',{effective:{precision:'month',value:'2026-06'}}], ['unknown-basis',{effectiveBasis:null}],
] as const)('retains qualification with %s rather than inventing an exclusion',async (_,patch)=>{
 const c=await setup('not_applied',patch)
 expect((await read(c.enterprise.id,'2026-06-02')).group).toBe('eligible')
})
it('re-evaluates source changes and keeps immutable successful receipts',async()=>{
 const c=await setup('not_applied'), before=await read(c.enterprise.id,'2026-06-02')
 await f.db.update(s.storedFile).set({ removedAt: '2026-06-02' }).where(eq(s.storedFile.id, c.file.id))
 const after=await read(c.enterprise.id,'2026-06-02')
 expect(after.group).toBe('eligible');expect(after.versions.sources).not.toBe(before.versions.sources)
 expect((await readPostgresDispositions(f.db,[c.enterprise.id],true)).rows[0]).toMatchObject({ sourceCurrent:false })
})
it('new award survives old-cycle disposition while a pass cannot erase it',async()=>{
 const c=await setup('not_recommended')
 await append(c.record.id,{eventType:'review',year:2025,decidedYear:2026,batchSeq:1,reviewOutcome:'passed'})
 expect((await read(c.enterprise.id,'2026-06-02')).group).toBe('excluded')
 await append(c.record.id,{eventType:'award',year:2026,batchSeq:2})
 expect((await read(c.enterprise.id,'2026-06-02')).group).toBe('eligible')
})
it('formal failure of an older cycle cannot cancel a new award or become a re-award through a pass',async()=>{
 const c=await f.candidate('formal old',[{eventType:'award',year:2024,batchSeq:1},{eventType:'review',year:2024,decidedYear:2026,batchSeq:1,reviewOutcome:'failed'},{eventType:'review',year:2024,decidedYear:2027,batchSeq:1,reviewOutcome:'passed'}],'little_giant')
 expect((await read(c.enterprise.id,'2027-06-02')).group).toBe('excluded')
 await append(c.record.id,{eventType:'award',year:2025,batchSeq:2})
 expect((await read(c.enterprise.id,'2026-06-02')).group).toBe('eligible')
})
it.each([2022,2024])('prior award %s remains valid until its linked failure is published',async year=>{
 const c=await f.candidate('future failed review '+year,[
  {eventType:'award',year,batchSeq:1},
  {eventType:'review',year,decidedYear:2026,batchSeq:1,reviewOutcome:'failed'},
 ],'little_giant')
 const events=(await f.db.select().from(s.recordEvent)).filter(e=>e.recordId===c.record.id)
 const award=events.find(e=>e.eventType==='award')!, review=events.find(e=>e.eventType==='review')!
 const evidence=(await f.db.select().from(s.recordEvidence)).find(e=>e.recordEventId===review.id)!
 const file=singlePostgresFixtureRow(await f.db.insert(s.storedFile).values({relPath:'future-failed-review-'+year+'.pdf',filename:'future-failed-review.pdf',ext:'pdf',bytes: 1n,sha256:'c'.repeat(64),createdAt:'2026-01-01'}).returning())
 await f.db.update(s.recordEvidence).set({sourceFile:file.relPath,page:1}).where(eq(s.recordEvidence.id,evidence.id))
 await f.db.update(s.recordEvent).set({formalValidity:JSON.stringify({evidenceId:evidence.id,sourceSha256:file.sha256,statementPages:[1],originAwardEventId:award.id,publishedOn:'2026-06-01',continuation:'until_this_review_results'})}).where(eq(s.recordEvent.id,review.id))
 expect((await read(c.enterprise.id,'2026-05-31')).group).toBe('eligible')
 expect((await read(c.enterprise.id,'2026-06-01')).group).toBe('excluded')
 expect((await read(c.enterprise.id,'2026-06-02')).group).toBe('excluded')

 for(const [day,status] of [['2026-05-31','effective'],['2026-06-01','expired']] as const){
  const statuses=await readEffective(c.enterprise.id, day)
  expect(statuses.get(c.enterprise.id)).toBe(status)
 }
})
it('replacement retires the old exclusion while unconfirmed and coarse replacement facts remain observations',async()=>{
 const c=await setup('not_applied')
 const replacement=await c.run([{action:'replace',id:c.id,revision:2,fact:{...c.fact,kind:'not_recommended',effective:{precision:'year',value:'2026'}}}])
 expect((await read(c.enterprise.id,'2026-06-02')).group).toBe('eligible')
 await c.run([{action:'confirm',id:replacement.ids[0],revision:1}])
 expect((await read(c.enterprise.id,'2026-06-02')).group).toBe('eligible')
})
it('lower-title formal failure cannot cancel the giant',async()=>{
 const c=await f.candidate('low title failure',[{eventType:'award',year:2025,batchSeq:1}],'little_giant')
 await f.addRecord(c.enterprise.id,'low title failure',[{eventType:'award',year:2024,batchSeq:1},{eventType:'review',year:2024,decidedYear:2026,batchSeq:1,reviewOutcome:'failed'}],'specialized_sme')
 expect((await read(c.enterprise.id,'2026-06-02')).group).toBe('eligible')
})
it('batched effective reads agree with full assessments at literal date boundaries',async()=>{
 const c=await setup('not_applied')
 for(const [day,status] of [['2026-05-31','effective'],['2026-06-01','expired'],['2026-06-02','expired']] as const){
  const result=await readEffective(c.enterprise.id, day)
  expect(result.get(c.enterprise.id)).toBe(status)
 }
})
it('normal review pass supports its period without manufacturing an award',async()=>{
 const c=await f.candidate('orphan pass',[{eventType:'review',year:2024,decidedYear:2026,batchSeq:1,reviewOutcome:'passed'}],'little_giant')
 expect((await read(c.enterprise.id,'2026-06-02')).group).toBe('eligible')
 expect((await read(c.enterprise.id,'2029-01-01')).group).toBe('eligible')
})

it('streamed XLSX retains stable identities source and effective day with the same common decision',async()=>{
 const c=await setup('not_recommended')
 vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-06-01T12:00:00Z'))
 try {
  const path=join(f.dir,'dispositions.xlsx')
  await writePostgresCurrentWorkbook(f.db,'little_giant',path,async()=>{})
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
it('failure with unknown original cycle cannot exclude a known award',async()=>{
 const c=await f.candidate('unknown failure cycle',[{eventType:'award',year:2025,batchSeq:1},{eventType:'review',year:2025,decidedYear:2026,batchSeq:null,reviewOutcome:'failed'}],'little_giant')
 expect((await read(c.enterprise.id,'2026-06-02')).group).toBe('eligible')
})

it('normal known and unknown batch passes retain qualification without an age cutoff',async()=>{
 const c=await f.candidate('G normal passes',[
  {eventType:'review',year:2022,decidedYear:2025,batchSeq:1,reviewOutcome:'passed'},
  {eventType:'review',year:2022,decidedYear:2025,batchSeq:null,reviewOutcome:'passed'},
 ],'little_giant')
 const actual=await read(c.enterprise.id,'2026-06-02')
 expect(actual.group).toBe('eligible')
 expect(actual.effectiveQualification!.presentationBasis).toContain('小巨人原认定或复核通过资格保留；不按认定年龄自动到期，适用正式期间、同周期失败及已确认处置另行裁定')
 expect((await read(c.enterprise.id,'2028-01-01')).group).toBe('eligible')
})
it('C same-cycle failure cannot renew the 2018 award through a 2025 pass',async()=>{
 const c=await f.candidate('C failed pass',[
  {eventType:'award',year:2018,batchSeq:1},
  {eventType:'review',year:2018,decidedYear:2022,batchSeq:1,reviewOutcome:'failed'},
  {eventType:'review',year:2018,decidedYear:2025,batchSeq:1,reviewOutcome:'passed'},
 ],'little_giant')
 expect((await read(c.enterprise.id,'2026-06-02')).group).toBe('excluded')
})
it('D independent 2022 cycle pass retains its 2025 period without an award row',async()=>{
 const c=await f.candidate('D renewal only',[
  {eventType:'award',year:2018,batchSeq:1,decidedYear:2023},
  {eventType:'review',year:2022,decidedYear:2025,batchSeq:1,reviewOutcome:'passed'},
 ],'little_giant')
 const actual=await read(c.enterprise.id,'2026-06-02')
 expect(actual.group).toBe('eligible')
 expect(actual.effectiveQualification!.presentationBasis).toContain('小巨人原认定或复核通过资格保留；不按认定年龄自动到期，适用正式期间、同周期失败及已确认处置另行裁定')
})
it('A failed second batch does not cancel the first batch 2025 renewal',async()=>{
 const c=await f.candidate('A two batches',[
  {eventType:'award',year:2022,batchSeq:1},{eventType:'award',year:2022,batchSeq:2},
  {eventType:'review',year:2022,decidedYear:2025,batchSeq:1,reviewOutcome:'passed'},
  {eventType:'review',year:2022,decidedYear:2025,batchSeq:2,reviewOutcome:'failed'},
 ],'little_giant')
 expect((await read(c.enterprise.id,'2026-06-02')).group).toBe('eligible')
})
it('an independent failed review cycle does not revoke an unrelated original award',async()=>{
 const c=await f.candidate('R3 independent failure',[
  {eventType:'award',year:2010,batchSeq:1},
  {eventType:'review',year:2018,decidedYear:2022,batchSeq:1,reviewOutcome:'failed'},
  {eventType:'review',year:2018,decidedYear:2025,batchSeq:1,reviewOutcome:'passed'},
 ],'little_giant')
 expect((await read(c.enterprise.id,'2026-06-02')).group).toBe('eligible')
})
it('a new 2023 grant and its 2025 renewal survive a 2022 failure even with coarse shared coordinates',async()=>{
 const c=await f.candidate('new grant renewed',[
  {eventType:'review',year:2018,decidedYear:2022,batchSeq:1,reviewOutcome:'failed'},
  {eventType:'award',year:2018,decidedYear:2023,batchSeq:1},
  {eventType:'review',year:2018,decidedYear:2025,batchSeq:1,reviewOutcome:'passed'},
 ],'little_giant')
 const actual=await read(c.enterprise.id,'2026-06-02')
 expect(actual.group).toBe('eligible')
 expect(actual.effectiveQualification!.presentationBasis).toContain('小巨人原认定或复核通过资格保留；不按认定年龄自动到期，适用正式期间、同周期失败及已确认处置另行裁定')
})
it.each([
 {kind:'future-year',grantYear:2027,before:'2026-12-31',effective:'2027-01-01',after:'2027-01-02'},
 {kind:'unpublished',grantYear:2026,before:'2026-05-31',effective:'2026-06-01',after:'2026-06-02'},
] as const)('does not use a $kind grant to restore a failed cycle before it applies',async ({kind,grantYear,before,effective,after})=>{
 const c=await f.candidate(kind+' new grant',[
  {eventType:'review',year:2018,decidedYear:2022,batchSeq:1,reviewOutcome:'failed'},
  {eventType:'review',year:2018,decidedYear:2025,batchSeq:1,reviewOutcome:'passed'},
  {eventType:'award',year:2018,decidedYear:grantYear,batchSeq:1},
 ],'little_giant')
 if(kind==='unpublished'){
  const award=(await f.db.select().from(s.recordEvent)).find(e=>e.recordId===c.record.id&&e.eventType==='award')!
  const evidence=(await f.db.select().from(s.recordEvidence)).find(e=>e.recordEventId===award.id)!
  const file=singlePostgresFixtureRow(await f.db.insert(s.storedFile).values({relPath:'unpublished-new-grant.pdf',filename:'unpublished-new-grant.pdf',ext:'pdf',bytes: 1n,sha256:'d'.repeat(64),createdAt:'2026-01-01'}).returning())
  await f.db.update(s.recordEvidence).set({sourceFile:file.relPath,page:1}).where(eq(s.recordEvidence.id,evidence.id))
  await f.db.update(s.recordEvent).set({formalValidity:JSON.stringify({evidenceId:evidence.id,sourceSha256:file.sha256,statementPages:[1],publishedOn:effective,interval:{validFrom:effective,validThrough:'2029-05-31'}})}).where(eq(s.recordEvent.id,award.id))
 }
 expect((await read(c.enterprise.id,before)).group).toBe('excluded')
 expect((await read(c.enterprise.id,effective)).group).toBe('eligible')
 expect((await read(c.enterprise.id,after)).group).toBe('eligible')

 for(const [day,status] of [[before,'expired'],[effective,'effective'],[after,'effective']] as const){
  const statuses=await readEffective(c.enterprise.id, day)
  expect(statuses.get(c.enterprise.id)).toBe(status)
 }
})
it.each(['none','future-year','unpublished'] as const)('an inapplicable duplicate grant cannot hide a current failure: $0',async kind=>{
 const events:Parameters<typeof f.candidate>[1]=[
  {eventType:'award',year:2025,batchSeq:1},
  {eventType:'review',year:2025,decidedYear:2026,batchSeq:1,reviewOutcome:'failed'},
 ]
 if(kind!=='none') events.push({eventType:'award',year:2025,decidedYear:kind==='future-year'?2027:2026,batchSeq:1})
 const c=await f.candidate('current failure '+kind,events,'little_giant')
 if(kind==='unpublished'){
  const award=(await f.db.select().from(s.recordEvent)).find(e=>e.recordId===c.record.id&&e.eventType==='award'&&e.decidedYear===2026)!
  const evidence=(await f.db.select().from(s.recordEvidence)).find(e=>e.recordEventId===award.id)!
  const file=singlePostgresFixtureRow(await f.db.insert(s.storedFile).values({relPath:'unpublished-duplicate-grant.pdf',filename:'unpublished-duplicate-grant.pdf',ext:'pdf',bytes: 1n,sha256:'e'.repeat(64),createdAt:'2026-01-01'}).returning())
  await f.db.update(s.recordEvidence).set({sourceFile:file.relPath,page:1}).where(eq(s.recordEvidence.id,evidence.id))
  await f.db.update(s.recordEvent).set({formalValidity:JSON.stringify({evidenceId:evidence.id,sourceSha256:file.sha256,statementPages:[1],publishedOn:'2026-07-01',interval:{validFrom:'2026-07-01',validThrough:'2029-06-30'}})}).where(eq(s.recordEvent.id,award.id))
 }
 expect((await read(c.enterprise.id,'2026-06-02')).group).toBe('excluded')

 const statuses=await readEffective(c.enterprise.id, '2026-06-02')
 expect(statuses.get(c.enterprise.id)).toBe('expired')
})

it('retains an old giant award without a passed review and inherits it through the common batch reader',async()=>{
 const c=await f.candidate('old giant no review',[{eventType:'award',year:2018,batchSeq:1}],'little_giant')
 const assessment = await snapshot(c.enterprise.id, '2026-06-02')
 expect(assessment.titles.map(t=>t.group)).toEqual(['eligible','eligible','eligible'])
 expect(assessment.titles[0]!.effectiveQualification!.presentationBasis!.join(' ')).not.toContain('2018 年 + 3')
 const statuses = await readEffective(c.enterprise.id, '2026-06-02')
 expect(statuses.get(c.enterprise.id)).toBe('effective')
})

it.each(['specialized_sme','innovative_sme'] as const)('still expires an independent %s at business year plus three', async title => {
 const c = await f.candidate('annual '+title,[{eventType:'award',year:2023,batchSeq:1}],title)
 expect((await read(c.enterprise.id, '2025-12-31', title)).group).toBe('eligible')
 expect((await read(c.enterprise.id, '2026-01-01', title)).group).toBe('excluded')
})
