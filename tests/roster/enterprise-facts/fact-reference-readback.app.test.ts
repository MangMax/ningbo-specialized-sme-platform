import '../../support/compiled-enterprise-reader'
import { enterpriseReads } from '../../../layers/sme-roster/server/utils/enterprise-read'
import { initializeDb } from '../../../db/client'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as h3 from 'h3'
import { createApp, createRouter, toNodeListener } from 'h3'
import { schema as s, useDb } from '../../../db'

const dir = mkdtempSync(join(tmpdir(), 'fact-reference-readback-307-'))
const db = initializeDb({ create: true, dbPath: join(dir, 'isolated.db') })
let server: Server, base: string, sequence = 0
let listDifferences: { handler: (input: object) => Promise<any> }
beforeAll(async () => {
  for (const [key, value] of Object.entries(h3)) vi.stubGlobal(key, value)
  vi.stubGlobal('useRuntimeConfig', () => ({ apiToken: 'reference-test-token' }))
  vi.doMock('@db', () => ({ useDb: () => db }))
  vi.doMock('@nuxtjs/mcp-toolkit/server', () => ({ defineMcpTool: (tool: unknown) => tool }))
  listDifferences = (await import('../../../server/mcp/tools/list_differences')).default as any
  const router = createRouter()
    .get('/differences', (await import('../../../server/api/roster/differences.get')).default)
    .get('/enterprises/:id', (await import('../../../server/api/roster/enterprises/[id].get')).default)
    .get('/enterprises/:id/facts', (await import('../../../server/api/roster/enterprises/[id]/facts.get')).default)
    .post('/enterprises/:id/facts/preflight', (await import('../../../server/api/roster/enterprises/[id]/facts/preflight.post')).default)
    .post('/enterprises/:id/facts/commit', (await import('../../../server/api/roster/enterprises/[id]/facts/commit.post')).default)
    .post('/decisions', (await import('../../../server/api/roster/decision-lifecycle/commands.post')).default)
    .get('/decisions/history', (await import('../../../server/api/roster/decision-lifecycle/history.get')).default)
    .get('/decisions/:id', (await import('../../../server/api/roster/decision-lifecycle/[id].get')).default)
  server = createServer(toNodeListener(createApp().use(router)))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})
afterAll(async () => {
  if (server) await new Promise<void>(resolve => server.close(() => resolve()))
  await enterpriseReads.close()
  db.$client.close()
  rmSync(dir, { recursive: true, force: true })
  vi.unstubAllGlobals(); vi.doUnmock('@db'); vi.doUnmock('@nuxtjs/mcp-toolkit/server')
})
async function http(path: string, body?: unknown) {
  const response = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', authorization: 'Bearer reference-test-token' }, ...(body ? { body: JSON.stringify(body) } : {}) })
  const result = await response.json()
  expect(response.status, JSON.stringify(result)).toBe(200)
  return result
}
function seed(factReferences: null | [] = null) {
  const name = `合成引用读回${++sequence}`
  const id = db.insert(s.enterprise).values({ name, nameNorm: name }).returning().get().id
  const legacy = db.insert(s.differenceReason).values({ enterpriseId: id, titleCode: 'specialized_sme', direction: 'extra_in_miit', status: 'confirmed_reason', reasonCode: 'moved_in', measureCode: 'record_moved_in', movedInCity: '杭州市', movedInTitleCode: 'specialized_sme', movedInYear: 2020, movedInBatch: 2, verificationStatus: 'confirmed', recordedAt: '2020-01-01', factReferences }).returning().get()
  return { id, legacy }
}
async function factCommand(id: number, action: object) {
  const current = await http(`/enterprises/${id}/facts`)
  const request = { expectedVersion: current.version, idempotencyKey: `reference-fact-${++sequence}`, actor: { type: 'agent', id: 'reference-test' }, basis: '合成独立事实依据', ...action }
  const plan = await http(`/enterprises/${id}/facts/preflight`, request)
  return http(`/enterprises/${id}/facts/commit`, { request, planHash: plan.planHash })
}
const fact = (kind: string) => ({ kind, source: { reference: 'synthetic:official:307', statement: '独立事实原文' }, observed: { precision: 'day', value: '2026-11-04' }, effective: { precision: 'year', value: '2024' }, city: null })
async function confirmedReferences(id: number) {
  const references = []
  for (const kind of ['moved_out', 'registration_status']) {
    const result = await factCommand(id, { action: 'assert', fact: fact(kind) })
    await factCommand(id, { action: 'confirm', factId: result.factId })
    references.push({ enterpriseId: id, factId: result.factId, revision: 2, kind })
  }
  return references
}
async function pin(id: number, factReferences: unknown[]) {
  return http('/decisions', { enterpriseId: id, titleCode: 'specialized_sme', direction: 'missing_in_miit', action: 'replace', expectedCurrentId: null, idempotencyKey: `reference-decision-${++sequence}`, actor: { type: 'agent', id: 'reference-test' }, basis: '合成差异依据', ruleVersion: 'test-307', effectiveAt: '2026-01-01T00:00:00Z', decision: { status: 'confirmed_reason', reasonCode: 'platform_stale', measureCode: 'none', verificationStatus: 'confirmed', factReferences } })
}
async function readSurfaces(id: number) {
  const rest = await http('/differences')
  const detail = await http(`/enterprises/${id}`)
  const mcp = await listDifferences.handler({})
  return { rest, detail, mcp }
}
function referencedRows(result: Awaited<ReturnType<typeof readSurfaces>>, id: number) {
  return [result.rest.rows, result.detail.differences, result.mcp.rows].map(rows => rows.find((row: any) => row.enterpriseId === id && row.direction === 'missing_in_miit'))
}

