import { createReviewedFixtureImportClient } from '../../roster/imports/fixtures/reviewed-announcement'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp, createError, defineEventHandler, getQuery, readBody, setHeader, toNodeListener } from 'h3'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { initializeDb } from '../../../db/client'
import { executeNativeImport, startRosterApi } from '../../roster/imports/fixtures/import-server'
const active = vi.hoisted(() => ({ db: null as ReturnType<typeof initializeDb> | null }))
vi.mock('@db', () => ({ useDb: () => active.db }))
vi.mock('@nuxtjs/mcp-toolkit/server', () => ({ defineMcpTool: (tool: unknown) => tool }))
const dir = mkdtempSync(join(tmpdir(), 'read-fairness-'))
const db = initializeDb({ create: true,  dbPath: join(dir, 'fixture.db') })
active.db = db
let imports: Awaited<ReturnType<typeof startRosterApi>>, server: Server, base: string
beforeAll(async () => {
  imports = await startRosterApi({ db, apiToken: 'synthetic-fairness', executeImport: executeNativeImport })
  vi.stubGlobal('defineEventHandler', defineEventHandler)
  vi.stubGlobal('getQuery', getQuery)
  vi.stubGlobal('setHeader', setHeader)
  vi.stubGlobal('createError', createError)
  vi.stubGlobal('readBody', readBody)
  vi.stubGlobal('useRuntimeConfig', () => ({ curatedPath: join(dir, 'curated.json'), reconcilePath: join(dir, 'reconcile.json') }))
  const handler = (await import('../../../layers/sme-roster/server/api/roster/differences.get')).default
  const recognitions = (await import('../../../layers/sme-roster/server/api/roster/recognitions.get')).default
  const comparison = (await import('../../../layers/sme-roster/server/api/comparison.get')).default
  const usccGet = (await import('../../../layers/sme-roster/server/api/roster/uscc-research.get')).default
  const usccPost = (await import('../../../layers/sme-roster/server/api/roster/uscc-research.post')).default
  const app = createApp().use('/api/roster/differences', handler)
    .use('/api/roster/recognitions', recognitions).use('/api/comparison', comparison)
    .use('/api/roster/uscc-research', defineEventHandler(event => event.method === 'POST' ? usccPost(event) : usccGet(event)))
  server = createServer(toNodeListener(app))
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})
afterAll(async () => {
  await new Promise<void>(r => server.close(() => r()))
  await imports.close(); db.$client.close(); rmSync(dir, { recursive: true, force: true }); vi.unstubAllGlobals()
})
it('retains literal public differences and sees an API commit on every read after its acknowledgement', async () => {
  const read = async () => { const res = await fetch(base + '/api/roster/differences?pageSize=20'); expect(res.status).toBe(200); expect(res.headers.get('cache-control')).toBe('no-store'); return res.json() }
  expect(await read()).toMatchObject({ rows: [], total: 0 })
  const client = createReviewedFixtureImportClient({ baseUrl: imports.baseUrl, token: 'synthetic-fairness' }, db)
  for (const [id, name] of [[1, '公平合成甲'], [2, '公平合成乙']] as const) {
    const receipt = await client.commit({ idempotencyKey: `fairness-${id}`, sourceKind: 'announcement', sourceIdentity: `synthetic-fairness-${id}`, payload: { announcement: { sourceDocument: { source: 'jxj', title: `Synthetic ${id}` }, records: [{ enterprise: { name }, titleCode: 'specialized_sme', events: [{ eventType: 'award', year: 2022 }] }] } } })
    expect(receipt).toMatchObject({ status: 'committed', summary: { failed: 0 } })
    const results = await Promise.all(Array.from({ length: 5 }, read))
    for (const value of results) {
      expect(value.total).toBe(id)
      expect(value.rows.map((row: any) => [row.name, row.direction, row.status])).toEqual(id === 1 ? [['公平合成甲', 'missing_in_miit', 'not_queried']] : [['公平合成乙', 'missing_in_miit', 'not_queried'], ['公平合成甲', 'missing_in_miit', 'not_queried']])
      expect(value.counts.specialized_sme).toEqual({ missing_in_miit: id, extra_in_miit: 0 })
    }
  }
})
it('keeps original invalid-query status and message before scheduling', async () => {
  const res = await fetch(base + '/api/roster/differences?title=invalid')
  expect(res.status).toBe(400)
  expect(await res.json()).toMatchObject({ statusMessage: 'Unknown title; expected little_giant, specialized_sme, innovative_sme' })
})

