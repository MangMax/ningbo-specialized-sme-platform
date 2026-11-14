import { beforeAll, afterAll, expect, it } from 'vitest'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { currentExport409Fixture } from './helpers/current-export-409'
const f=currentExport409Fixture()
let digest=''
beforeAll(async()=>{
  const clock=join(f.dir,'clock.mjs')
  writeFileSync(clock,`const RealDate=Date; globalThis.Date=class extends RealDate {constructor(...args){super(...(args.length?args:['2026-06-01T00:00:00Z']))} static now(){return 1780272000000}}`)
  process.env.NODE_OPTIONS=`${process.env.NODE_OPTIONS ?? ''} --import=${clock}`
  for(const [name,titles] of [['none',[]],['specialized',['specialized_sme']],['innovative',['innovative_sme']],['both',['specialized_sme','innovative_sme']],['platform',['specialized_sme','innovative_sme']]] as const){
    const c=f.candidate(name,[{eventType:'award',year:2025,batchSeq:1}],'little_giant')
    for(const title of titles) f.addRecord(c.enterprise.id,name,[{eventType:name==='platform'?'maintain':'award',year:2018,batchSeq:1}],title)
  }
  digest=f.businessDigest()
  await f.start()
},90000)
afterAll(()=>f.close())
it.each([['specialized_sme','specialized-sme',['specialized','both']],['innovative_sme','innovative-sme',['innovative','both']]] as const)('public HTTP MCP and downloaded workbook agree for %s',async(title,slug,names)=>{
 const response=await fetch(f.url(`/api/roster/current-enterprises?titleCode=${title}`))
 expect(response.status).toBe(200)
 const body=await response.json()
 expect(body.snapshotStartedAt).toBe('2026-06-01T00:00:00.000Z')
 expect(body.total).toBe(2)
 expect(body.rows.map((r:{name:string})=>r.name)).toEqual(names)
 for(const row of body.rows) {
   expect(row.notes.join(' ')).toContain('按有效小巨人资格计入')
   const detail=await fetch(f.url(`/api/roster/enterprises/${row.enterpriseId}`)).then(r=>r.json())
   expect(detail.qualificationAssessment.asOf).toBe('2026-06-01T00:00:00.000Z')
   expect(detail.qualificationAssessment.titles.find((t:{titleCode:string})=>t.titleCode===title).effectiveQualification.status).toBe('effective')
 }
 const page=await fetch(f.url(`/api/roster/current-enterprises?titleCode=${title}&pageSize=1&page=2`)).then(r=>r.json())
 expect(page.total).toBe(2)
 expect(page.rows.map((r:{name:string})=>r.name)).toEqual(['both'])
 const m=await fetch(f.url('/mcp'),{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream','mcp-protocol-version':'2025-06-18'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'list_current_qualified_enterprises',arguments:{titleCode:title}}})})
 const raw=await m.text()
 const wire=JSON.parse(raw.startsWith('event:')?raw.split('\n').find(l=>l.startsWith('data: '))!.slice(6):raw)
 expect(JSON.parse(wire.result.content[0].text).rows.map((r:{name:string})=>r.name)).toEqual(names)
 const submitted=await fetch(f.url(`/api/roster/exports/current/${slug}`),{method:'POST',headers:f.headers,body:JSON.stringify({clientRequestId:`687-${slug}`})})
 expect(submitted.status).toBe(202)
 const accepted=await submitted.json(), job=await f.terminal(accepted.jobId)
 expect(job.state,JSON.stringify(job)).toBe('done')
 const {wb}=await f.download(job)
 const sheet=wb.getWorksheet('有效企业')!
 expect(Array.from({length:sheet.rowCount-1},(_,i)=>sheet.getRow(i+2).getCell(2).value)).toEqual(names)
 for(let i=2;i<=sheet.rowCount;i++) expect(JSON.stringify(sheet.getRow(i).values)).toContain('按有效小巨人资格计入')
 expect(f.businessDigest()).toBe(digest)
},90000)

it('retains complete inherited evidence and versions across page sizes and later requests', async () => {
  const query = async (pageSize: number) => {
    const response = await fetch(f.url(`/api/roster/current-enterprises?titleCode=specialized_sme&pageSize=${pageSize}`))
    expect(response.status).toBe(200)
    return response.json()
  }
  const small = await query(1)
  const large = await query(200)
  expect(large.total).toBe(2)
  expect(large.rows.map((row: { name: string }) => row.name)).toEqual(['specialized', 'both'])
  expect(small.rows[0]).toEqual(large.rows[0])
  for (const row of large.rows) {
    const detail = await fetch(f.url(`/api/roster/enterprises/${row.enterpriseId}`)).then(response => response.json())
    expect(row.qualificationAssessment).toEqual(detail.qualificationAssessment)
    const titles = row.qualificationAssessment.titles
    expect(titles).toHaveLength(3)
    const lower = titles.find((title: { titleCode: string }) => title.titleCode === 'specialized_sme')
    const giant = titles.find((title: { titleCode: string }) => title.titleCode === 'little_giant')
    expect(lower.evidence).toEqual([expect.objectContaining({ eventType: 'award', year: 2018 })])
    expect(giant.evidence).toEqual([expect.objectContaining({ eventType: 'award', year: 2025 })])
    expect(lower.effectiveQualification.status).toBe('effective')
    expect(lower.references).toEqual(expect.arrayContaining(giant.references.map((reference: string) => '小巨人依据：' + reference)))
  }
  expect(await query(200)).toEqual(large)
  expect(f.businessDigest()).toBe(digest)
}, 90000)
