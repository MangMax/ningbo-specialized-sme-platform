import { afterAll, beforeAll, expect, it } from 'vitest'
import { schema } from '../db/client'
import { currentExport409Fixture } from './helpers/current-export-409'
const f = currentExport409Fixture()
beforeAll(async () => {
  const { enterprise, record } = f.candidate('official478')
  f.db.$client.prepare('update record set name_raw=? where id=?').run('未确认曾用名', record.id)
  f.decision(enterprise.id, 'moved_out')
  for (const kind of ['cancelled','moved_out']) for (const complete of [true,false]) {
    const c=f.candidate(`boundary478-${kind}-${complete}`)
    f.db.insert(schema.enterpriseFactRevision).values({enterpriseId:c.enterprise.id,factId:1,revision:1,status:'confirmed',fact:{kind,source:{reference:complete ? 'official' : '',statement:'statement'},effective:{precision:'day',value:'2025-01-01'},observed:{precision:'day',value:'2025-01-01'},city:null},action:'assert',actor:{type:'agent',id:'478'},basis:'verified',createdAt:'2025-01-01T00:00:00Z'}).run()
  }
  for (const [name, year, end] of [['short478',2025,'2025-12-31'],['long478',2021,'2027-12-31'],['short-drift478',2025,'2025-12-31'],['long-drift478',2021,'2027-12-31'],['short-link478',2025,'2025-12-31'],['long-link478',2021,'2027-12-31']] as const) {
    const c=f.candidate(name,[{eventType:'award',year,batchSeq:1}])
    const event=f.db.$client.prepare('select id from record_event where record_id=?').get(c.record.id) as {id:number}
    const evidence=f.db.$client.prepare('select id from record_evidence where record_event_id=?').get(event.id) as {id:number}
    if(name.includes('drift')) {
      f.db.$client.prepare('update record_evidence set source_file=? where id=?').run(name+'.xlsx',evidence.id)
      f.db.insert(schema.storedFile).values({relPath:name+'.xlsx',filename:name+'.xlsx',ext:'xlsx',bytes:1,sha256:'b'.repeat(64)}).run()
    }
    f.db.$client.prepare('update record_event set formal_validity=? where id=?').run(JSON.stringify({evidenceId:evidence.id,sourceSha256:'a'.repeat(64),statementPages:[1],...(name.includes('link') ? {originAwardEventId:999999} : {}),interval:{validFrom:`${year}-01-01`,validThrough:end}}),event.id)
  }
  f.candidate('ambiguous478',[{eventType:'award',year:2025,batchSeq:1},{eventType:'review',year:2025,decidedYear:2026,batchSeq:null,reviewOutcome:'passed'}])
  f.candidate('review-only478',[{eventType:'review',year:null,decidedYear:2026,batchSeq:null,reviewOutcome:'passed'}])
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

it.each([['short478',0],['long478',1],['short-drift478',0],['long-drift478',1],['ambiguous478',1],['short-link478',0],['long-link478',1],['review-only478',1]])('HTTP and MCP retain official period despite gaps: %s',async (q,total) => {
 const http=await fetch(f.url(`/api/roster/current-enterprises?titleCode=specialized_sme&q=${q}`)).then(r=>r.json())
 const response=await fetch(f.url('/mcp'),{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream','mcp-protocol-version':'2025-06-18'},body:JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'list_current_qualified_enterprises',arguments:{titleCode:'specialized_sme',q}}})})
 const raw=await response.text()
 const wire=JSON.parse(raw.startsWith('event:') ? raw.split('\n').find(line=>line.startsWith('data: '))!.slice(6) : raw)
 const mcp=JSON.parse(wire.result.content[0].text)
 expect(http.total).toBe(total)
 expect(mcp.total).toBe(total)
 if(total) expect(mcp.rows[0].qualificationAssessment.titles.map((t:any)=>t.effectiveQualification)).toEqual(http.rows[0].qualificationAssessment.titles.map((t:any)=>t.effectiveQualification))
},60000)
