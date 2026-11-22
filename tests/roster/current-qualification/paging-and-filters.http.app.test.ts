import { afterAll, beforeAll, expect, it } from 'vitest'
import { assertQualificationRowsSnapshotEqual } from '../assertions/current-qualified-rows'


import { readDevelopmentDiscovery, specializedExportFixture } from '../current-export/fixtures/specialized-export'

let developmentSpec: any
beforeAll(async () => { developmentSpec = await readDevelopmentDiscovery() }, 60000)
const f = specializedExportFixture()
beforeAll(async () => { await f.candidate('甲企业'); await f.candidate('乙企业'); await f.start() }, 90000)
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
  const spec = developmentSpec as any
  const route = spec.paths['/api/roster/current-enterprises'].get
  expect(route.parameters.find((item: any) => item.name === 'titleCode')).toMatchObject({ required: true })
  expect(route.responses['503']).toBeDefined()
  const response = await fetch(f.url('/mcp'), { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' }, body: JSON.stringify({ jsonrpc: '2.0', id: 154, method: 'tools/list', params: {} }) })
  expect(response.status).toBe(200)
  const raw = await response.text()
  const payload = JSON.parse(raw.startsWith('event:') ? raw.split('\n').find(line => line.startsWith('data: '))!.slice(6) : raw)
  expect(payload.result.tools.find((tool: any) => tool.name === 'list_current_qualified_enterprises')).toMatchObject({ annotations: { readOnlyHint: true } })
})





it('rejects invalid public query instead of returning an invented empty result', async () => {
  expect((await query({ titleCode: 'not_a_title' })).response.status).toBe(400)
  expect((await query({ titleCode: 'specialized_sme', pageSize: '201' })).response.status).toBe(400)
  expect((await query({ titleCode: 'specialized_sme', firstYear: '2024' })).response.status).toBe(400)
})



it.each([
  { name: 'unsupported-filter', extra: { firstYear: '2024' } },
  { name: 'unknown-option', extra: { unsupported154: true } },
])('rejects $name at the real MCP transport before SDK stripping', async ({ extra }) => {
  const response = await fetch(f.url('/mcp'), { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'strict-154', method: 'tools/call', params: { name: 'list_current_qualified_enterprises', arguments: { titleCode: 'specialized_sme', ...extra } } }) })
  const raw = await response.text()
  const payload = JSON.parse(raw.startsWith('event:') ? raw.split('\n').find(line => line.startsWith('data: '))!.slice(6) : raw)
  expect(payload).toMatchObject({ id: 'strict-154', error: { code: -32602 } })
  expect(payload.result).toBeUndefined()
  expect(response.status).toBe(400)
  expect(response.headers.get('cache-control')).toContain('no-store')
})

it('returns a real second HTTP page and the same MCP qualification snapshot', async () => {
  const first = await query({ titleCode: 'specialized_sme', page: '1', pageSize: '1' })
  expect(first.response.status).toBe(200)
  expect(first.response.headers.get('cache-control')).toContain('no-store')
  expect(first.body).toMatchObject({ total: 2, page: 1, pageSize: 1, rows: [{ name: '甲企业', group: 'eligible' }] })
  const second = await query({ titleCode: 'specialized_sme', page: '2', pageSize: '1' })
  expect(second.body).toMatchObject({ total: 2, page: 2, rows: [{ name: '乙企业', group: 'eligible' }] })
  assertQualificationRowsSnapshotEqual((await mcp({ titleCode: 'specialized_sme', page: 2, pageSize: 1 })).rows, second.body.rows)
})
