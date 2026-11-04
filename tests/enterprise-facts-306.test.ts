import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp, createRouter, defineEventHandler, toNodeListener } from 'h3'
import { schema, useDb } from '../db'
const dir = mkdtempSync(join(tmpdir(), 'facts-306-'))
const db = useDb({ dbPath: join(dir, 'test.db') })
let server: Server, base: string, seq = 0
let mcp: Record<string, any>
beforeAll(async () => {
  vi.stubGlobal('defineEventHandler', defineEventHandler)
  vi.stubGlobal('useRuntimeConfig', () => ({ apiToken: 'facts-token' }))
  vi.doMock('@db', () => ({ useDb: () => db }))
  vi.doMock('@nuxtjs/mcp-toolkit/server', () => ({ defineMcpTool: (tool: unknown) => tool }))
  mcp = {}
  for (const name of ['get_enterprise_facts', 'preflight_enterprise_fact', 'commit_enterprise_fact']) mcp[name] = (await import(`../server/mcp/tools/${name}.ts`)).default
  const get = (await import('../server/api/roster/enterprises/[id]/facts.get')).default
  const preflight = (await import('../server/api/roster/enterprises/[id]/facts/preflight.post')).default
  const commit = (await import('../server/api/roster/enterprises/[id]/facts/commit.post')).default
  server = createServer(toNodeListener(createApp().use(createRouter().get('/:id', get).post('/:id/preflight', preflight).post('/:id/commit', commit))))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})
afterAll(async () => {
  if (server) await new Promise<void>(resolve => server.close(() => resolve()))
  db.$client.close(); rmSync(dir, { recursive: true, force: true }); vi.unstubAllGlobals(); vi.doUnmock('@db'); vi.doUnmock('@nuxtjs/mcp-toolkit/server')
})
async function http(id: number, action = '', body?: unknown, auth = true) {
  const response = await fetch(`${base}/${id}${action}`, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', ...(auth ? { authorization: 'Bearer facts-token' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
  return { status: response.status, body: await response.json() }
}
function seed() {
 const id = db.insert(schema.enterprise).values({ name: `事实合成${++seq}`, nameNorm: `事实合成${seq}` }).returning().get().id
 db.insert(schema.differenceReason).values({ enterpriseId: id, titleCode: 'specialized_sme', direction: 'extra_in_miit', status: 'confirmed_reason', reasonCode: 'moved_in', movedInYear: 2020, verificationStatus: 'confirmed', recordedAt: '2026-01-01' }).run()
 return id
}
const fact = { kind: 'moved_out', source: { reference: 'official:notice:17', statement: '迁出，目的地未载明' }, observed: { value: '2026-11-04', precision: 'day' }, effective: { value: '2024', precision: 'year' }, city: null }
async function command(id: number, changes: object) {
  const read = await http(id)
  return { expectedVersion: read.body.version, idempotencyKey: `facts-${++seq}`, actor: { type: 'agent', id: 'test' }, basis: '正式通知核对', ...changes }
}
async function commit(id: number, request: any) {
  const preview = await http(id, '/preflight', request)
  expect(preview.status).toBe(200)
  return http(id, '/commit', { request, planHash: preview.body.planHash })
}
it('HTTP and MCP preserve sourced facts through confirmation replacement withdrawal and replay', async () => {
  const id = seed()
  expect((await http(id)).body.facts).toEqual([]) // legacy moved_in is not promoted
  const input = await command(id, { action: 'assert', fact })
  const first = await commit(id, input)
  expect(first.status).toBe(200)
  const factId = first.body.factId
  expect((await http(id)).body.facts).toMatchObject([{ factId, status: 'pending', fact }])
  const confirm = await command(id, { action: 'confirm', factId })
  const plan = await mcp.preflight_enterprise_fact.handler({ enterpriseId: id, request: confirm })
  await mcp.commit_enterprise_fact.handler({ enterpriseId: id, request: { request: confirm, planHash: plan.planHash } })
  const replace = await command(id, { action: 'replace', factId, fact: { ...fact, kind: 'cancelled' } })
  await commit(id, replace)
  let read = await mcp.get_enterprise_facts.handler({ enterpriseId: id })
  expect(read.facts).toMatchObject([{ status: 'replaced' }, { status: 'pending', fact: { kind: 'cancelled' } }])
  const replacement = read.facts[1].factId
  await commit(id, await command(id, { action: 'withdraw', factId: replacement }))
  expect((await http(id)).body.facts).toMatchObject([{ status: 'replaced' }, { status: 'withdrawn' }])
  const replayPlan = await http(id, '/preflight', input)
  expect(await http(id, '/commit', { request: input, planHash: replayPlan.body.planHash })).toEqual(first)
  read = (await http(id)).body
  expect(read.history.map((r: any) => r.action)).toEqual(['assert', 'confirm', 'replace', 'replace', 'withdraw'])
  expect(read.history[0]).toMatchObject({ actor: input.actor, basis: input.basis })
})
it('preflight binding CAS auth and illegal transitions leave the same readback', async () => {
  const id = seed(), input = await command(id, { action: 'assert', fact })
  const before = (await http(id)).body
  const plan = (await http(id, '/preflight', input)).body
  expect((await http(id, '/commit', { request: input, planHash: plan.planHash }, false)).status).toBe(401)
  expect((await http(id, '/commit', { request: { ...input, basis: 'changed' }, planHash: plan.planHash })).status).toBe(409)
  expect((await http(id)).body).toEqual(before)
  await commit(id, input)
  expect((await http(id, '/preflight', { ...input, idempotencyKey: 'stale' })).status).toBe(409)
  const current = (await http(id)).body
  expect((await http(id, '/preflight', await command(id, { action: 'withdraw', factId: 999999 }))).status).toBe(409)
  expect((await http(id)).body).toEqual(current)
})
it('same-input shadow retains legacy IDs heads aliases and moved-in columns; failed audit append rolls back', async () => {
  const id = seed()
  db.insert(schema.enterpriseAlias).values({ enterpriseId: id, name: '历史名称', nameNorm: '历史名称', sourceKind: 'manual', verificationStatus: 'confirmed' }).run()
  const legacy = () => ({
    heads: db.select().from(schema.differenceReason).all(),
    aliases: db.select().from(schema.enterpriseAlias).all(),
    enterprise: db.select().from(schema.enterprise).all(),
  })
  const before = legacy(), input = await command(id, { action: 'assert', fact: { ...fact, kind: 'moved_in', effective: { precision: 'unknown', value: null } } })
  await commit(id, input)
  expect(legacy()).toEqual(before)
  const current = (await http(id)).body
  expect(current.facts[0].fact).toMatchObject({ kind: 'moved_in', city: null, effective: { precision: 'unknown', value: null } })
  const request = await command(id, { action: 'replace', factId: current.facts[0].factId, fact })
  const plan = (await http(id, '/preflight', request)).body
  // Simulate storage failure after revisions, before receipt: entire command must roll back.
  db.$client.exec("CREATE TRIGGER reject_fact_receipt BEFORE INSERT ON enterprise_fact_receipt BEGIN SELECT RAISE(ABORT, 'synthetic receipt failure'); END")
  try { expect((await http(id, '/commit', { request, planHash: plan.planHash })).status).toBe(500) }
  finally { db.$client.exec('DROP TRIGGER reject_fact_receipt') }
  expect((await http(id)).body).toEqual(current)
  expect(legacy()).toEqual(before)
  expect((await http(id, '/commit', { request, planHash: plan.planHash })).status).toBe(200)
})
