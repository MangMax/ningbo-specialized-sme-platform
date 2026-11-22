import { beforeAll, afterAll, expect, it } from 'vitest'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import pg from 'pg'
import { qualificationExportFixture, businessTables } from '../current-export/fixtures/qualification-export'
const f=qualificationExportFixture()
let digest: Awaited<ReturnType<typeof f.runtimeBusinessRows>>
const priorNodeOptions=process.env.NODE_OPTIONS
beforeAll(async()=>{
  const clock=join(f.dir,'clock.mjs')
  writeFileSync(clock,`const RealDate=Date; globalThis.Date=class extends RealDate {constructor(...args){super(...(args.length?args:['2026-06-01T00:00:00Z']))} static now(){return 1780272000000}}`)
  process.env.NODE_OPTIONS=`${process.env.NODE_OPTIONS ?? ''} --import=${clock}`
  for(const [name,titles] of [['none',[]],['specialized',['specialized_sme']],['innovative',['innovative_sme']],['both',['specialized_sme','innovative_sme']],['platform',['specialized_sme','innovative_sme']]] as const){
    const c=f.candidate(name,[{eventType:'award',year:2025,batchSeq:1}],'little_giant')
    for(const title of titles) f.addRecord(c.enterprise.id,name,[{eventType:name==='platform'?'maintain':'award',year:2018,batchSeq:1}],title)
  }
  await f.start()
  digest = await f.runtimeBusinessRows(businessTables)
},90000)
afterAll(async()=>{ if(priorNodeOptions == null) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS=priorNodeOptions; await f.close() })
it.each([['specialized_sme','specialized-sme',['none','specialized','innovative','both','platform']],['innovative_sme','innovative-sme',['none','specialized','innovative','both','platform']]] as const)('public HTTP MCP and downloaded workbook agree for %s',async(title,slug,names)=>{
 const response=await fetch(f.url(`/api/roster/current-enterprises?titleCode=${title}`))
 expect(response.status).toBe(200)
 const body=await response.json()
 expect(body.snapshotStartedAt).toBe('2026-06-01T00:00:00.000Z')
 expect(body.total).toBe(5)
 expect(body.rows.map((r:{name:string})=>r.name)).toEqual(names)
 for(const row of body.rows) {
   expect(row.notes.join(' ')).toContain('按有效小巨人资格计入')
   const detail=await fetch(f.url(`/api/roster/enterprises/${row.enterpriseId}`)).then(r=>r.json())
   expect(detail.qualificationAssessment.asOf).toBe('2026-06-01T00:00:00.000Z')
   expect(detail.qualificationAssessment.titles.find((t:{titleCode:string})=>t.titleCode===title).effectiveQualification.status).toBe('effective')
 }
 const page=await fetch(f.url(`/api/roster/current-enterprises?titleCode=${title}&pageSize=1&page=2`)).then(r=>r.json())
 expect(page.total).toBe(5)
 expect(page.rows.map((r:{name:string})=>r.name)).toEqual(['specialized'])
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
 expect(await f.runtimeBusinessRows(businessTables)).toEqual(digest)
},90000)

it('retains complete inherited evidence and versions across page sizes and later requests', async () => {
  const query = async (pageSize: number) => {
    const response = await fetch(f.url(`/api/roster/current-enterprises?titleCode=specialized_sme&pageSize=${pageSize}`))
    expect(response.status).toBe(200)
    return response.json()
  }
  const small = await query(1)
  const large = await query(200)
  expect(large.total).toBe(5)
  expect(large.rows.map((row: { name: string }) => row.name)).toEqual(['none','specialized','innovative','both','platform'])
  expect(small.rows[0]).toEqual(large.rows[0])
  for (const row of large.rows) {
    const detail = await fetch(f.url(`/api/roster/enterprises/${row.enterpriseId}`)).then(response => response.json())
    expect(row.qualificationAssessment).toEqual(detail.qualificationAssessment)
    const titles = row.qualificationAssessment.titles
    expect(titles).toHaveLength(3)
    const lower = titles.find((title: { titleCode: string }) => title.titleCode === 'specialized_sme')
    const giant = titles.find((title: { titleCode: string }) => title.titleCode === 'little_giant')
    expect(lower.evidence).toEqual(row.name === 'none' || row.name === 'innovative' ? [] : row.name === 'platform' ? [expect.objectContaining({ eventType: 'maintain', year: 2018 })] : [expect.objectContaining({ eventType: 'award', year: 2018 })])
    expect(giant.evidence).toEqual([expect.objectContaining({ eventType: 'award', year: 2025 })])
    expect(lower.effectiveQualification.status).toBe('effective')
    expect(lower.references).toEqual(expect.arrayContaining(giant.references.map((reference: string) => '小巨人依据：' + reference)))
  }
  expect(await query(200)).toEqual(large)
  expect(await f.runtimeBusinessRows(businessTables)).toEqual(digest)
}, 90000)

