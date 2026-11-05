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
  expect(body.total).toBe(1)
  expect(body.rows[0].qualificationAssessment.titles.find((t: any) => t.titleCode === 'specialized_sme').effectiveQualification.status).toBe('effective')
}, 60000)

it.each(['cancelled','moved_out'])('HTTP excludes complete %s but retains incomplete evidence', async kind => {
 for (const complete of [true,false]) {
  const response=await fetch(f.url(`/api/roster/current-enterprises?titleCode=specialized_sme&q=boundary478-${kind}-${complete}`))
  expect(response.status).toBe(200)
  const body=await response.json()
  expect(body.total).toBe(complete ? 0 : 1)
 }
},60000)
