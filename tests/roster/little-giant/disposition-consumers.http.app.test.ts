import { afterAll, beforeAll, expect, it } from 'vitest'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { qualificationExportFixture } from '../current-export/fixtures/qualification-export'
import { readDevelopmentDiscovery } from '../current-export/fixtures/specialized-export'
import * as s from '../../../db/schema'

// Exact candidate build and process execution are owned by the parent merger.
const f = qualificationExportFixture()
const priorNodeOptions = process.env.NODE_OPTIONS
beforeAll(async () => {
 const discovery = await readDevelopmentDiscovery()
 expect(JSON.stringify(discovery)).toContain('/api/roster/title-cycle-dispositions/preflight')
 const clock = join(f.dir,'clock.mjs')
 writeFileSync(clock, `const D=Date;globalThis.Date=class extends D{constructor(...a){super(...(a.length?a:['2026-06-01T00:00:00Z']))}static now(){return 1780272000000}}`)
 process.env.NODE_OPTIONS = `${priorNodeOptions ?? ''} --import=${clock}`
 await f.start()
},90000)
afterAll(async () => { if(priorNodeOptions == null) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS=priorNodeOptions; await f.close() })
const get = async(path:string) => { const r=await fetch(f.url(path),{headers:f.headers});expect(r.status,await r.clone().text()).toBe(200);return r.json() }
const post = async(path:string, body:unknown) => { const r=await fetch(f.url(path),{method:'POST',headers:f.headers,body:JSON.stringify(body)});expect(r.status,await r.clone().text()).toBe(200);return r.json() }
it('confirmed cycle dispositions keep HTTP detail statistics filters and XLSX identities aligned across withdrawal and source replacement',async()=>{
 // Inspect the live isolated process contract before issuing business commands.
 expect(JSON.stringify(await get('/_openapi.json'))).toContain('title-cycle-dispositions')
 const c=f.candidate('合成周期处置',[{eventType:'award',year:2025,batchSeq:1}],'little_giant')
 const event=f.db.select().from(s.recordEvent).all().find(e=>e.recordId===c.record.id)!
 const file=f.db.insert(s.storedFile).values({relPath:'synthetic-cycle.pdf',filename:'synthetic-cycle.pdf',ext:'pdf',sha256:'a'.repeat(64),bytes:1,createdAt:'2026-01-01'}).returning().get()
 const run=async(operations:unknown[])=>{
  const current=await get(`/api/roster/title-cycle-dispositions/current?enterpriseIds=${c.enterprise.id}`)
  const request={operations,idempotencyKey:crypto.randomUUID(),expectedVersion:current.version,actor:{type:'agent',id:'synthetic'},basis:'合成周期依据'}
  const plan=await post('/api/roster/title-cycle-dispositions/preflight',request)
  return post('/api/roster/title-cycle-dispositions/commit',{request,planHash:plan.planHash})
 }
 const fact={kind:'not_applied',source:{fileId:file.id,sha256:file.sha256,reference:'第1页',statement:'未申请复核'},cycle:{eventId:event.id,revision:1},observed:{precision:'day',value:'2026-01-01'},effective:{precision:'day',value:'2026-06-01'},effectiveBasis:'原周期自2026-06-01终止'}
 const check=async(included:boolean,key:string)=>{
  const expected=included?[c.enterprise.usccNorm]:[]
  for(const suffix of ['', '&district=鄞州区','&recognitionFrom=2025-01-01&recognitionTo=2025-12-31']){
   const list=await get('/api/roster/current-enterprises?titleCode=little_giant'+suffix)
   expect(list.rows.map((r:any)=>r.uscc)).toEqual(expected);expect(list.total).toBe(expected.length)
  }
  const detail=await get(`/api/roster/enterprises/${c.enterprise.id}`)
  const giant=detail.qualificationAssessment.titles.find((t:any)=>t.titleCode==='little_giant')
  expect(giant.group).toBe(included?'eligible':'excluded')
  const stats=await get('/api/statistics/districts?title=little_giant&district=鄞州区')
  expect(stats.total).toBe(expected.length)
  const submitted=await fetch(f.url('/api/roster/exports/current/little-giant'),{method:'POST',headers:f.headers,body:JSON.stringify({clientRequestId:key})})
  expect(submitted.status).toBe(202)
  const job=await f.terminal((await submitted.json()).jobId);expect(job.state,JSON.stringify(job)).toBe('done')
  const {wb,bytes}=await f.download(job), sheet=wb.getWorksheet('有效企业')!
  expect(Array.from({length:sheet.rowCount-1},(_,i)=>sheet.getRow(i+2).getCell(2).value)).toEqual(included?['合成周期处置']:[])
  if(included){
   expect(JSON.stringify(sheet.getRow(2).values)).toContain(c.enterprise.usccNorm)
   expect(JSON.stringify(sheet.getRow(2).values)).toContain('2028')
   expect(giant.effectiveQualification.presentationBasis.join(' ')).toContain('2025 年 + 3 = 2028 年')
  } else {
   const expired=wb.getWorksheet('已到期')!
   expect(expired.getRow(2).getCell(3).value).toBe(c.enterprise.usccNorm)
   expect(JSON.stringify(expired.getRow(2).values)).toContain('第1页')
   expect(JSON.stringify(expired.getRow(2).values)).toContain('2026-06-01')
  }
  return {giant,job,bytes}
 }
 const before=await check(true,'before')
 const asserted=await run([{action:'assert',enterpriseId:c.enterprise.id,fact}])
 await run([{action:'confirm',id:asserted.ids[0],revision:1}])
 const excluded=await check(false,'excluded')
 expect(excluded.giant.effectiveQualification.basis).toContain(asserted.ids[0])
 expect(excluded.giant.effectiveQualification.presentationBasis.join(' ')).toContain('第1页')
 expect(excluded.giant.versions.decisions).not.toBe(before.giant.versions.decisions)
 await run([{action:'withdraw',id:asserted.ids[0],revision:2}])
 await check(true,'withdrawn')
 const second=await run([{action:'assert',enterpriseId:c.enterprise.id,fact:{...fact,kind:'not_recommended'}}])
 await run([{action:'confirm',id:second.ids[0],revision:1}])
 await check(false,'second')
 f.db.$client.prepare('update stored_file set sha256=? where id=?').run('b'.repeat(64),file.id)
 const revised=await check(true,'source-revised')
 expect(revised.giant.versions.sources).not.toBe(excluded.giant.versions.sources)
 expect((await f.download(before.job)).bytes.equals(before.bytes)).toBe(true)
},90000)
