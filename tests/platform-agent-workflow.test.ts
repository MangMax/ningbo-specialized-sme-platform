import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { useDb } from '../db/client'
import { updateCredential } from '../server/utils/credential-state'
import { startPlatformBatchApi } from './helpers/platform-batch-api'
import { whenIdle } from '../server/utils/job-runner'
const dir = mkdtempSync(join(tmpdir(), 'platform-agent-'))
const db = useDb({ dbPath: join(dir, 'agent.sqlite') })
const nativeFetch = globalThis.fetch
const scenarios = JSON.parse(readFileSync('.agents/skills/roster-ingestion-pipeline/examples/platform-scenarios.json', 'utf8'))
const workflowUrl = new URL('../.agents/skills/roster-ingestion-pipeline/examples/investigate-platform.mjs', import.meta.url).href
let api: Awaited<ReturnType<typeof startPlatformBatchApi>>
let workflow: any
let expired = true; let failedPage = true
const platformRequests: { source: string; name: string; page: number }[] = []
beforeAll(async () => {
  vi.stubEnv('NUXT_DB_PATH', join(dir, 'agent.sqlite')); vi.stubEnv('MIIT_COOKIE', ''); vi.stubEnv('MIIT_COOKIE_FILE', '')
  updateCredential('miitCookie', 'session=synthetic-agent-server-only', { db })
  api = await startPlatformBatchApi({ db, apiToken: 'synthetic-agent-task-token', filesDir: dir })
  workflow = await import(workflowUrl)
  vi.stubGlobal('fetch', async (url: string, init: any) => {
    if (url.startsWith(api.baseUrl)) return nativeFetch(url, init)
    expect(url).toMatch(/^https?:\/\/[^/]+\/(?:.*\/)?(?:YzzxqyApplayBLH\/queryList|ZjtxxjrBusInfoManageBLH\/(?:businessList|queryBusList))$/)
    expect(init.headers.Cookie).toBe('session=synthetic-agent-server-only')
    const source = url.endsWith('/queryList') ? 'queryList' : url.endsWith('/businessList') ? 'businessList' : 'queryBusList'
    const p = new URLSearchParams(init.body); const name = p.get('qymc') ?? ''; const page = Number(p.get('pageNum'))
    platformRequests.push({ source, name, page })
    if (name.includes('会话过期') && expired) return new Response('<form id="loginForm"><input name="password"></form>')
    if (name.includes('第二页失败') && page === 2 && failedPage) return new Response('synthetic error', { status: 503 })
    const total = name.includes('第二页失败') || p.get('tyshxydm') === '91330000TEST000001' ? 2 : 1
    const grid = source === 'queryList' ? 'applyGrid' : source === 'businessList' ? 'businessListGrid' : 'businessGrid'
    return new Response(JSON.stringify({ zrarData: { grid: { [grid]: { page, pageSize: 1, maxPage: total, maxCount: total, pageSet: [{ qymc: '合成企业', tyshxydm: '91330000TEST000001', relation: `${source}:${p.get('rdjb')}:${page}` }] } } } }))
  })
})
afterAll(async () => { await whenIdle(); await api?.close(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); db.$client.close(); rmSync(dir, { recursive: true, force: true }) })
it('reproducible agent workflow completes single batch expired second-page and multiple-relation scenarios using app routes only', async () => {
  const options = { baseUrl: api.baseUrl, apiToken: 'synthetic-agent-task-token', maxPolls: 100, pollIntervalMs: 1 }
  const single = await workflow.querySingle({ ...options, query: scenarios.single })
  expect(single).toMatchObject({ status: 'success', completeness: 'complete', fetchedCount: 1 })
  const batch = await workflow.investigatePlatform({ ...options, queries: scenarios.batch })
  expect(batch).toMatchObject({ state: 'done', completeness: 'complete', progress: { done: 3, total: 3 } })
  expect(batch.items[1].segments.flatMap((s: any) => s.rows)).toHaveLength(6)
  const interrupted = await workflow.investigatePlatform({ ...options, queries: [scenarios.expired, scenarios.secondPageFailure, scenarios.multipleRelations] })
  expect(interrupted.items.map((i: any) => i.status)).toEqual(['auth_failed', 'partial', 'success'])
  expect(interrupted.items[1].unfinished).toEqual([{ source: 'queryList', rdjb: null, page: 2 }])
  const completeItem = interrupted.items[2]
  expect(completeItem.segments[0].rows.map((r: any) => r.relation)).toEqual(['queryList:null:1', 'queryList:null:2'])
  expired = false; failedPage = false; platformRequests.length = 0
  const recovered = await workflow.retryUnfinishedBatch({ ...options, batch: interrupted })
  expect(recovered).toMatchObject({ batchId: interrupted.batchId, state: 'done', completeness: 'complete' })
  expect(recovered.items.map((i: any) => i.itemId)).toEqual(interrupted.itemIds)
  expect(recovered.items[2]).toEqual(completeItem)
  expect(recovered.items[1].segments[0]).toEqual(interrupted.items[1].segments[0])
  expect(platformRequests).toEqual([{ source: 'queryList', name: '合成会话过期', page: 1 }, { source: 'queryList', name: '合成第二页失败', page: 2 }])
  expect(api.paths.length).toBeGreaterThan(10)
  for (const path of api.paths) expect(path).toMatch(/^\/api\/platform\/(?:query|capabilities|batches(?:\/[0-9A-HJKMNP-TV-Z]{26}(?:\/retry|\/items\/[0-9A-HJKMNP-TV-Z]{26})?)?)$/)
  expect(JSON.stringify(recovered)).not.toContain('synthetic-agent-server-only')
  expect(db.$client.prepare('SELECT count(*) AS n FROM enterprise').get()).toEqual({ n: 0 })
})