it('keeps literal nonempty results and separate universes during mixed public reads', async () => {
  const read = async (path: string, body?: object) => {
    const response = await fetch(base + path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {})
    expect(response.status).toBe(200)
    return response.json()
  }
  const tool = (await import('../../../layers/sme-roster/server/mcp/tools/list_differences')).default as unknown as { handler(input: object): Promise<unknown> }
  const [recognitions, summary, full, get, post, mcp] = await Promise.all([
    read('/api/roster/recognitions?pageSize=20'), read('/api/comparison?view=summary&pageSize=20'),
    read('/api/comparison?pageSize=20'), read('/api/roster/uscc-research?pageSize=20'),
    read('/api/roster/uscc-research', { pageSize: 20 }), tool.handler({ pageSize: 20 }),
  ])
  expect(recognitions.counts).toMatchObject({ titlePairs: 2, enterprises: 2 })
  expect(recognitions.rows.map((row: any) => [row.name, row.titleCode, row.firstYear])).toEqual([
    ['公平合成乙', 'specialized_sme', 2022], ['公平合成甲', 'specialized_sme', 2022],
  ])
  expect(summary).toMatchObject({ view: 'summary', total: 2 })
  expect(summary.rows.map((row: any) => [row.name, row.direction, row.evidenceIncluded])).toEqual([
    ['公平合成乙', 'missing_in_miit', false], ['公平合成甲', 'missing_in_miit', false],
  ])
  expect(full.total).toBe(2)
  expect(full.rows.map((row: any) => row.name)).toEqual(['公平合成乙', '公平合成甲'])
  expect(get).toMatchObject({ checklist: { counts: { total: 2 } }, plan: { counts: { targets: 2, filled: 0 }, ready: [] } })
  expect(post).toEqual(get)
  expect(mcp).toEqual({ rows: [], counts: {} })
  // Raw verdict-file bodies take the unchanged inline path; no original object
  // enters the FIFO. Their additive response and no-write semantics remain.
  const verdict = await read('/api/roster/uscc-research', { pageSize: 20, verdictFiles: [{ file: 'synthetic.json', value: { generatedAt: '2026-10-20T00:00:00Z', items: [] } }] })
  expect(verdict.checklist).toEqual(get.checklist)
  expect(verdict.verdicts).toMatchObject({ accepted: 0, foundClaims: 0, untouched: [], problems: [] })
  expect((await read('/api/roster/uscc-research?pageSize=20')).checklist).toEqual(get.checklist)
})

it('preserves each scheduled route validation and the import authentication boundary', async () => {
  for (const path of ['/api/roster/recognitions?title=invalid', '/api/comparison?view=invalid', '/api/roster/uscc-research?title=invalid']) {
    const response = await fetch(base + path)
    expect(response.status).toBe(400)
    expect((await response.json()).statusMessage).toBeTruthy()
  }
  const response = await fetch(base + '/api/roster/uscc-research', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"claims":1}' })
  expect(response.status).toBe(400)
  expect(await response.json()).toMatchObject({ statusMessage: 'claims 必须是数组' })
  const denied = await fetch(imports.baseUrl + '/api/roster/import/commit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
  expect(denied.status).toBe(401)
})

it('propagates the existing MCP cancellation reason instead of a domain response', async () => {
  const tool = (await import('../../../layers/sme-roster/server/mcp/tools/list_differences')).default as unknown as {
    handler(input: object, extra: { signal: AbortSignal }): Promise<unknown>
  }
  const controller = new AbortController()
  const reason = new Error('synthetic SDK cancellation')
  const pending = tool.handler({}, { signal: controller.signal })
  controller.abort(reason)
  await expect(pending).rejects.toBe(reason)
})