it('REST detail and MCP expose every explicitly pinned confirmed fact revision without changing causes or counters', async () => {
  const { id, legacy } = seed()
  const refs = await confirmedReferences(id)
  const receipt = await pin(id, refs)
  const result = await readSurfaces(id)
  for (const row of referencedRows(result, id)) {
    expect(row.factReferences).toEqual(refs)
    expect(row).toMatchObject({ reasonCode: 'platform_stale', status: 'confirmed_reason', measureCode: 'none', movedIn: null })
  }
  expect(result.rest.rows.find((r: any) => r.enterpriseId === id && r.direction === 'missing_in_miit').explanationId).toBe(receipt.versionId)
  expect(result.rest.counts.specialized_sme).toEqual({ missing_in_miit: 1, extra_in_miit: 1 })
  expect(result.mcp.counts.specialized_sme).toEqual({ missing_in_miit: 1, extra_in_miit: 1 })
  const old = result.detail.differences.find((r: any) => r.direction === 'extra_in_miit')
  expect(old).toMatchObject({ explanationId: legacy.id, reasonCode: 'moved_in', movedIn: { city: '杭州市', titleCode: 'specialized_sme', year: 2020, batch: 2, complete: true } })
  expect(old).not.toHaveProperty('factReferences')
  expect((await http(`/decisions/${receipt.versionId}`)).factReferences).toEqual(refs)
})

it('null and empty legacy references remain absent on REST detail and MCP without promoting moved-in columns', async () => {
  for (const value of [null, []] as const) {
    const { id, legacy } = seed(value as null | [])
    const result = await readSurfaces(id)
    for (const rows of [result.rest.rows, result.detail.differences, result.mcp.rows]) {
      const row = rows.find((r: any) => r.enterpriseId === id)
      expect(row).not.toHaveProperty('factReferences')
      expect(row).toMatchObject({ reasonCode: 'moved_in', movedIn: { city: '杭州市', titleCode: 'specialized_sme', year: 2020, batch: 2 } })
    }
    expect(result.detail.differences[0].explanationId).toBe(legacy.id)
    expect((await http(`/enterprises/${id}/facts`)).facts).toEqual([])
  }
})

it('fact replacement and withdrawal retain pinned history while recomputing current qualification', async () => {
  const { id } = seed()
  const refs = await confirmedReferences(id)
  const receipt = await pin(id, refs)
  const before = await readSurfaces(id)
  const originalReceipt = await http(`/decisions/${receipt.versionId}`)
  const stored = db.select().from(s.differenceReason).all()
  const replacement = await factCommand(id, { action: 'replace', factId: refs[0]!.factId, fact: fact('cancelled') })
  await factCommand(id, { action: 'withdraw', factId: refs[1]!.factId })
  const after = await readSurfaces(id)
  const missing = '缺少已确认认定及资格依据；平台状态或候选对应不能单独证明资格'
  const current = {
    status: 'unrecognized', basis: `enterprise:${id}/fact:${refs[0]!.factId}/revision:3\nenterprise:${id}/fact:${replacement.factId}/revision:1`,
    localRuleBasis: [], presentationBasis: [], notes: ['排除事实证据或生效时间不完整，仅备注，不改变正式资格', missing],
  }
  const currentRows = (rows: any[]) => rows.map(row => row.enterpriseId === id && row.titleCode === 'specialized_sme' ? { ...row, qualification: current } : row)
  const prior = before.rest.rows.filter((row: any) => row.enterpriseId === id && row.titleCode === 'specialized_sme')
  expect(prior).toHaveLength(2)
  for (const row of prior) expect(row.qualification).toEqual({ status: 'moved_out', basis: `enterprise:${id}/fact:${refs[0]!.factId}/revision:2`, localRuleBasis: [], notes: [missing], presentationBasis: ['迁出；生效：2024；来源：synthetic:official:307；独立事实原文；确认依据：合成独立事实依据'] })
  expect(after.rest).toEqual({ ...before.rest, rows: currentRows(before.rest.rows) })
  expect(after.mcp).toEqual(before.mcp)
  expect(after.detail.differences).toEqual(currentRows(before.detail.differences))
  expect(db.select().from(s.differenceReason).all()).toEqual(stored)
  for (const row of referencedRows(after, id)) expect(row.factReferences).toEqual(refs)
  const history = await http(`/decisions/history?id=${receipt.versionId}`)
  expect(history.rows.map((row: any) => row.id)).toEqual([receipt.versionId])
  expect((await http(`/decisions/${history.rows[0].id}`)).factReferences).toEqual(refs)
  expect(await http(`/decisions/${receipt.versionId}`)).toEqual(originalReceipt)
  const facts = await http(`/enterprises/${id}/facts`)
  expect(facts.facts.map((row: any) => [row.factId, row.revision, row.status])).toEqual([[refs[0]!.factId, 3, 'replaced'], [refs[1]!.factId, 3, 'withdrawn'], [3, 1, 'pending']])
  for (const ref of refs) expect(facts.history.find((row: any) => row.factId === ref.factId && row.revision === ref.revision)).toMatchObject({ enterpriseId: id, status: 'confirmed', fact: { kind: ref.kind } })
})

// Native reader readiness is setup; each business case retains its default budget.
beforeAll(async () => { await enterpriseReads.start() }, 30000)