// Independent wire literals. Response serialization keeps these oracles outside SUT ownership.
const B = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
const C = '01ARZ3NDEKTSV4RRFFQ69G5FAW'
const P = '01ARZ3NDEKTSV4RRFFQ69G5FAX'
const receipt = { batchId: B, itemIds: [C, P], state: 'queued' }
const firstSegment = {
  source: 'queryList', status: 'partial', effectiveConditions: { uscc: '91330000TEST000001', combination: 'and' },
  titleScope: { mode: 'source_default', rdjb: [] },
  queriedAt: '2026-10-01T01:02:03.000Z', completedAt: '2026-10-01T01:02:04.000Z',
  rows: [{ tyshxydm: '91330000TEST000001', relation: 'rel-1' }, { tyshxydm: '91330000TEST000001', relation: 'rel-2' }],
  pages: [{ source: 'queryList', rdjb: null, page: 1, maxPage: 2, status: 'success', fetchedCount: 2, declaredTotal: 3, error: null }],
  fetchedCount: 2, declaredTotal: 3, completeness: 'partial', fullRange: true,
  unfinished: [{ source: 'queryList', rdjb: null, page: 2 }], error: { code: 'upstream_failed', message: 'page two failed' },
  limits: { maxRequests: 4, maxRows: 10, maxDurationMs: 1000, pageSize: 2 },
}
const laterSegment = {
  source: 'queryList', status: 'success', effectiveConditions: { uscc: '91330000TEST000001', combination: 'and' },
  titleScope: { mode: 'source_default', rdjb: [] },
  queriedAt: '2026-10-02T01:02:03.000Z', completedAt: '2026-10-02T01:02:04.000Z',
  rows: [{ tyshxydm: '91330000TEST000001', relation: 'rel-3' }],
  pages: [{ source: 'queryList', rdjb: null, page: 2, maxPage: 2, status: 'success', fetchedCount: 1, declaredTotal: 3, error: null }],
  fetchedCount: 1, declaredTotal: 3, completeness: 'complete', fullRange: false, unfinished: [], error: null,
  limits: { maxRequests: 4, maxRows: 10, maxDurationMs: 1000, pageSize: 2 },
}
const completeItem = { itemId: C, status: 'success', completeness: 'complete', segments: [laterSegment], unfinished: [] }
const partialItem = { itemId: P, status: 'partial', completeness: 'partial', segments: [firstSegment], unfinished: [{ source: 'queryList', rdjb: null, page: 2 }] }
const terminal = {
  batchId: B, itemIds: [C, P], state: 'failed', progress: { done: 1, total: 2 }, completeness: 'partial', attempt: 1,
  items: [completeItem, partialItem], usage: { requests: 3, rows: 3 },
  limits: { maxRequests: 8, maxRows: 20, maxDurationMs: 2000, maxResultBytes: 65536 },
  createdAt: '2026-09-30T00:00:01.000Z', startedAt: '2026-09-30T00:00:02.000Z', finishedAt: '2026-09-30T00:00:03.000Z', error: 'interrupted',
}
const active = { ...terminal, state: 'running', finishedAt: null, error: null }
const checkpoint = { receipt, lastBatch: active }
const options = { baseUrl: 'http://controlled.invalid', apiToken: 'explicit-task-token', maxPolls: 1, pollIntervalMs: 0 }
const statusPath = `/api/platform/batches/${B}`
type Reply = { method?: string; path: string; value?: unknown; status?: number; raw?: string }
async function withTransport(replies: Reply[], run: (requests: any[]) => Promise<void>) {
  const originalFetch = globalThis.fetch
  const requests: any[] = []
  globalThis.fetch = (async (url: string, init: any) => {
    const request = { method: init.method, path: new URL(url).pathname, body: init.body === undefined ? null : JSON.parse(init.body), token: init.headers.authorization ?? null }
    requests.push(request)
    const next = replies[requests.length - 1]
    if (!next) throw new Error(`Unexpected request ${request.method} ${request.path}`)
    expect(request.method).toBe(next.method ?? 'GET'); expect(request.path).toBe(next.path)
    return new Response(next.raw ?? JSON.stringify(next.value), { status: next.status ?? 200 })
  }) as typeof fetch
  try { await run(requests); expect(requests).toHaveLength(replies.length) }
  finally { globalThis.fetch = originalFetch }
}
const get = (path: string, value: unknown): Reply => ({ path, value })
const terminalReplies = () => [get(statusPath, { ...terminal, items: [partialItem, completeItem] }), get(`${statusPath}/items/${C}`, completeItem), get(`${statusPath}/items/${P}`, partialItem)]

