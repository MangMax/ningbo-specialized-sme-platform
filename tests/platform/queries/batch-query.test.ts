import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initializeDb } from '../../../db/client'
import { updateCredential } from '../../../server/utils/credential-state'
import { whenIdle } from '../../../server/utils/job-runner'
import { handlePlatformBatchRequest } from '../../../server/utils/platform-batch-http'
import { MAX_BATCH_ATTEMPTS } from '../../../lib/platform/batch-query'

const dir = mkdtempSync(join(tmpdir(), 'platform-batch-'))
const db = initializeDb({ create: true,  dbPath: join(dir, 'test.sqlite') })
const cookie = 'session=synthetic-batch-secret'
const token = 'synthetic-task-token'
const upstream = vi.fn()
const uscc = '91330211255994457P'
const invoke = (action: 'submit' | 'status' | 'item' | 'retry', body?: unknown, batchId?: string, itemId?: string, authorized = true) => handlePlatformBatchRequest(action, { body, batchId, itemId, headers: authorized ? { authorization: `Bearer ${token}` } : {} }, { db, apiToken: token, filesDir: dir })
function response(grid: string, rows: Record<string, string>[], page = 1, total = rows.length) {
  // Recognized queries require size metadata; legacy fixtures leave it optional.
  return { ok: true, status: 200, text: async () => JSON.stringify({ zrarData: { grid: { [grid]: { pageSet: rows, page, ...(grid === 'businessGrid' ? { pageSize: 1 } : {}), maxCount: total, maxPage: Math.max(1, total) } } } }) }
}
beforeAll(() => { vi.stubEnv('NUXT_DB_PATH', join(dir, 'test.sqlite')); vi.stubEnv('MIIT_COOKIE', ''); vi.stubEnv('MIIT_COOKIE_FILE', '') })
beforeEach(() => { updateCredential('miitCookie', cookie, { db }); upstream.mockReset(); vi.stubGlobal('fetch', upstream) })
afterAll(async () => { await whenIdle(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); db.$client.close(); rmSync(dir, { recursive: true, force: true }) })
it('REST accepts a mixed-source batch asynchronously and retrieves stable individual results without business writes', async () => {
  upstream.mockImplementation(async (url: string, init: any) => {
    expect(init.headers.Cookie).toBe(cookie)
    const p = new URLSearchParams(init.body)
    const grid = url.includes('/queryList') ? 'applyGrid' : url.includes('/businessList') ? 'businessListGrid' : 'businessGrid'
    return response(grid, [{ qymc: '合成企业', tyshxydm: uscc, relation: p.get('rdjb') ?? 'application' }])
  })
  const submitted = await invoke('submit', { items: [
    { query: { source: 'queryList', name: '合成', pageSize: 1 } },
    { query: { source: 'businessList', uscc, rdjb: 'all', pageSize: 1 } },
    { query: { source: 'queryBusList', name: '合成', rdjb: ['3'], pageSize: 1 } },
  ] })
  expect(submitted.status).toBe(202)
  expect(submitted.headers['cache-control']).toBe('no-store')
  const receipt = submitted.body as any
  expect(receipt.batchId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
  expect(new Set(receipt.itemIds).size).toBe(3)
  await whenIdle()
  const status = (await invoke('status', undefined, receipt.batchId)).body as any
  expect(status).toMatchObject({ batchId: receipt.batchId, state: 'done', completeness: 'complete', progress: { done: 3, total: 3 } })
  expect(status.items.map((i: any) => i.status)).toEqual(['success', 'success', 'success'])
  const item = (await invoke('item', undefined, receipt.batchId, receipt.itemIds[1])).body as any
  expect(item.itemId).toBe(receipt.itemIds[1])
  expect(item.segments.flatMap((s: any) => s.rows).map((r: any) => r.relation)).toEqual(['1', '2', '3'])
  for (const table of ['enterprise', 'record', 'platform_collection', 'platform_business_observation', 'platform_business_record', 'import_batch']) expect(db.$client.prepare(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({ n: 0 })
})
it('retry keeps batch and item IDs and completed rows and times while querying only unfinished pages', async () => {
  let failSecond = true
  const seen: string[] = []
  upstream.mockImplementation(async (_url: string, init: any) => {
    const p = new URLSearchParams(init.body); const n = Number(p.get('pageNum')); seen.push(`${p.get('qymc')}:${n}`)
    if (p.get('qymc') === '待补' && n === 2 && failSecond) return { ok: false, status: 503, text: async () => cookie }
    return response('applyGrid', [{ qymc: '同码多关系', tyshxydm: uscc, relation: String(n) }], n, p.get('qymc') === '待补' ? 2 : 1)
  })
  const receipt = (await invoke('submit', { items: [{ query: { source: 'queryList', name: '完成', pageSize: 1 } }, { query: { source: 'queryList', name: '待补', pageSize: 1 } }] })).body as any
  await whenIdle()
  const prior = (await invoke('status', undefined, receipt.batchId)).body as any
  expect(prior).toMatchObject({ state: 'failed', completeness: 'partial', progress: { done: 1, total: 2 } })
  expect(prior.items[1].unfinished).toEqual([{ source: 'queryList', rdjb: null, page: 2 }])
  failSecond = false; seen.length = 0
  const retried = await invoke('retry', { itemIds: [receipt.itemIds[1]] }, receipt.batchId)
  expect(retried.status).toBe(202)
  expect(retried.body).toMatchObject({ batchId: receipt.batchId, itemIds: receipt.itemIds })
  await whenIdle()
  const after = (await invoke('status', undefined, receipt.batchId)).body as any
  expect(after).toMatchObject({ state: 'done', completeness: 'complete', attempt: 2 })
  expect(seen).toEqual(['待补:2'])
  expect(after.items[0]).toEqual(prior.items[0])
  expect(after.items[1].segments[0]).toEqual(prior.items[1].segments[0])
  expect(after.items[1].segments.flatMap((s: any) => s.rows).map((r: any) => r.relation)).toEqual(['1', '2'])
  expect((await invoke('retry', { itemIds: [receipt.itemIds[0]] }, receipt.batchId)).status).toBe(409)
})
it('running status checkpoints completed pages and restart reports failed without resuming or losing those pages', async () => {
  let release!: () => void
  let entered!: () => void
  const secondPage = new Promise<void>(r => { entered = r })
  let blocked = false
  upstream.mockImplementation(async (_url: string, init: any) => {
    const n = Number(new URLSearchParams(init.body).get('pageNum'))
    if (n === 2 && !blocked) { blocked = true; entered(); await new Promise<void>(r => { release = r }) }
    return response('applyGrid', [{ qymc: `关系${n}`, tyshxydm: uscc }], n, 2)
  })
  const receipt = (await invoke('submit', { items: [{ query: { source: 'queryList', name: '合成', pageSize: 1 } }] })).body as any
  await secondPage
  try {
    const running = (await invoke('status', undefined, receipt.batchId)).body as any
    expect(running).toMatchObject({ state: 'running', progress: { done: 0, total: 1 }, completeness: 'partial' })
    expect(running.items[0].segments[0].rows).toEqual([{ qymc: '关系1', tyshxydm: uscc }])
    expect(running.items[0].unfinished).toEqual([{ source: 'queryList', rdjb: null, page: 2 }])
    const { writeFileSync } = await import('node:fs')
    const restartPath = join(dir, 'restart.sqlite')
    writeFileSync(restartPath, db.$client.serialize())
    const restarted = initializeDb({ create: true,  dbPath: restartPath })
    const restored = await handlePlatformBatchRequest('status', { batchId: receipt.batchId }, { db: restarted, filesDir: dir })
    expect(restored.body).toMatchObject({ state: 'failed', completeness: 'partial' })
    expect((restored.body as any).items[0]).toEqual(running.items[0])
    expect((restored.body as any).error).toContain('重启')
    release(); await whenIdle()
    const retried = await handlePlatformBatchRequest('retry', { batchId: receipt.batchId, body: { itemIds: receipt.itemIds }, headers: { authorization: `Bearer ${token}` } }, { db: restarted, apiToken: token, filesDir: dir })
    expect(retried.status).toBe(202); await whenIdle()
    const recovered = (await handlePlatformBatchRequest('status', { batchId: receipt.batchId }, { db: restarted, filesDir: dir })).body as any
    expect(recovered).toMatchObject({ state: 'done', completeness: 'complete', attempt: 2 })
    expect(recovered.items[0].segments[0]).toEqual(running.items[0].segments[0])
    expect(recovered.items[0].segments[1].pages.map((page: any) => page.page)).toEqual([2])
    restarted.$client.close()
  } finally { release(); await whenIdle() }
})
it.each([
  ['empty', { items: [] }],
  ['too many', { items: Array.from({ length: 51 }, () => ({ query: { source: 'queryList', name: '合成' } })) }],
  ['cookie input', { items: [{ query: { source: 'queryList', name: '合成', cookie } }] }],
  ['item credentials', { items: [{ query: { source: 'queryList', name: '合成' }, cookie }] }],
  ['wrong title type', { items: [{ query: { source: 'businessList', uscc, rdjb: ['1'] } }] }],
  ['request maximum', { items: [{ query: { source: 'queryList', name: '合成' } }], limits: { maxRequests: 201 } }],
  ['duration maximum', { items: [{ query: { source: 'queryList', name: '合成' } }], limits: { maxDurationMs: 120001 } }],
  ['result minimum', { items: [{ query: { source: 'queryList', name: '合成' } }], limits: { maxResultBytes: 65535 } }],
  ['result maximum', { items: [{ query: { source: 'queryList', name: '合成' } }], limits: { maxResultBytes: 8388609 } }],
  ['unknown root', { items: [{ query: { source: 'queryList', name: '合成' } }], cookie }],
] as const)('REST and raw MCP reject invalid batch %s before any platform request', async (_label, input) => {
  const { platformQueryRpcError } = await import('../../../server/utils/mcp-platform-query')
  expect((await invoke('submit', input)).status).toBe(400)
  const error = platformQueryRpcError({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'submit_platform_batch', arguments: input } })
  expect(error?.status).toBe(400)
  expect(await error?.text()).not.toContain('synthetic-batch-secret')
  expect(upstream).not.toHaveBeenCalled()
})
it('batch submission and retry require task authorization while status and item reads stay read-only', async () => {
  expect((await invoke('submit', { items: [{ query: { source: 'queryList', name: '合成' } }] }, undefined, undefined, false)).status).toBe(401)
  expect((await invoke('retry', {}, '01M56FKFXYBPSBEN8FYTDH2JV4', undefined, false)).status).toBe(401)
  expect(upstream).not.toHaveBeenCalled()
  expect((await invoke('status', undefined, '01M56FKFXYBPSBEN8FYTDH2JV4', undefined, false)).status).toBe(404)
  expect((await invoke('status', undefined, 'invalid')).status).toBe(400)
})
it.each([
  ['request cap', { maxRequests: 1 }, 1],
  ['row cap', { maxRows: 1 }, 1],
] as const)('batch %s leaves all unfinished ranges and truthful progress', async (_label, limits, expectedRequests) => {
  upstream.mockImplementation(async (_url: string, init: any) => {
    const n = Number(new URLSearchParams(init.body).get('pageNum'))
    return response('applyGrid', [{ qymc: `关系${n}` }], n, 2)
  })
  const receipt = (await invoke('submit', { items: [{ query: { source: 'queryList', name: '甲', pageSize: 1 } }, { query: { source: 'queryList', name: '乙', pageSize: 1 } }], limits })).body as any
  await whenIdle()
  const batch = (await invoke('status', undefined, receipt.batchId)).body as any
  expect(batch).toMatchObject({ state: 'failed', completeness: 'partial', usage: { requests: expectedRequests, rows: 1 }, progress: { done: 0, total: 2 } })
  expect(batch.items[0]).toMatchObject({ status: 'partial', unfinished: [{ page: 2 }] })
  expect(batch.items[1]).toMatchObject({ status: 'not_queried', unfinished: [{ page: 1 }] })
})
it('bounded result bytes retain completed pages and leave an oversized page explicitly unfinished', async () => {
  upstream.mockImplementation(async (_url: string, init: any) => {
    const n = Number(new URLSearchParams(init.body).get('pageNum'))
    return response('applyGrid', [{ qymc: n === 1 ? '已完成' : '宽'.repeat(50000) }], n, 2)
  })
  const receipt = (await invoke('submit', { items: [{ query: { source: 'queryList', name: '合成', pageSize: 1 } }], limits: { maxResultBytes: 65536 } })).body as any
  await whenIdle()
  const batch = (await invoke('status', undefined, receipt.batchId)).body as any
  expect(Buffer.byteLength(JSON.stringify(batch))).toBeLessThanOrEqual(65536)
  expect(batch).toMatchObject({ state: 'failed', completeness: 'partial', usage: { requests: 2, rows: 1 } })
  expect(batch.items[0].segments[0].rows).toEqual([{ qymc: '已完成' }])
  expect(batch.items[0].unfinished).toEqual([{ source: 'queryList', rdjb: null, page: 2 }])
})
it('batch deadline aborts safely and preserves unfinished items rather than reporting completion', async () => {
  upstream.mockImplementation((_url: string, init: any) => new Promise((_resolve, reject) => { init.signal.addEventListener('abort', () => reject(new DOMException(cookie, 'AbortError'))) }))
  const receipt = (await invoke('submit', { items: [{ query: { source: 'queryList', name: '合成' } }, { query: { source: 'queryList', name: '未查' } }], limits: { maxDurationMs: 25 } })).body as any
  await whenIdle()
  const batch = (await invoke('status', undefined, receipt.batchId)).body as any
  expect(batch).toMatchObject({ state: 'failed', completeness: 'partial', progress: { done: 0, total: 2 } })
  expect(batch.items[0].segments[0]).toMatchObject({ status: 'failed', error: { code: 'timeout' } })
  expect(batch.items[1].status).toBe('not_queried')
  expect(JSON.stringify(batch)).not.toContain('synthetic-batch-secret')
})
it.each<[string, () => any, string]>([
  ['zero', () => response('applyGrid', []), 'no_record'],
  ['expired', () => ({ ok: true, status: 200, text: async () => '<form id="loginForm"><input name="password"></form>' }), 'auth_failed'],
  ['upstream', () => ({ ok: false, status: 503, text: async () => cookie }), 'failed'],
  ['rate limited', () => ({ ok: false, status: 429, text: async () => cookie }), 'failed'],
  ['sensitive body', () => response('applyGrid', [{ qymc: cookie }]), 'failed'],
] as const)('individual batch %s remains isolated with no secret in persisted history or output', async (_label, respond, status) => {
  upstream.mockImplementation(respond)
  const receipt = (await invoke('submit', { items: [{ query: { source: 'queryList', name: '合成' } }] })).body as any
  await whenIdle()
  const item = (await invoke('item', undefined, receipt.batchId, receipt.itemIds[0])).body as any
  expect(item.status).toBe(status)
  expect(item.segments).toHaveLength(1)
  expect(upstream).toHaveBeenCalledTimes(1)
  const history = db.$client.prepare('SELECT params, result, error FROM job WHERE id = ?').get(receipt.batchId)
  expect(JSON.stringify({ item, history })).not.toContain('synthetic-batch-secret')
})
it('queued mixed-source batches retain one submission credential snapshot across settings changes and retries capture anew', async () => {
  const { registerJob, submitJob } = await import('../../../server/utils/job-runner')
  let release!: () => void
  registerJob({ kind: 'batch-test-holder', status: 'ready', summary: 'Synthetic gate', parse: () => ({ ok: true, params: {} }), run: async () => { await new Promise<void>(r => { release = r }); return { result: {} } } })
  submitJob(db, { kind: 'batch-test-holder', params: {}, filesDir: dir })
  const seen: string[] = []
  let expired = true
  upstream.mockImplementation(async (url: string, init: any) => {
    seen.push(init.headers.Cookie)
    if (expired && url.includes('/queryBusList')) return { ok: false, status: 401, text: async () => cookie }
    const p = new URLSearchParams(init.body)
    const grid = url.includes('/queryList') ? 'applyGrid' : url.includes('/businessList') ? 'businessListGrid' : 'businessGrid'
    return response(grid, [{ qymc: '合成', relation: p.get('rdjb') ?? 'apply' }])
  })
  const receipt = (await invoke('submit', { items: [
    { query: { source: 'queryList', name: '合成', pageSize: 1 } },
    { query: { source: 'businessList', uscc, rdjb: 'all', pageSize: 1 } },
    { query: { source: 'queryBusList', name: '合成', rdjb: ['1', '2'], pageSize: 1 } },
  ] })).body as any
  updateCredential('miitCookie', 'session=synthetic-replacement-secret', { db })
  release(); await whenIdle()
  expect(seen).toEqual(Array(5).fill(cookie))
  const before = (await invoke('status', undefined, receipt.batchId)).body as any
  expect(before.items.map((item: any) => item.status)).toEqual(['success', 'success', 'auth_failed'])
  expired = false; seen.length = 0
  expect((await invoke('retry', { itemIds: [receipt.itemIds[2]] }, receipt.batchId)).status).toBe(202)
  await whenIdle()
  expect(seen).toEqual(['session=synthetic-replacement-secret', 'session=synthetic-replacement-secret'])
  const after = (await invoke('status', undefined, receipt.batchId)).body as any
  expect(after.items[0]).toEqual(before.items[0])
  expect(after.items[1]).toEqual(before.items[1])
  expect(after.completeness).toBe('complete')
  const stored = JSON.stringify(db.$client.prepare('SELECT params, result, error FROM job').all())
  for (const secret of ['synthetic-batch-secret', 'synthetic-replacement-secret']) expect(stored).not.toContain(secret)
})
it('batch preserves divergent source failure policies and retries every unfinished title without replaying completed titles', async () => {
  let failing = true
  const seen: string[] = []
  upstream.mockImplementation(async (url: string, init: any) => {
    const p = new URLSearchParams(init.body); const title = p.get('rdjb'); const source = url.includes('/businessList') ? 'business' : 'recognized'
    seen.push(`${source}:${title}`)
    if (failing && title === '1') return { ok: false, status: 503, text: async () => '' }
    return response(source === 'business' ? 'businessListGrid' : 'businessGrid', [{ qymc: '同码关系', tyshxydm: uscc, relation: `${source}:${title}` }])
  })
  const receipt = (await invoke('submit', { items: [{ query: { source: 'businessList', uscc, rdjb: 'all', pageSize: 1 } }, { query: { source: 'queryBusList', name: '合成', pageSize: 1 } }] })).body as any
  await whenIdle()
  expect(seen).toEqual(['business:1', 'business:2', 'business:3', 'recognized:1'])
  const prior = (await invoke('status', undefined, receipt.batchId)).body as any
  expect(prior.items[0].unfinished.map((p: any) => p.rdjb)).toEqual(['1'])
  expect(prior.items[1].unfinished.map((p: any) => p.rdjb)).toEqual(['1', '2', '3'])
  failing = false; seen.length = 0
  await invoke('retry', { itemIds: receipt.itemIds }, receipt.batchId); await whenIdle()
  const batch = (await invoke('status', undefined, receipt.batchId)).body as any
  expect(seen).toEqual(['business:1', 'recognized:1', 'recognized:2', 'recognized:3'])
  expect(batch.completeness).toBe('complete')
  expect(batch.items[0].segments[0]).toEqual(prior.items[0].segments[0])
  expect(batch.items[0].segments.flatMap((s: any) => s.rows).map((r: any) => r.relation)).toEqual(['business:2', 'business:3', 'business:1'])
})
it('all batches singles and legacy retry backoff share the process-wide maximum of two platform requests', async () => {
  const { queryPlatformSlots } = await import('../../../lib/platform/client')
  const { runPlatformLiveQuery } = await import('../../../server/utils/platform-live-query')
  let releaseBackoff!: () => void
  let inBackoff!: () => void
  const entered = new Promise<void>(r => { inBackoff = r })
  let legacyAttempts = 0; let active = 0; let peak = 0
  const legacy = queryPlatformSlots({ uscc, cookie, retries: 1, fetchImpl: async () => {
    legacyAttempts++
    if (legacyAttempts === 1) return { ok: false, status: 503, text: async () => '' }
    return response('applyGrid', [])
  }, sleep: async () => { inBackoff(); await new Promise<void>(r => { releaseBackoff = r }) } }, [{ interface: 'apply_list' }])
  await entered
  upstream.mockImplementation(async (url: string) => {
    active++; peak = Math.max(peak, active)
    await new Promise(r => setTimeout(r, 2))
    const out = response(url.includes('/queryList') ? 'applyGrid' : url.includes('/businessList') ? 'businessListGrid' : 'businessGrid', [])
    const text = out.text
    out.text = async () => { await new Promise(r => setTimeout(r, 2)); active--; return text() }
    return out
  })
  try {
    const receipt = (await invoke('submit', { items: [{ query: { source: 'businessList', uscc, rdjb: 'all', pageSize: 1 } }, { query: { source: 'queryBusList', name: '合成', pageSize: 1 } }] })).body as any
    await Promise.all([whenIdle(), ...Array.from({ length: 5 }, () => runPlatformLiveQuery({ source: 'queryList', name: '合成', pageSize: 1 }, { cookie }))])
    expect(peak).toBe(1) // Legacy holds the other slot, including its retry backoff.
    expect(((await invoke('status', undefined, receipt.batchId)).body as any).completeness).toBe('complete')
  } finally { releaseBackoff(); await legacy }
})
it('MCP batch submit status item and retry return schema-valid equivalent REST business results', async () => {
  vi.doMock('@nuxtjs/mcp-toolkit/server', () => ({ defineMcpTool: (definition: unknown) => definition }))
  const submit = (await import('../../../server/mcp/tools/submit_platform_batch')).default as any
  const status = (await import('../../../server/mcp/tools/get_platform_batch')).default as any
  const item = (await import('../../../server/mcp/tools/get_platform_batch_item')).default as any
  const retry = (await import('../../../server/mcp/tools/retry_platform_batch')).default as any
  const { z } = await import('zod')
  vi.stubGlobal('useRuntimeConfig', () => ({ filesDir: dir }))
  let failing = true
  upstream.mockImplementation(async (_url: string, init: any) => {
    const n = Number(new URLSearchParams(init.body).get('pageNum'))
    return failing && n === 2 ? { ok: false, status: 503, text: async () => '' } : response('applyGrid', [{ qymc: '合成多关系', relation: String(n), tyshxydm: uscc }], n, 2)
  })
  const wire = await submit.handler({ items: [{ query: { source: 'queryList', name: '合成', pageSize: 1 } }] })
  const receipt = wire.structuredContent
  expect(JSON.parse(wire.content[0].text)).toEqual(receipt)
  expect(z.object(submit.outputSchema).safeParse(receipt).success).toBe(true)
  expect(submit.enabled({ context: { mcpAuth: { writeAuthorized: false } } })).toBe(false)
  expect(retry.enabled({ context: { mcpAuth: { writeAuthorized: true } } })).toBe(true)
  await whenIdle()
  const a = (await status.handler({ batchId: receipt.batchId })).structuredContent
  const b = (await invoke('status', undefined, receipt.batchId)).body
  expect(a).toEqual(b)
  expect(z.object(status.outputSchema).safeParse(a).success).toBe(true)
  const individual = (await item.handler({ batchId: receipt.batchId, itemId: receipt.itemIds[0] })).structuredContent
  expect(individual).toEqual((await invoke('item', undefined, receipt.batchId, receipt.itemIds[0])).body)
  failing = false
  await retry.handler({ batchId: receipt.batchId, itemIds: receipt.itemIds }); await whenIdle()
  expect((await status.handler({ batchId: receipt.batchId })).structuredContent).toMatchObject({ completeness: 'complete', attempt: 2 })
})
it('credential echoes in otherwise valid query conditions are rejected before any task parameter is persisted', async () => {
  const before = db.$client.prepare('SELECT count(*) AS n FROM job').get()
  const response = await invoke('submit', { items: [{ query: { source: 'queryList', name: `合成${cookie}` } }] })
  expect(response.status).toBe(400)
  expect(db.$client.prepare('SELECT count(*) AS n FROM job').get()).toEqual(before)
  expect(JSON.stringify(response)).not.toContain('synthetic-batch-secret')
  expect(upstream).not.toHaveBeenCalled()
})
it('maximum item count is accepted while stable item ownership and unknown retry IDs remain isolated', async () => {
  upstream.mockImplementation(async () => response('applyGrid', []))
  const receipt = (await invoke('submit', { items: Array.from({ length: 50 }, () => ({ query: { source: 'queryList', name: '合成', pageSize: 1 } })), limits: { maxResultBytes: 65536 } })).body as any
  await whenIdle()
  const batch = (await invoke('status', undefined, receipt.batchId)).body as any
  expect(batch).toMatchObject({ state: 'done', progress: { done: 50, total: 50 }, completeness: 'complete' })
  expect(new Set(batch.itemIds).size).toBe(50)
  expect(Buffer.byteLength(JSON.stringify(batch))).toBeLessThanOrEqual(65536)
  expect((await invoke('item', undefined, receipt.batchId, '01M56FKFXYBPSBEN8FYTDH2JV4')).status).toBe(404)
  expect((await invoke('retry', { itemIds: ['01M56FKFXYBPSBEN8FYTDH2JV4'] }, receipt.batchId)).status).toBe(409)
  expect((await invoke('retry', { itemIds: [receipt.itemIds[0]], cookie }, receipt.batchId)).status).toBe(400)
})
it('missing submission credentials leave all title ranges not queried and an explicit retry succeeds after maintenance', async () => {
  updateCredential('miitCookie', null, { db })
  const receipt = (await invoke('submit', { items: [{ query: { source: 'queryBusList', name: '合成', pageSize: 1 } }] })).body as any
  await whenIdle()
  const before = (await invoke('status', undefined, receipt.batchId)).body as any
  expect(before.items[0]).toMatchObject({ status: 'not_queried', completeness: 'partial' })
  expect(before.items[0].unfinished.map((p: any) => [p.rdjb, p.page])).toEqual([['1', 1], ['2', 1], ['3', 1]])
  expect(upstream).not.toHaveBeenCalled()
  updateCredential('miitCookie', cookie, { db })
  upstream.mockImplementation(async () => response('businessGrid', []))
  await invoke('retry', { itemIds: receipt.itemIds }, receipt.batchId); await whenIdle()
  const after = (await invoke('status', undefined, receipt.batchId)).body as any
  expect(after).toMatchObject({ state: 'done', completeness: 'complete', attempt: 2 })
  expect(after.items[0].status).toBe('no_record')
  expect(after.items[0].segments[0]).toEqual(before.items[0].segments[0])
})
it('active retry is rejected and repeated authentication failures stop at the explicit ten-attempt limit', async () => {
  let release!: () => void
  upstream.mockImplementationOnce(async () => { await new Promise<void>(r => { release = r }); return { ok: false, status: 401, text: async () => '' } })
  upstream.mockImplementation(async () => ({ ok: false, status: 401, text: async () => '' }))
  const receipt = (await invoke('submit', { items: [{ query: { source: 'queryList', name: '合成' } }] })).body as any
  await vi.waitFor(() => expect(release).toBeTypeOf('function'))
  expect((await invoke('retry', { itemIds: receipt.itemIds }, receipt.batchId)).status).toBe(409)
  release(); await whenIdle()
  for (let attempt = 2; attempt <= 10; attempt++) {
    expect((await invoke('retry', { itemIds: receipt.itemIds }, receipt.batchId)).status).toBe(202)
    await whenIdle()
  }
  expect((await invoke('retry', { itemIds: receipt.itemIds }, receipt.batchId)).status).toBe(409)
  expect(upstream).toHaveBeenCalledTimes(10)
  expect(((await invoke('status', undefined, receipt.batchId)).body as any).attempt).toBe(10)
})
it('OpenAPI and MCP discovery expose bounded batch contracts and resolve shared single-query schemas', async () => {
  const captured: any[] = []
  vi.stubGlobal('defineRouteMeta', (meta: any) => captured.push(meta.openAPI))
  vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
  await import('../../../server/api/platform/query.post')
  await import('../../../server/api/platform/batches/index.post')
  await import('../../../server/api/platform/batches/[batchId].get')
  await import('../../../server/api/platform/batches/[batchId]/retry.post')
  await import('../../../server/api/platform/batches/[batchId]/items/[itemId].get')
  const single = captured.find(m => m.requestBody?.content?.['application/json']?.schema?.properties?.source)
  const submit = captured.find(m => m.requestBody?.content?.['application/json']?.schema?.properties?.items)
  const queryRef = submit.requestBody.content['application/json'].schema.properties.items.items.properties.query.$ref
  expect(queryRef).toBe('#/paths/~1api~1platform~1query/post/requestBody/content/application~1json/schema')
  expect(single.requestBody.content['application/json'].schema.properties.source.enum).toEqual(['queryList', 'businessList', 'queryBusList'])
  expect(submit.security).toEqual([{ bearerAuth: [] }])
  expect(submit.requestBody.content['application/json'].schema.properties.items.maxItems).toBe(50)
  expect(submit.requestBody.content['application/json'].schema.properties.limits.properties.maxResultBytes.maximum).toBe(8388608)
  expect(captured).toHaveLength(5)
  const { platformQueryCapabilities } = await import('../../../lib/platform/live-query')
  expect(platformQueryCapabilities.batch).toMatchObject({ available: true, maxItems: 50, maxAttempts: 10 })
  const { platformQueryRpcError } = await import('../../../server/utils/mcp-platform-query')
  for (const [name, args] of [
    ['get_platform_batch', { batchId: '01M56FKFXYBPSBEN8FYTDH2JV4', cookie }],
    ['get_platform_batch_item', { batchId: '01M56FKFXYBPSBEN8FYTDH2JV4', itemId: '01M56FKFXYBPSBEN8FYTDH2JV4', cookie }],
    ['retry_platform_batch', { batchId: '01M56FKFXYBPSBEN8FYTDH2JV4', itemIds: ['01M56FKFXYBPSBEN8FYTDH2JV4'], cookie }],
  ] as const) expect(platformQueryRpcError({ method: 'tools/call', params: { name, arguments: args } })?.status).toBe(400)
  expect(platformQueryRpcError({ method: 'tools/call', params: { name: 'toString', arguments: {} } })).toBeNull()
})
it('retry preserves recognized stop-on-failure and business authentication stop across every unfinished title', async () => {
  let mode = 'initial'
  const seen: string[] = []
  upstream.mockImplementation(async (url: string, init: any) => {
    const p = new URLSearchParams(init.body), title = p.get('rdjb'), page = Number(p.get('pageNum'))
    const recognized = url.includes('/queryBusList'); seen.push(`${recognized ? 'recognized' : 'business'}:${title}:${page}`)
    if (mode === 'initial') return { ok: false, status: 503, text: async () => '' }
    if (recognized) return { ok: false, status: 503, text: async () => '' }
    if (page === 2) return { ok: false, status: 401, text: async () => '' }
    return response('businessListGrid', [{ qymc: '合成关系' }], page, 2)
  })
  const receipt = (await invoke('submit', { items: [{ query: { source: 'queryBusList', name: '合成', pageSize: 1 } }, { query: { source: 'businessList', uscc, rdjb: 'all', pageSize: 1 } }] })).body as any
  await whenIdle(); mode = 'retry'; seen.length = 0
  await invoke('retry', { itemIds: receipt.itemIds }, receipt.batchId); await whenIdle()
  expect(seen).toEqual(['recognized:1:1', 'business:1:1', 'business:1:2'])
  const result = (await invoke('status', undefined, receipt.batchId)).body as any
  expect(result.items[0].unfinished.map((p: any) => [p.rdjb, p.page])).toEqual([['1', 1], ['2', 1], ['3', 1]])
  expect(result.items[1].unfinished.map((p: any) => [p.rdjb, p.page])).toEqual([['1', 2], ['2', 1], ['3', 1]])
})
it('retry shares the original item request bound across unfinished titles and retains untouched ranges', async () => {
  upstream.mockImplementation(async () => response('businessGrid', []))
  const receipt = (await invoke('submit', { items: [{ query: { source: 'queryBusList', name: '合成', pageSize: 1, maxRequests: 1 } }] })).body as any
  await whenIdle(); upstream.mockClear()
  await invoke('retry', { itemIds: receipt.itemIds }, receipt.batchId); await whenIdle()
  const batch = (await invoke('status', undefined, receipt.batchId)).body as any
  expect(upstream).toHaveBeenCalledTimes(1)
  expect(batch.items[0].unfinished).toEqual([{ source: 'queryBusList', rdjb: '3', page: 1 }])
  expect(batch).toMatchObject({ state: 'failed', completeness: 'partial', attempt: 2 })
})
it('short credential components do not reject fixed numeric bounds or title selectors as secret echoes', async () => {
  updateCredential('miitCookie', 'session=1', { db })
  upstream.mockImplementation(async () => response('businessListGrid', []))
  const submitted = await invoke('submit', { items: [{ query: { source: 'businessList', uscc, rdjb: '1', pageSize: 1 } }] })
  expect(submitted.status).toBe(202); await whenIdle()
  const batch = (await invoke('status', undefined, (submitted.body as any).batchId)).body as any
  expect(batch).toMatchObject({ state: 'done', completeness: 'complete', attempt: 1 })
  expect(batch.items[0].segments[0]).toMatchObject({ status: 'no_record', titleScope: { rdjb: ['1'] } })
})

// ---------------------------------------------------------------------------
// B-02（#120：平台局部重试保留已完成/部分结果）
//
// 批次只经**公开 submit** 产生（合成甲 第 2 页 503 停在未完成第 2 页，合成乙 一次完成），
// 重试只经**公开 retry** 发起，断言只读公开 status。失败由外部条件造成（网关 503、
// 连接被掐断），不往业务代码里塞故障，也不手写 job 表来"造证据"。
// ---------------------------------------------------------------------------
const evidenceItems = (batch: any) => [batch.items[0], batch.items[1]]

/** 一次真实的"半截"批次：合成甲 第 2 页 503，合成乙 完成。`interrupted` 由用例控制。 */
async function seedPartialBatch() {
  const state = { interrupted: true }
  upstream.mockImplementation(async (_url: string, init: any) => {
    const p = new URLSearchParams(init.body); const n = Number(p.get('pageNum'))
    if (p.get('qymc') === '合成甲' && n === 2 && state.interrupted) return { ok: false, status: 503, text: async () => '' }
    return response('applyGrid', [{ qymc: '合成企业', tyshxydm: uscc, relation: String(n) }], n, p.get('qymc') === '合成甲' ? 2 : 1)
  })
  const receipt = (await invoke('submit', { items: [{ query: { source: 'queryList', name: '合成甲', pageSize: 1 } }, { query: { source: 'queryList', name: '合成乙', pageSize: 1 } }] })).body as any
  await whenIdle()
  const prior = (await invoke('status', undefined, receipt.batchId)).body as any
  expect(prior).toMatchObject({ state: 'failed', completeness: 'partial', progress: { done: 1, total: 2 }, attempt: 1 })
  expect(prior.items[0]).toMatchObject({ completeness: 'partial', unfinished: [{ source: 'queryList', rdjb: null, page: 2 }] })
  expect(prior.items[1]).toMatchObject({ completeness: 'complete' })
  upstream.mockReset()
  return { receipt, prior, state }
}

it('B-02: an auth_failed or safety_limit stop is checkpointed by the same execution, not dropped at the break', async () => {
  // runPlatformLiveQuery returns the whole segment including the failing page; runBatch admits
  // it (usage/unfinished/persist) before the auth/safety break. Public submit + status only.
  const failing: [string, Record<string, string>[], number][] = [
    // page 2 answers 401 -> the returned segment carries [success, auth_failed]
    ['auth', [{ qymc: '合成', tyshxydm: uscc }], 2],
    // maxRequests=1 with a page that declares 2 rows -> safety_limit on the same segment
    ['safety', [{ qymc: '合成', tyshxydm: uscc }], 2],
  ]
  for (const [label, rows, total] of failing) {
    upstream.mockReset()
    upstream.mockImplementation(async (_url: string, init: any) => {
      const n = Number(new URLSearchParams(init.body).get('pageNum'))
      if (label === 'auth' && n === 2) return { ok: false, status: 401, text: async () => '' }
      return response('applyGrid', rows, n, total)
    })
    const query = label === 'auth' ? { source: 'queryList' as const, name: '合成', pageSize: 1 } : { source: 'queryList' as const, name: '合成', pageSize: 1, maxRequests: 1 }
    const receipt = (await invoke('submit', { items: [{ query }] })).body as any
    await whenIdle()
    const after = (await invoke('status', undefined, receipt.batchId)).body as any
    expect(after.state).toBe('failed')
    expect(after.attempt).toBe(1)
    const segment = after.items[0].segments[0]
    if (label === 'auth') expect(segment.pages.map((p: any) => p.status)).toEqual(['success', 'auth_failed'])
    else expect(segment.error?.code).toBe('safety_limit')
    // Persisted evidence is what the previous checkpoint would have lost.
    expect((await invoke('item', undefined, receipt.batchId, receipt.itemIds[0])).body).toMatchObject({ itemId: receipt.itemIds[0] })
  }
})

it('B-02: a retry whose gateway keeps failing keeps the completed item and the original partial evidence', async () => {
  const { receipt, prior, state } = await seedPartialBatch()
  // 重试照常发起，但网关对补查页继续 503 —— 这一项仍然没有新产出。
  upstream.mockImplementation(async () => ({ ok: false, status: 503, text: async () => '' }))
  expect((await invoke('retry', { itemIds: [receipt.itemIds[0]] }, receipt.batchId)).status).toBe(202)
  await whenIdle()
  const after = (await invoke('status', undefined, receipt.batchId)).body as any
  expect(after).toMatchObject({ state: 'failed', completeness: 'partial', progress: { done: 1, total: 2 }, attempt: 2 })
  // 已完成项逐字段不变；未完成项保留原第 1 页，并只追加一次真实的失败记录。
  expect(after.items[1]).toEqual(prior.items[1])
  expect(after.items[0].segments[0]).toEqual(prior.items[0].segments[0])
  expect(after.items[0].segments).toHaveLength(2)
  expect(after.items[0].unfinished).toEqual([{ source: 'queryList', rdjb: null, page: 2 }])
  state.interrupted = false
})

it('B-02: the ten-execution budget still ends a batch whose retries keep failing', async () => {
  const { receipt } = await seedPartialBatch()
  upstream.mockImplementation(async () => ({ ok: false, status: 503, text: async () => '' }))
  for (let attempt = 2; attempt <= MAX_BATCH_ATTEMPTS; attempt++) {
    expect((await invoke('retry', { itemIds: [receipt.itemIds[0]] }, receipt.batchId)).status).toBe(202)
    await whenIdle()
    expect(((await invoke('status', undefined, receipt.batchId)).body as any).attempt).toBe(attempt)
  }
  expect((await invoke('retry', { itemIds: [receipt.itemIds[0]] }, receipt.batchId)).status).toBe(409)
})