it('specialized-only qualification enters innovative HTTP filters and XLSX with its actual period and no invented history', async () => {
 if (!f.postgresUrl) throw new Error('PostgreSQL fixture is not running')
 const connection = new pg.Client({ connectionString: f.postgresUrl })
 await connection.connect()
 let enterpriseId: string
 try {
  const created = await connection.query<{ id: string }>(`
    INSERT INTO business.enterprise (name,name_norm,uscc_norm,district,city)
    VALUES ('specialized-only','specialized-only','SYNTHETIC-118-specialized-only','鄞州区','宁波市')
    RETURNING id`)
  enterpriseId = created.rows[0]!.id
  const record = await connection.query<{ id: string }>(`
    INSERT INTO business.record (enterprise_id,source,title_code,name_raw)
    VALUES ($1,'jxj','specialized_sme','specialized-only') RETURNING id`, [enterpriseId])
  const event = await connection.query<{ id: string }>(`
    INSERT INTO business.record_event (record_id,event_type,year,batch_seq)
    VALUES ($1,'award',2025,1) RETURNING id`, [record.rows[0]!.id])
  await connection.query(`
    INSERT INTO business.record_evidence (record_event_id,source_file,attachment,list_no)
    VALUES ($1,'jxj/announcement/synthetic-118.xlsx','专精特新中小企业名单',$2)`, [event.rows[0]!.id, enterpriseId])
 } finally { await connection.end() }
 const before = await f.runtimeBusinessRows(businessTables)
 const list=await fetch(f.url('/api/roster/current-enterprises?titleCode=innovative_sme&q=specialized-only&district=鄞州区')).then(r=>r.json())
 expect(list.total).toBe(1)
 expect(list.rows.map((r:any)=>r.uscc)).toEqual(['SYNTHETIC-118-specialized-only'])
 const detail=await fetch(f.url(`/api/roster/enterprises/${enterpriseId}`)).then(r=>r.json())
 const lower=detail.qualificationAssessment.titles.find((t:any)=>t.titleCode==='innovative_sme')
 expect(lower.evidence).toEqual([]);expect(lower.cycles).toEqual([])
 expect(lower.effectiveQualification.localRuleBasis.join(' ')).toContain('实际支撑称号：专精特新中小企业')
 expect(lower.effectiveQualification.presentationBasis.join(' ')).toContain('2028')
 const submitted=await fetch(f.url('/api/roster/exports/current/innovative-sme'),{method:'POST',headers:f.headers,body:JSON.stringify({clientRequestId:'specialized-only'})})
 expect(submitted.status).toBe(202)
 const job=await f.terminal((await submitted.json()).jobId);expect(job.state,JSON.stringify(job)).toBe('done')
 const {wb}=await f.download(job), sheet=wb.getWorksheet('有效企业')!
 expect(Array.from({length:sheet.rowCount-1},(_,i)=>sheet.getRow(i+2).getCell(3).value)).toEqual(['SYNTHETIC-118-none','SYNTHETIC-118-specialized','SYNTHETIC-118-innovative','SYNTHETIC-118-both','SYNTHETIC-118-platform','SYNTHETIC-118-specialized-only'])
 expect(JSON.stringify(sheet.getRow(7).values)).toContain('2028')
 expect(JSON.stringify(sheet.getRow(7).values)).toContain('专精特新中小企业')
 expect(await f.runtimeBusinessRows(businessTables)).toEqual(before)
},90000)