it('zero polls retains accepted receipt without reading or retrying', async () => {
  const query = { source: 'queryList', uscc: '91330000TEST000001' }
  const limits = { maxRequests: 8, maxRows: 20, maxDurationMs: 2000, maxResultBytes: 65536 }
  await withTransport([get('/api/platform/capabilities', {}), { method: 'POST', path: '/api/platform/batches', value: receipt }], async requests => {
    expect(await workflow.investigatePlatform({ ...options, queries: [query], limits, maxPolls: 0 })).toEqual({
      batchId: B, itemIds: [C, P], state: 'poll_limit', completeness: 'partial', serverState: 'queued', items: [], checkpoint: { receipt, lastBatch: null },
    })
    expect(requests).toEqual([
      { method: 'GET', path: '/api/platform/capabilities', body: null, token: null },
      { method: 'POST', path: '/api/platform/batches', body: { items: [{ query }], limits }, token: 'Bearer explicit-task-token' },
    ])
  })
})
it('poll exhaustion retains latest active checkpoint', async () => {
  await withTransport([get(statusPath, { ...active, state: 'queued', items: [] }), get(statusPath, active)], async () => {
    expect(await workflow.collectBatch({ ...options, batchId: B, checkpoint: { receipt, lastBatch: null }, maxPolls: 2 })).toEqual({
      ...active, state: 'poll_limit', completeness: 'partial', serverState: 'running', checkpoint,
    })
  })
})

