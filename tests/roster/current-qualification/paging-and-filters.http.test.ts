import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest'
import { assertCurrentQualifiedRowsSnapshotEqual408 } from '../../helpers/current-qualified-408'
import { eq } from 'drizzle-orm'
import { schema as s } from '../../../db/client'
import { currentExport118Fixture, year } from '../../helpers/current-export-118'

const f = currentExport118Fixture()
beforeAll(f.start, 90000)
beforeEach(f.resetBusiness, 90000)
afterAll(f.close)

async function query(params: Record<string, string>) {
  const response = await fetch(f.url('/api/roster/current-enterprises?' + new URLSearchParams(params)))
  return { response, body: await response.json() as any }
}
async function mcp(args: Record<string, unknown>) {
  const response = await fetch(f.url('/mcp'), { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' }, body: JSON.stringify({ jsonrpc: '2.0', id: 154, method: 'tools/call', params: { name: 'list_current_qualified_enterprises', arguments: args } }) })
  expect(response.status).toBe(200)
  const raw = await response.text()
  const payload = JSON.parse(raw.startsWith('event:') ? raw.split('\n').find(line => line.startsWith('data: '))!.slice(6) : raw)
  return JSON.parse(payload.result.content[0].text)
}

it('publishes the read-only HTTP and MCP contracts', async () => {
  const spec = await (await fetch(f.url('/_openapi.json'))).json() as any
  const route = spec.paths['/api/roster/current-enterprises'].get
  expect(route.parameters.find((item: any) => item.name === 'titleCode')).toMatchObject({ required: true })
  expect(route.responses['503']).toBeDefined()
  const response = await fetch(f.url('/mcp'), { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' }, body: JSON.stringify({ jsonrpc: '2.0', id: 154, method: 'tools/list', params: {} }) })
  expect(response.status).toBe(200)
  const raw = await response.text()
  const payload = JSON.parse(raw.startsWith('event:') ? raw.split('\n').find(line => line.startsWith('data: '))!.slice(6) : raw)
  expect(payload.result.tools.find((tool: any) => tool.name === 'list_current_qualified_enterprises')).toMatchObject({ annotations: { readOnlyHint: true } })
})

it('pages each title by complete eligible count without borrowing another title', async () => {
  const a = f.candidate('甲企业')
  const b = f.candidate('乙企业')
  const c = f.candidate('丙企业', undefined, 'little_giant')
  f.addRecord(a.enterprise.id, '甲企业', undefined, 'little_giant')
  f.candidate('失败企业', [{ eventType: 'award', year: year - 4, batchSeq: 1 }, { eventType: 'review', year: year - 4, batchSeq: 1, decidedYear: year - 1, reviewOutcome: 'failed' }])
  const first = await query({ titleCode: 'specialized_sme', page: '1', pageSize: '1' })
  expect(first.response.status).toBe(200)
  expect(first.response.headers.get('cache-control')).toContain('no-store')
  expect(first.body).toMatchObject({ total: 2, page: 1, pageSize: 1, rows: [{ enterpriseId: a.enterprise.id, name: '甲企业', group: 'eligible' }] })
  const deep = await query({ titleCode: 'specialized_sme', page: '2', pageSize: '1' })
  expect(deep.body.rows.map((row: any) => row.enterpriseId)).toEqual([b.enterprise.id])
  const little = await query({ titleCode: 'little_giant' })
  expect(little.body.rows.map((row: any) => row.enterpriseId)).toEqual([a.enterprise.id, c.enterprise.id])
  expect((await query({ titleCode: 'innovative_sme' })).body).toMatchObject({ total: 0, rows: [] })
})

it('filters confirmed alias, USCC and district together and preserves qualification evidence', async () => {
  const a = f.candidate('新现名')
  f.db.insert(s.enterpriseAlias).values({ enterpriseId: a.enterprise.id, name: '旧公布名', nameNorm: '旧公布名', sourceKind: 'manual', verificationStatus: 'confirmed' }).run()
  f.db.update(s.record).set({ nameRaw: '旧公布名' }).where(eq(s.record.enterpriseId, a.enterprise.id)).run()
  const b = f.candidate('其他企业')
  f.db.insert(s.enterpriseAlias).values({ enterpriseId: b.enterprise.id, name: '旧公布名', nameNorm: '旧公布名', sourceKind: 'manual', verificationStatus: 'pending' }).run()
  const result = await query({ titleCode: 'specialized_sme', q: '旧公布名', district: '鄞州区' })
  expect(result.body.total).toBe(1)
  expect(result.body.rows[0]).toMatchObject({ enterpriseId: a.enterprise.id, aliases: ['旧公布名'], publishedNames: ['旧公布名'], firstYear: year, publication: '已见本称号宁波公布记录' })
  expect(result.body.rows[0].references.join(' ')).toContain('evidence:')
  expect((await query({ titleCode: 'specialized_sme', q: a.enterprise.usccNorm!, district: '海曙区' })).body.total).toBe(0)
  assertCurrentQualifiedRowsSnapshotEqual408((await mcp({ titleCode: 'specialized_sme', q: '旧公布名', district: '鄞州区' })).rows, result.body.rows)
})

it('rejects invalid public query instead of returning an invented empty result', async () => {
  expect((await query({ titleCode: 'not_a_title' })).response.status).toBe(400)
  expect((await query({ titleCode: 'specialized_sme', pageSize: '201' })).response.status).toBe(400)
  expect((await query({ titleCode: 'specialized_sme', firstYear: '2024' })).response.status).toBe(400)
})

it('sorts names with stable enterprise ID ties before deep pagination and never exposes raw platform fields', async () => {
  const z = f.candidate('Zeta企业')
  const b = f.candidate('Alpha企业')
  const a = f.candidate('Alpha企业副本')
  f.db.update(s.enterprise).set({ name: 'Alpha企业', nameNorm: 'Alpha企业' }).where(eq(s.enterprise.id, a.enterprise.id)).run()
  f.db.update(s.record).set({ nameRaw: 'Alpha企业' }).where(eq(s.record.enterpriseId, a.enterprise.id)).run()
  const result = await query({ titleCode: 'specialized_sme', sort: 'name_asc', page: '2', pageSize: '1' })
  expect(result.body.total).toBe(3)
  expect(result.body.rows.map((row: any) => row.enterpriseId)).toEqual([a.enterprise.id])
  expect((await query({ titleCode: 'specialized_sme', sort: 'name_desc' })).body.rows.map((row: any) => row.enterpriseId)).toEqual([z.enterprise.id, b.enterprise.id, a.enterprise.id])
  expect(JSON.stringify(result.body)).not.toContain('rawFields')
})

it.each([
  { name: 'unsupported-filter', extra: { firstYear: '2024' } },
  { name: 'unknown-option', extra: { unsupported154: true } },
])('rejects $name at the real MCP transport before SDK stripping', async ({ extra }) => {
  f.candidate('未筛选企业')
  const response = await fetch(f.url('/mcp'), { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'strict-154', method: 'tools/call', params: { name: 'list_current_qualified_enterprises', arguments: { titleCode: 'specialized_sme', ...extra } } }) })
  const raw = await response.text()
  const payload = JSON.parse(raw.startsWith('event:') ? raw.split('\n').find(line => line.startsWith('data: '))!.slice(6) : raw)
  expect(payload).toMatchObject({ id: 'strict-154', error: { code: -32602 } })
  expect(payload.result).toBeUndefined()
  expect(response.status).toBe(400)
  expect(response.headers.get('cache-control')).toContain('no-store')
})
