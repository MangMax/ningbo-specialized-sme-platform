import { afterAll, beforeAll, expect, it } from 'vitest'
import { schema } from '../db/client'
import { currentExport409Fixture } from './helpers/current-export-409'
const f = currentExport409Fixture()
const states = ['effective','expired','terminated','moved_out','unrecognized'] as const
const sheets = ['有效企业','已到期','已注销（吊销）','已迁出','未认定']
const titles = { little_giant:'little-giant', specialized_sme:'specialized-sme', innovative_sme:'innovative-sme' }
beforeAll(async () => {
 for (const title of Object.keys(titles)) for (const state of states) {
  const c=f.candidate(`${title}-${state}`, [{eventType:state==='unrecognized'?'nurture':'award',year:state==='expired'?2021:2026,batchSeq:1}],title)
  if(state==='terminated'||state==='moved_out') f.db.insert(schema.enterpriseFactRevision).values({enterpriseId:c.enterprise.id,factId:1,revision:1,status:'confirmed',fact:{kind:state==='terminated'?'cancelled':'moved_out',source:{reference:'official',statement:'verified'},effective:{precision:'day',value:'2025-01-01'},observed:{precision:'day',value:'2025-01-01'},city:null},action:'assert',actor:{type:'agent',id:'479'},basis:'verified',createdAt:'2025-01-01T00:00:00Z'}).run()
 }
 await f.start()
},60000)
afterAll(()=>f.close())
it('HTTP selects all five statuses and defaults to effective without turning notes into pending',async()=>{
 for(const title of Object.keys(titles)) for(const state of states){
  const r=await fetch(f.url(`/api/roster/current-enterprises?titleCode=${title}&status=${state}`)); expect(r.status).toBe(200)
  const b=await r.json(); expect(b.total).toBe(1); expect(b.rows.map((r:any)=>r.name)).toEqual([`${title}-${state}`])
  expect(b.rows[0].qualificationAssessment.titles.find((t:any)=>t.titleCode===title).effectiveQualification.status).toBe(state)
 }
 const b=await fetch(f.url('/api/roster/current-enterprises?titleCode=specialized_sme')).then(r=>r.json())
 expect(b.rows.map((r:any)=>r.name)).toEqual(['specialized_sme-effective'])
 expect((await fetch(f.url('/api/roster/current-enterprises?titleCode=specialized_sme&status=pending'))).status).toBe(400)
},60000)
it('downloaded three-title workbooks have literal five-state rowsets columns and reconciled counts',async()=>{
 for(const [title,path] of Object.entries(titles)){
  const r=await fetch(f.url('/api/roster/exports/current/'+path),{method:'POST',headers:f.headers,body:JSON.stringify({clientRequestId:'479-'+title})}); expect(r.status).toBe(202)
  const job=await f.terminal((await r.json()).jobId); expect(job.state,JSON.stringify(job)).toBe('done')
  const {wb}=await f.download(job)
  expect(wb.worksheets.map(s=>s.name)).toEqual([...sheets,'口径说明'])
  for(const [i,name] of sheets.entries()){
   const s=wb.getWorksheet(name)!; expect(s.rowCount).toBe(2)
   expect(s.getRow(1).values).toEqual([undefined,'序号','企业名称','统一社会信用代码','区县','称号','首次认定年份','认定及复核情况','公布名称','已确认曾用名','公布对应情况','情况说明','来源及页码','有效状态','有效期及排除依据','资料缺口与来源备注'])
   expect(s.getRow(2).getCell(2).value).toBe(`${title}-${states[i]}`)
   expect(s.getRow(2).getCell(13).value).toBe(name)
   expect(s.getRow(2).getCell(5).value).toBe(({little_giant:'专精特新“小巨人”',specialized_sme:'专精特新中小企业',innovative_sme:'创新型中小企业'} as Record<string,string>)[title])
  }
  expect(job.result.total).toBe(5)
  expect(job.result.counts).toMatchObject({eligible:1,pending:0,excluded:4})
 }
},60000)

it('public empty invalid and unauthorized outcomes remain distinct',async()=>{
 const empty=await fetch(f.url('/api/roster/current-enterprises?titleCode=specialized_sme&status=expired&q=does-not-exist')); expect(empty.status).toBe(200); expect(await empty.json()).toMatchObject({total:0,rows:[]})
 expect((await fetch(f.url('/api/roster/exports/current/specialized-sme'),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({clientRequestId:'unauthorized479'})})).status).toBe(401)
})
