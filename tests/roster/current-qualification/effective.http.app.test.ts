import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, expect, it } from 'vitest'
import * as schema from '../fixtures/postgres-tables'
import { qualificationExportFixture } from '../current-export/fixtures/qualification-export'
const f = qualificationExportFixture()
beforeAll(async () => {
  const { enterprise, record } = await f.candidate('official478')
  await f.db.update(schema.record).set({ nameRaw: '未确认曾用名' }).where(eq(schema.record.id, record.id))
  await f.decision(enterprise.id, 'moved_out')
  for (const kind of ['cancelled','moved_out'] as const) for (const complete of [true,false]) {
    const c=await f.candidate(`boundary478-${kind}-${complete}`)
    await f.db.insert(schema.enterpriseFactRevision).values({enterpriseId:c.enterprise.id,factId:1,revision:1,status:'confirmed',fact:JSON.stringify({kind,source:{reference:complete ? 'official' : '',statement:'statement'},effective:{precision:'day',value:'2025-01-01'},observed:{precision:'day',value:'2025-01-01'},city:null}),action:'assert',actor:JSON.stringify({type:'agent',id:'478'}),basis:'verified',createdAt:'2025-01-01T00:00:00Z'})
  }
  for (const [name, year, end] of [['short478',2025,'2025-12-31'],['long478',2021,'2027-12-31'],['null-year478',null,'2028-12-31'],['short-drift478',2025,'2025-12-31'],['long-drift478',2021,'2027-12-31'],['short-link478',2025,'2025-12-31'],['long-link478',2021,'2027-12-31']] as const) {
    const c=await f.candidate(name,[{eventType:'award',year,batchSeq:1}])
    const event=(await f.db.select({ id: schema.recordEvent.id }).from(schema.recordEvent).where(eq(schema.recordEvent.recordId, c.record.id)))[0]!
    const evidence=(await f.db.select({ id: schema.recordEvidence.id }).from(schema.recordEvidence).where(eq(schema.recordEvidence.recordEventId, event.id)))[0]!
    if(name.includes('drift')) {
      await f.db.update(schema.recordEvidence).set({ sourceFile: name + '.xlsx' }).where(eq(schema.recordEvidence.id, evidence.id))
      await f.db.insert(schema.storedFile).values({createdAt:'2026-01-01T00:00:00Z',relPath:name+'.xlsx',filename:name+'.xlsx',ext:'xlsx',bytes: 1n,sha256:'b'.repeat(64)})
    }
    await f.db.update(schema.recordEvent).set({ formalValidity: JSON.stringify({evidenceId:evidence.id,sourceSha256:'a'.repeat(64),statementPages:[1],...(name.includes('link') ? {originAwardEventId:999999} : {}),interval:{validFrom:`${year ?? 2025}-01-01`,validThrough:end}}) }).where(eq(schema.recordEvent.id, event.id))
  }
  await f.candidate('ambiguous478',[{eventType:'award',year:2025,batchSeq:1},{eventType:'review',year:2025,decidedYear:2026,batchSeq:null,reviewOutcome:'passed'}])
  await f.candidate('review-only478',[{eventType:'review',year:null,decidedYear:2026,batchSeq:null,reviewOutcome:'passed'}])
  await f.start()
}, 60000)
afterAll(() => f.close())
it('HTTP keeps formal eligibility despite identity gaps and confirmed difference decisions', async () => {
  const response = await fetch(f.url('/api/roster/current-enterprises?titleCode=specialized_sme&q=official478'))
  expect(response.status).toBe(200)
  const body = await response.json()
  expect(body.total).toBe(1)
  expect(body.rows[0].qualificationAssessment.titles.find((t: any) => t.titleCode === 'specialized_sme')).toMatchObject({ group: 'eligible', effectiveQualification: { status: 'effective' } })
  expect(body.rows[0].notes.length).toBeGreaterThan(0)
}, 60000)
it('MCP returns the same effective status and notes as HTTP', async () => {
  const response = await fetch(f.url('/mcp'), { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_current_qualified_enterprises', arguments: { titleCode: 'specialized_sme', q: 'official478' } } }) })
  expect(response.status).toBe(200)
  const raw = await response.text()
  const wire = JSON.parse(raw.startsWith('event:') ? raw.split('\n').find(line => line.startsWith('data: '))!.slice(6) : raw)
  expect(wire.error).toBeUndefined()
  expect(wire.result.isError).not.toBe(true)
  const body = JSON.parse(wire.result.content[0].text)
  const http=await fetch(f.url('/api/roster/current-enterprises?titleCode=specialized_sme&q=official478')).then(r=>r.json())
  expect(body.total).toBe(1)
  expect(body.rows[0].qualificationAssessment.titles.map((t:any)=>t.effectiveQualification)).toEqual(http.rows[0].qualificationAssessment.titles.map((t:any)=>t.effectiveQualification))
}, 60000)

it.each(['cancelled','moved_out'])('HTTP excludes complete %s but retains incomplete evidence', async kind => {
 for (const complete of [true,false]) {
  const response=await fetch(f.url(`/api/roster/current-enterprises?titleCode=specialized_sme&q=boundary478-${kind}-${complete}`))
  expect(response.status).toBe(200)
  const body=await response.json()
  expect(body.total).toBe(complete ? 0 : 1)
 }
},60000)

it.each([['short478',0],['long478',1],['short-drift478',0],['long-drift478',1],['ambiguous478',1],['short-link478',0],['long-link478',1],['review-only478',1],['null-year478',1]])('HTTP and MCP retain official period despite gaps: %s',async (q,total) => {
 const http=await fetch(f.url(`/api/roster/current-enterprises?titleCode=specialized_sme&q=${q}`)).then(r=>r.json())
 const response=await fetch(f.url('/mcp'),{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream','mcp-protocol-version':'2025-06-18'},body:JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'list_current_qualified_enterprises',arguments:{titleCode:'specialized_sme',q}}})})
 const raw=await response.text()
 const wire=JSON.parse(raw.startsWith('event:') ? raw.split('\n').find(line=>line.startsWith('data: '))!.slice(6) : raw)
 const mcp=JSON.parse(wire.result.content[0].text)
 expect(http.total).toBe(total)
 expect(mcp.total).toBe(total)
 if(total) expect(mcp.rows[0].qualificationAssessment.titles.map((t:any)=>t.effectiveQualification)).toEqual(http.rows[0].qualificationAssessment.titles.map((t:any)=>t.effectiveQualification))
},60000)

it('download retains null-year explicit-period enterprise as a literal eligible row',async()=>{
 const {wb}=await f.workbook('null-year-final-review')
 const sheet=wb.getWorksheet('有效企业')!
 const names=Array.from({length:sheet.rowCount-1},(_,i)=>sheet.getRow(i+2).getCell(2).value)
 expect(names.filter(n=>n==='null-year478')).toEqual(['null-year478'])
},60000)