it('collect resumes same batch without submission', async () => {
  await withTransport(terminalReplies(), async () => {
    expect(await workflow.collectBatch({ ...options, batchId: B, checkpoint })).toEqual(terminal)
  })
})
it.each(['poll_limit', 'queued', 'running'])('retry on %s only observes even when terminal partial is reached', async state => {
  await withTransport(terminalReplies(), async () => {
    const input = { ...active, state, items: state === 'poll_limit' ? [] : active.items, checkpoint }
    expect(await workflow.retryUnfinishedBatch({ ...options, batch: input, itemIds: [P] })).toEqual(terminal)
  })
})

it.each(['selected', 'default'])('explicit terminal retry selects only authorized unfinished items with %s selection', async selection => {
  const recoveredItem = { itemId: P, status: 'success', completeness: 'complete', segments: [firstSegment, laterSegment], unfinished: [] }
  const recoveredBatch = { ...terminal, state: 'done', completeness: 'complete', attempt: 2, progress: { done: 2, total: 2 }, items: [completeItem, recoveredItem], usage: { requests: 1, rows: 1 }, startedAt: '2026-10-02T00:00:01.000Z', finishedAt: '2026-10-02T00:00:02.000Z', error: null }
  await withTransport([
    { method: 'POST', path: `${statusPath}/retry`, value: receipt }, get(statusPath, recoveredBatch),
    get(`${statusPath}/items/${C}`, completeItem), get(`${statusPath}/items/${P}`, recoveredItem),
  ], async requests => {
    expect(await workflow.retryUnfinishedBatch({ ...options, batch: terminal, ...(selection === 'selected' ? { itemIds: [C, P, 'not-in-batch'] } : {}) })).toEqual(recoveredBatch)
    expect(requests[0]).toEqual({ method: 'POST', path: `${statusPath}/retry`, body: { itemIds: [P] }, token: 'Bearer explicit-task-token' })
    expect(requests.slice(1).every(request => request.token === null && request.body === null)).toBe(true)
  })
})
it('new queued retry receipt keeps previous terminal observation separate at zero polls', async () => {
  await withTransport([{ method: 'POST', path: `${statusPath}/retry`, value: receipt }], async requests => {
    const input = { ...terminal, checkpoint: { receipt, lastBatch: terminal } }
    expect(await workflow.retryUnfinishedBatch({ ...options, batch: input, itemIds: [P], maxPolls: 0 })).toEqual({
      batchId: B, itemIds: [C, P], state: 'poll_limit', completeness: 'partial', serverState: 'queued', items: [],
      checkpoint: { receipt, lastBatch: null, previousBatch: input },
    })
    expect(requests).toEqual([{ method: 'POST', path: `${statusPath}/retry`, body: { itemIds: [P] }, token: 'Bearer explicit-task-token' }])
  })
})
it('complete terminal batch does not post retry', async () => {
  await withTransport([], async () => {
    const input = { ...terminal, state: 'done', completeness: 'complete', itemIds: [C], items: [completeItem], progress: { done: 1, total: 1 } }
    expect(await workflow.retryUnfinishedBatch({ ...options, batch: input })).toBe(input)
    expect(await workflow.retryUnfinishedBatch({ ...options, batch: terminal, itemIds: [C] })).toBe(terminal)
  })
})
it.each(['missing-items', 'incomplete-items', 'unknown-state'])('retry rejects %s without treating unknown as complete', async kind => {
  await withTransport([], async () => {
    const input = { ...terminal, items: kind === 'missing-items' ? undefined : [], state: kind === 'unknown-state' ? 'unknown' : 'failed' }
    await expect(workflow.retryUnfinishedBatch({ ...options, batch: input })).rejects.toThrow('Retry requires terminal batch with item data')
  })
})
it.each(['receipt', 'lastBatch', 'previousBatch'])('checkpoint %s identity mismatch fails before transport', async field => {
  const wrong = { ...terminal, batchId: '01ARZ3NDEKTSV4RRFFQ69G5FAY' }
  await withTransport([], async () => {
    const badCheckpoint = { ...checkpoint, [field]: wrong }
    await expect(workflow.collectBatch({ ...options, batchId: B, checkpoint: badCheckpoint })).rejects.toThrow('Checkpoint batchId mismatch')
    await expect(workflow.retryUnfinishedBatch({ ...options, batch: { ...terminal, checkpoint: badCheckpoint } })).rejects.toThrow('Checkpoint batchId mismatch')
  })
})

