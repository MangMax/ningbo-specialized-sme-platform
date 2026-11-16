import { afterAll, beforeAll, expect, it } from 'vitest'
import { schema } from '../../../db/client'
import { qualificationExportFixture } from '../current-export/fixtures/qualification-export'
const f = qualificationExportFixture()
const states = ['effective','expired','terminated','moved_out','unrecognized'] as const
const sheets = ['有效企业','已到期','已注销（吊销）','已迁出','未认定']
const titles = { little_giant:'little-giant', specialized_sme:'specialized-sme', innovative_sme:'innovative-sme' }
// Fifteen distinct identities. Higher effective facts inherit; expired/nurture facts
// without own recognition are unrecognized. Subject exclusions apply at every title.
const expectedNames: Record<string, Record<string, string[]>> = {
 little_giant: {effective:['little_giant-effective'],expired:['little_giant-expired'],terminated:['little_giant-terminated'],moved_out:['little_giant-moved_out'],unrecognized:['little_giant-unrecognized']},
 specialized_sme: {effective:['little_giant-effective','specialized_sme-effective'],expired:['specialized_sme-expired'],terminated:['little_giant-terminated','specialized_sme-terminated'],moved_out:['little_giant-moved_out','specialized_sme-moved_out'],unrecognized:['little_giant-expired','little_giant-unrecognized','specialized_sme-unrecognized']},
 innovative_sme: {effective:['little_giant-effective','specialized_sme-effective','innovative_sme-effective'],expired:['innovative_sme-expired'],terminated:['little_giant-terminated','specialized_sme-terminated','innovative_sme-terminated'],moved_out:['little_giant-moved_out','specialized_sme-moved_out','innovative_sme-moved_out'],unrecognized:['little_giant-expired','little_giant-unrecognized','specialized_sme-expired','specialized_sme-unrecognized','innovative_sme-unrecognized']},
}
beforeAll(async () => {
 for (const title of Object.keys(titles)) for (const state of states) {
  const c=f.candidate(`${title}-${state}`, [{eventType:state==='unrecognized'?'nurture':'award',year:state==='expired'?2021:2026,batchSeq:1}],title)
  if(state==='effective' && title==='little_giant') {
   const event = f.db.$client.prepare('select id from record_event where record_id=?').get(c.record.id) as {id:number}
   const evidence = f.db.$client.prepare('select id from record_evidence where record_event_id=?').get(event.id) as {id:number}
   f.db.$client.prepare('update record_event set formal_validity=? where id=?').run(JSON.stringify({evidenceId:evidence.id,sourceSha256:'a'.repeat(64),statementPages:[1],interval:{validFrom:'2026-01-01',validThrough:'2028-12-31'}}),event.id)
  }
  if(state==='effective' && title==='innovative_sme') {
   const event = f.db.$client.prepare('select id from record_event where record_id=?').get(c.record.id) as {id:number}
   const evidence = f.db.$client.prepare('select id from record_evidence where record_event_id=?').get(event.id) as {id:number}
   f.db.$client.prepare('update record_event set formal_validity=? where id=?').run(JSON.stringify({evidenceId:evidence.id,sourceSha256:'a'.repeat(64),statementPages:[1],continuation:'until_next_review_results'}),event.id)
  }
  if(state==='terminated'||state==='moved_out') f.db.insert(schema.enterpriseFactRevision).values({enterpriseId:c.enterprise.id,factId:1,revision:1,status:'confirmed',fact:{kind:state==='terminated'?'cancelled':'moved_out',source:{reference:'official',statement:'verified'},effective:{precision:'day',value:'2025-01-01'},observed:{precision:'day',value:'2025-01-01'},city:null},action:'assert',actor:{type:'agent',id:'479'},basis:'verified',createdAt:'2025-01-01T00:00:00Z'}).run()
 }
 await f.start()
},60000)
afterAll(()=>f.close())
it('HTTP selects all five statuses and defaults to effective without turning notes into pending',async()=>{
 for(const title of Object.keys(titles)) for(const state of states){
  const r=await fetch(f.url(`/api/roster/current-enterprises?titleCode=${title}&status=${state}`)); expect(r.status).toBe(200)
  const b=await r.json(); expect(b.total).toBe(expectedNames[title]![state]!.length); expect(b.rows.map((r:any)=>r.name).sort()).toEqual([...expectedNames[title]![state]!].sort())
  const assessment = b.rows.find((r:any)=>r.name===`${title}-${state}`).qualificationAssessment.titles.find((t:any)=>t.titleCode===title)
  expect(assessment.effectiveQualification.status).toBe(state)
  expect(assessment.effectiveQualification.notes).toContain('来源文件版本不可用')
  expect(assessment.effectiveQualification.basis).toContain('event:')
  if(state==='effective' && title==='little_giant') expect(assessment.effectiveQualification.presentationBasis).toEqual(['正式文件有效期：2026-01-01 至 2028-12-31（含首尾）；正式来源：jxj/announcement/synthetic-118.xlsx；第 1 页'])
 }
 const b=await fetch(f.url('/api/roster/current-enterprises?titleCode=specialized_sme')).then(r=>r.json())
 expect(b.rows.map((r:any)=>r.name)).toEqual(expectedNames.specialized_sme!.effective)
 for(const title of Object.keys(titles)) {
  const pages=[]
  for(let page=1;page<=expectedNames[title]!.effective!.length;page++) {
   const b=await fetch(f.url(`/api/roster/current-enterprises?titleCode=${title}&pageSize=1&page=${page}`)).then(r=>r.json())
   pages.push(...b.rows.map((r:any)=>r.name))
  }
  expect(pages).toEqual(expectedNames[title]!.effective)
 }
 expect((await fetch(f.url('/api/roster/current-enterprises?titleCode=specialized_sme&status=pending'))).status).toBe(400)
},60000)
it('downloaded three-title workbooks have literal five-state rowsets columns and reconciled counts',async()=>{
 for(const [title,path] of Object.entries(titles)){
  const r=await fetch(f.url('/api/roster/exports/current/'+path),{method:'POST',headers:f.headers,body:JSON.stringify({clientRequestId:'479-'+title})}); expect(r.status).toBe(202)
  const job=await f.terminal((await r.json()).jobId); expect(job.state,JSON.stringify(job)).toBe('done')
  const {wb}=await f.download(job)
  expect(wb.worksheets.map(s=>s.name)).toEqual([...sheets,'口径说明'])
  for(const [i,name] of sheets.entries()){
   const s=wb.getWorksheet(name)!; const expected=expectedNames[title]![states[i]!]!; expect(s.rowCount).toBe(expected.length+1)
   expect(s.getRows(2,expected.length)!.map(row=>[row.getCell(2).value,row.getCell(3).value]).sort()).toEqual(expected.map(n=>[n,'SYNTHETIC-118-'+n]).sort())
   expect(s.getRow(1).values).toEqual([undefined,'序号','企业名称','统一社会信用代码','区县','称号','首次认定年份','认定及复核情况','公布名称','已确认曾用名','公布对应情况','情况说明','来源及页码','有效状态','有效期及排除依据','资料缺口与来源备注'])
   expect(s.getRow(2).getCell(13).value).toBe(name)
   expect(s.getRow(2).getCell(5).value).toBe(({little_giant:'专精特新“小巨人”',specialized_sme:'专精特新中小企业',innovative_sme:'创新型中小企业'} as Record<string,string>)[title])
  }
  const effective = wb.getWorksheet('有效企业')!.getRows(2,expectedNames[title]!.effective!.length)!.find(row=>row.getCell(2).value===`${title}-effective`)!
  expect(String(effective.getCell(14).value)).toContain(title==='little_giant' ? '2026-01-01 至 2028-12-31（含首尾）' : title==='innovative_sme' ? '至下次复核结果公布前有效' : '2026 年 + 3 = 2029 年')
  // Own innovative continuation and own province period take priority over inheritance.
  // Upper-only rows retain null first-recognition/source columns and use actual giant period.
  for(const row of wb.getWorksheet('有效企业')!.getRows(2,expectedNames[title]!.effective!.length)!) {
   const name=String(row.getCell(2).value)
   if(name===`${title}-effective`) continue
   expect(row.getCell(6).value).toBeNull()
   expect(row.getCell(12).value).toBeNull()
   expect(String(row.getCell(15).value)).toContain('jxj/announcement/synthetic-118.xlsx')
   expect(String(row.getCell(14).value)).toContain(name==='little_giant-effective' ? '2026-01-01 至 2028-12-31（含首尾）' : '2026 年 + 3 = 2029 年')
  }
  expect(String(effective.getCell(15).value)).toContain('来源文件版本不可用')
  expect(String(wb.getWorksheet('已注销（吊销）')!.getRow(2).getCell(14).value)).toContain('注销/吊销；生效：2025-01-01；来源：official；verified；确认依据：verified')
  expect(String(wb.getWorksheet('已迁出')!.getRow(2).getCell(14).value)).toContain('迁出；生效：2025-01-01；来源：official；verified；确认依据：verified')
  const explanation = wb.getWorksheet('口径说明')!
  expect([4,5,6,7,8].map(n => [explanation.getRow(n).getCell(1).value, explanation.getRow(n).getCell(2).value])).toEqual(sheets.map((name,i) => [name,String(expectedNames[title]![states[i]!]!.length)]))
  expect(job.result.total).toBe(title==='little_giant'?5:title==='specialized_sme'?10:15)
  expect(job.result.counts).toMatchObject({eligible:expectedNames[title]!.effective!.length,pending:0,excluded:title==='little_giant'?4:title==='specialized_sme'?8:12})
 }
},60000)

it('public empty invalid and unauthorized outcomes remain distinct',async()=>{
 const empty=await fetch(f.url('/api/roster/current-enterprises?titleCode=specialized_sme&status=expired&q=does-not-exist')); expect(empty.status).toBe(200); expect(await empty.json()).toMatchObject({total:0,rows:[]})
 expect((await fetch(f.url('/api/roster/exports/current/specialized-sme'),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({clientRequestId:'unauthorized479'})})).status).toBe(401)
})
