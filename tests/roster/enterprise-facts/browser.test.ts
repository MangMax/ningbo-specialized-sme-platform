import { initializeDb } from '../../../db/client'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp, createRouter, defineEventHandler, toNodeListener } from 'h3'
import { schema, useDb } from '../../../db'
const dir = mkdtempSync(join(tmpdir(), 'facts-browser-307-'))
const db = initializeDb({ create: true, dbPath: join(dir, 'test.db') })
let server: Server, base: string
beforeAll(async () => {
  vi.stubGlobal('defineEventHandler', defineEventHandler)
  vi.stubGlobal('useRuntimeConfig', () => ({ apiToken: 'synthetic', }))
  vi.doMock('@db', () => ({ useDb: () => db }))
  const { browserEnterpriseFactsRoute } = await import('../../../layers/sme-roster/server/utils/browser-enterprise-facts')
  const get = (await import('../../../server/api/roster/enterprises/[id]/facts.get')).default
  server = createServer(toNodeListener(createApp().use(createRouter().get('/:id', get).post('/:id/preflight', browserEnterpriseFactsRoute('preflight')).post('/:id/commit', browserEnterpriseFactsRoute('commit')))))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})
afterAll(async () => {
  if (server) await new Promise<void>(resolve => server.close(() => resolve()))
  db.$client.close(); rmSync(dir, { recursive: true, force: true }); vi.unstubAllGlobals(); vi.doUnmock('@db')
})
async function http(id: number, action = '', body?: unknown, origin?: string) {
  const response = await fetch(`${base}/${id}${action}`, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', origin: origin ?? base }, ...(body ? { body: JSON.stringify(body) } : {}) })
  return { status: response.status, body: await response.json() }
}
it('browser lifecycle records actual adapter with preflight replay and rejects cross-origin disabled and forged actor commands', async () => {
  const id = db.insert(schema.enterprise).values({ name: '合成307', nameNorm: '合成307' }).returning().get().id
  const initial = (await http(id)).body
  const fact = { kind: 'moved_in', source: { reference: '合成来源', statement: '迁入宁波，来源地未知' }, city: null, observed: { precision: 'month', value: '2026-10' }, effective: { precision: 'unknown', value: null } }
  let sequence = 0
  async function commit(action: string, extra: object) {
    const request = { action, ...extra, basis: '核对原文', expectedVersion: (await http(id)).body.version, idempotencyKey: `browser-${++sequence}` }
    const plan = await http(id, '/preflight', request)
    expect(plan.status).toBe(200)
    const body = { request, planHash: plan.body.planHash }
    const result = await http(id, '/commit', body)
    expect(result.status).toBe(200)
    expect(await http(id, '/commit', body)).toEqual(result)
    return result.body
  }
  const input = { action: 'assert', fact, basis: '依据', expectedVersion: initial.version, idempotencyKey: 'gate' }
  expect((await http(id, '/preflight', input, 'https://other.example')).status).toBe(403)
  expect((await http(id, '/preflight', { ...input, actor: { type: 'user', id: 'forged' } })).status).toBe(400)
  expect((await http(id)).body).toEqual(initial)
  const first = await commit('assert', { fact })
  await commit('confirm', { factId: first.factId })
  const corrected = await commit('replace', { factId: first.factId, fact: { ...fact, kind: 'moved_out' } })
  await commit('withdraw', { factId: corrected.factId })
  const read = (await http(id)).body
  expect(read.facts.map((r: any) => r.status)).toEqual(['replaced', 'withdrawn'])
  expect(read.history.map((r: any) => r.action)).toEqual(['assert', 'confirm', 'replace', 'replace', 'withdraw'])
  expect(read.history[0]).toMatchObject({ fact, actor: { type: 'agent', id: 'same-origin-enterprise-facts-adapter' }, basis: '核对原文' })
})