it.each(['http', 'json'])('observation errors preserve first %s failure without reposting', async kind => {
  const saved = structuredClone(checkpoint)
  await withTransport([{ path: statusPath, ...(kind === 'http' ? { status: 503, raw: 'unavailable' } : { raw: '{' }) }], async requests => {
    const result = workflow.retryUnfinishedBatch({ ...options, batch: { ...active, state: 'poll_limit', checkpoint: saved } })
    if (kind === 'http') await expect(result).rejects.toEqual(new Error('App request failed (503)'))
    else await expect(result).rejects.toEqual(new SyntaxError("Expected property name or '}' in JSON at position 1 (line 1 column 2)"))
    expect(saved).toEqual(checkpoint)
    expect(requests).toEqual([{ method: 'GET', path: statusPath, body: null, token: null }])
  })
})
it('retry conflict preserves first HTTP failure without automatic resubmission', async () => {
  await withTransport([{ method: 'POST', path: `${statusPath}/retry`, status: 409, raw: 'still active' }], async requests => {
    await expect(workflow.retryUnfinishedBatch({ ...options, batch: terminal, itemIds: [P] })).rejects.toEqual(new Error('App request failed (409)'))
    expect(requests).toEqual([{ method: 'POST', path: `${statusPath}/retry`, body: { itemIds: [P] }, token: 'Bearer explicit-task-token' }])
  })
})
it('collect never uses an inherited terminal checkpoint as a fresh terminal observation', async () => {
  await withTransport([get(statusPath, active)], async () => {
    expect(await workflow.collectBatch({ ...options, batchId: B, checkpoint: { receipt, lastBatch: terminal } })).toEqual({
      ...active, state: 'poll_limit', completeness: 'partial', serverState: 'running', checkpoint,
    })
  })
})

it('zero polls without observations keeps server state unknown and does not invent progress', async () => {
  await withTransport([], async () => {
    expect(await workflow.collectBatch({ ...options, batchId: B, maxPolls: 0 })).toEqual({
      batchId: B, itemIds: [], state: 'poll_limit', completeness: 'partial', serverState: null, items: [], checkpoint: { receipt: null, lastBatch: null },
    })
  })
})
it('retry active checkpoint preserves previous batch and raw server completeness after a fresh GET', async () => {
  const nextActive = { ...active, attempt: 2, completeness: 'complete' }
  await withTransport([{ method: 'POST', path: `${statusPath}/retry`, value: receipt }, get(statusPath, nextActive)], async requests => {
    const input = { ...terminal, checkpoint: { receipt, lastBatch: terminal } }
    expect(await workflow.retryUnfinishedBatch({ ...options, batch: input, itemIds: [P] })).toEqual({
      ...nextActive, state: 'poll_limit', completeness: 'partial', serverState: 'running',
      checkpoint: { receipt, lastBatch: nextActive, previousBatch: input },
    })
    expect(requests).toEqual([
      { method: 'POST', path: `${statusPath}/retry`, body: { itemIds: [P] }, token: 'Bearer explicit-task-token' },
      { method: 'GET', path: statusPath, body: null, token: null },
    ])
  })
})
