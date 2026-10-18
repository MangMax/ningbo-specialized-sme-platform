import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { useDb } from '../db/client'
import { updateCredential } from '../server/utils/credential-state'

const dir = mkdtempSync(join(tmpdir(), 'platform-live-'))
const db = useDb({ dbPath: join(dir, 'test.db') })
const cookie = 'session=synthetic-query-secret'
let body: unknown
let rest: (event: any) => Promise<any>
let tool: { handler: (input: any) => Promise<any> }
const nativeFetch = globalThis.fetch
const fetcher = vi.fn()
function page(rows: Record<string, string>[], total = rows.length, number = 1) {
  return JSON.stringify({ zrarData: { grid: { applyGrid: { pageSet: rows, maxCount: total, page: number, pageSize: 1 } } } })
}
const response = (text: string, status = 200) => ({ ok: status === 200, status, text: async () => text })
async function query(input: unknown) { body = input; return rest({}) }
beforeAll(async () => {
  process.env.NUXT_DB_PATH = join(dir, 'test.db')
  vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
  vi.stubGlobal('readBody', async () => body)
  vi.stubGlobal('setHeader', vi.fn())
  vi.stubGlobal('setResponseStatus', vi.fn())
  vi.doMock('@nuxtjs/mcp-toolkit/server', () => ({ defineMcpTool: (definition: unknown) => definition }))
  rest = (await import('../server/api/platform/query.post')).default as any
  const definition = (await import('../server/mcp/tools/query_platform')).default as any
  tool = { handler: async input => {
    const wire = await definition.handler(input)
    expect(wire.structuredContent).toBeDefined()
    expect(JSON.parse(wire.content[0].text)).toEqual(wire.structuredContent)
    return wire.structuredContent
  } }
})
beforeEach(() => {
  updateCredential('miitCookie', cookie, { db })
  fetcher.mockReset()
  vi.stubGlobal('fetch', fetcher)
})
afterAll(() => { vi.unstubAllGlobals(); delete process.env.NUXT_DB_PATH; rmSync(dir, { recursive: true, force: true }) })
it('REST and MCP preserve every paginated relation for a name and code without writing SQLite', async () => {
  const before = db.$client.serialize()
  const rows = [{ qymc: '合成新名称', tyshxydm: '91330211255994457P' }, { qymc: '合成曾用名', tyshxydm: '91330211255994457P' }]
  fetcher.mockImplementation(async (_: string, init: any) => {
    expect(init.headers.Cookie).toBe(cookie)
    const params = new URLSearchParams(init.body)
    expect(params.get('qymc')).toBe('合成')
    expect(params.get('tyshxydm')).toBe('91330211255994457P')
    expect(params.has('sqsj')).toBe(false)
    const number = Number(params.get('pageNum'))
    return response(page([rows[number - 1]!], 2, number))
  })
  const input = { source: 'queryList', name: '合成', uscc: '91330211255994457P' }
  const a = await query(input)
  const b = await tool.handler(input)
  expect(a).toMatchObject({ source: 'queryList', status: 'success', rows, fetchedCount: 2, declaredTotal: 2, completeness: 'complete', unfinished: [], effectiveConditions: { name: '合成', uscc: '91330211255994457P', combination: 'and' } })
  expect(a.pages.map((p: any) => p.page)).toEqual([1, 2])
  expect({ ...a, queriedAt: null, completedAt: null }).toEqual({ ...b, queriedAt: null, completedAt: null })
  expect(db.$client.serialize()).toEqual(before)
})
it.each([
  ['empty', () => response(page([], 0)), 'no_record', null],
  ['login page', () => response('<form id="loginForm"><input name="password"></form>'), 'auth_failed', 'auth_failed'],
  ['expired envelope', () => response('{"statusCode":"301","message":"登录超时"}'), 'auth_failed', 'auth_failed'],
  ['unauthorized', () => response(cookie, 401), 'auth_failed', 'auth_failed'],
  ['forbidden', () => response(cookie, 403), 'auth_failed', 'auth_failed'],
  ['upstream', () => response(cookie, 503), 'failed', 'upstream_failed'],
  ['rate limit', () => response(cookie, 429), 'failed', 'rate_limited'],
  ['timeout', () => { throw new DOMException(cookie, 'TimeoutError') }, 'failed', 'timeout'],
  ['network', () => { throw new Error(cookie) }, 'failed', 'upstream_failed'],
  ['malformed grid', () => response('{"zrarData":{"grid":{"applyGrid":{}}}}'), 'failed', 'upstream_failed'],
  ['secret field', () => response(page([{ qymc: '合成', sessionToken: 'unrelated-private-value' }])), 'failed', 'sensitive_response'],
  ['secret echo', () => response(page([{ qymc: 'synthetic-query-secret' }])), 'failed', 'sensitive_response'],
] as const)('distinguishes %s without leaking credentials', async (_label, upstream, status, code) => {
  fetcher.mockImplementation(upstream)
  for (const invoke of [query, tool.handler]) {
    const result = await invoke({ source: 'queryList', name: '合成' })
    expect(result.status).toBe(status)
    expect(result.error?.code ?? null).toBe(code)
    expect(result.completeness).toBe(status === 'no_record' ? 'complete' : 'partial')
    expect(result.rows).toEqual([])
    expect(JSON.stringify(result)).not.toContain('synthetic-query-secret')
    expect(JSON.stringify(result)).not.toContain('unrelated-private-value')
  }
  expect(fetcher).toHaveBeenCalledTimes(2)
})
it('keeps page one and identifies failed page two for a continuation', async () => {
  fetcher.mockResolvedValueOnce(response(page([{ qymc: '第一页' }], 2))).mockResolvedValueOnce(response(cookie, 503))
  const result = await query({ source: 'queryList', name: '合成' })
  expect(result).toMatchObject({ status: 'partial', rows: [{ qymc: '第一页' }], declaredTotal: 2, unfinished: [{ source: 'queryList', rdjb: null, page: 2 }], error: { code: 'upstream_failed' } })
  fetcher.mockResolvedValue(response(page([{ qymc: '第二页' }], 2, 2)))
  const resumed = await query({ source: 'queryList', name: '合成', startPage: 2, pageSize: 1 })
  expect(resumed).toMatchObject({ status: 'success', completeness: 'complete', fullRange: false, rows: [{ qymc: '第二页' }] })
})
it.each([{ maxRequests: 1 }, { maxRows: 1 }])('reports safety truncation and the next page for %j', async limits => {
  fetcher.mockResolvedValue(response(page([{ qymc: '第一页' }], 2)))
  const result = await query({ source: 'queryList', name: '合成', ...limits })
  expect(result).toMatchObject({ status: 'partial', fetchedCount: 1, completeness: 'partial', error: { code: 'safety_limit' }, unfinished: [{ page: 2 }] })
})
it('reports an unknown total and continues to a valid empty page', async () => {
  const raw = JSON.parse(page([{ qymc: '未知总数' }]))
  delete raw.zrarData.grid.applyGrid.maxCount
  fetcher.mockResolvedValueOnce(response(JSON.stringify(raw))).mockResolvedValueOnce(response('{"zrarData":{"grid":{"applyGrid":{"page":2,"pageSet":[]}}}}'))
  expect(await query({ source: 'queryList', uscc: '91330211255994457P' })).toMatchObject({ status: 'success', declaredTotal: null, fetchedCount: 1, completeness: 'complete' })
})
it.each([
  {}, { source: 'queryList' }, { source: 'queryList', name: ' ' }, { source: 'queryList', uscc: 'bad' },
  { source: 'queryList', name: '合成', cookie }, { source: 'queryList', name: '合成', rdjb: '1' },
  { source: 'queryList', name: '合成', maxRequests: 101 }, { source: 'queryList', name: '合成', sqsj: '2025' },
  { source: 'businessList', name: '合成' }, { source: 'queryBusList', name: '合成' },
])('rejects unsupported or invalid input without an upstream call (case %#)', async input => {
  expect(await query(input)).toMatchObject({ error: { code: expect.stringMatching(/invalid_input|unsupported_source/) } })
  await expect(tool.handler(input)).rejects.toMatchObject({ statusCode: 400 })
  expect(fetcher).not.toHaveBeenCalled()
})
it('missing credentials are not queried and do not fall back to a real environment', async () => {
  updateCredential('miitCookie', null, { db })
  const previous = process.env.MIIT_COOKIE
  process.env.MIIT_COOKIE = ''
  try {
    expect(await query({ source: 'queryList', name: '合成' })).toMatchObject({ status: 'not_queried', completeness: 'not_queried', error: { code: 'credential_unavailable' }, unfinished: [{ page: 1 }] })
    expect(fetcher).not.toHaveBeenCalled()
  } finally { if (previous === undefined) delete process.env.MIIT_COOKIE; else process.env.MIIT_COOKIE = previous }
})
it('enforces the time budget while waiting for the shared global request slots', async () => {
  const { queryPlatformSlots } = await import('../lib/platform/client')
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let entered = 0
  fetcher.mockImplementation(async () => { entered++; await gate; return response(page([], 0)) })
  const legacy = [1, 2].map(() => queryPlatformSlots({ uscc: '91330211255994457P', cookie, retries: 0 }, [{ interface: 'apply_list' }]))
  await vi.waitFor(() => expect(entered).toBe(2))
  const pending = query({ source: 'queryList', name: '合成', maxDurationMs: 10 })
  try {
    const result = await Promise.race([pending, new Promise(resolve => setTimeout(() => resolve({ status: 'hung' }), 60))])
    expect(result).toMatchObject({ status: 'failed', error: { code: 'timeout' } })
    expect(entered).toBe(2)
  } finally { release(); await Promise.all([...legacy, pending]) }
})
it('all single queries and legacy retry backoff share at most two platform slots', async () => {
  const { queryPlatformSlots } = await import('../lib/platform/client')
  let releaseBackoff!: () => void
  let backoffStarted!: () => void
  const backoff = new Promise<void>(resolve => { releaseBackoff = resolve })
  const sleeping = new Promise<void>(resolve => { backoffStarted = resolve })
  let attempts = 0
  const legacy = queryPlatformSlots({ uscc: '91330211255994457P', cookie, retries: 1, fetchImpl: async () => response(page([], 0), ++attempts === 1 ? 503 : 200), sleep: async () => { backoffStarted(); await backoff } }, [{ interface: 'apply_list' }])
  await sleeping
  let active = 0
  let peak = 0
  fetcher.mockImplementation(async () => {
    active++; peak = Math.max(active, peak)
    await new Promise(resolve => setTimeout(resolve, 10))
    active--
    return response(page([], 0))
  })
  try {
    const results = await Promise.all(Array.from({ length: 5 }, () => query({ source: 'queryList', name: '合成' })))
    expect(results.map(r => r.status)).toEqual(Array(5).fill('no_record'))
    expect(peak).toBe(1)
  } finally { releaseBackoff(); await legacy }
  expect(attempts).toBe(2)
  peak = 0
  await Promise.all(Array.from({ length: 5 }, () => tool.handler({ source: 'queryList', name: '合成' })))
  expect(peak).toBe(2)
})
it('keeps the server credential snapshot for all pages and excludes unrelated envelope account data', async () => {
  let n = 0
  fetcher.mockImplementation(async (_url: string, init: any) => {
    expect(init.headers.Cookie).toBe(cookie)
    updateCredential('miitCookie', 'session=synthetic-next-account', { db })
    const raw = JSON.parse(page([{ qymc: '合成' }], 2, ++n))
    raw.account = { token: 'private-envelope-token', username: 'private-account' }
    return response(JSON.stringify(raw))
  })
  const result = await query({ source: 'queryList', name: '合成' })
  expect(result).toMatchObject({ status: 'success', fetchedCount: 2 })
  expect(JSON.stringify(result)).not.toMatch(/private-envelope|private-account|synthetic-next-account/)
})
it('rejects contradictory pagination rather than claiming complete', async () => {
  fetcher.mockResolvedValueOnce(response(page([{ qymc: '合成' }], 3))).mockResolvedValueOnce(response(page([], 3, 2)))
  expect(await query({ source: 'queryList', name: '合成' })).toMatchObject({ status: 'partial', error: { code: 'invalid_response' }, unfinished: [{ page: 2 }] })
})
it('public capabilities describe source differences and strict RPC validation rejects unknown filters', async () => {
  const capabilities = (await import('../server/mcp/tools/get_platform_capabilities')).default as any
  const cap = await capabilities.handler()
  expect(cap.sources.queryList).toMatchObject({ available: true, conditions: ['name', 'uscc'], titleSelection: false })
  expect(cap.sources.businessList).toMatchObject({ available: true, conditions: ['uscc'] })
  expect(cap.limits.maxConcurrentRequests).toBe(2)
  const route = (await import('../server/api/platform/capabilities.get')).default as any
  expect(route({})).toEqual(cap)
  const { platformQueryRpcError } = await import('../server/utils/mcp-platform-query')
  for (const args of [{ source: 'queryList', name: '合成', cookie }, { source: 'queryList', name: '合成', sqsj: '2025' }]) {
    const rejected = platformQueryRpcError({ jsonrpc: '2.0', method: 'tools/call', id: 1, params: { name: 'query_platform', arguments: args } })!
    expect(rejected.status).toBe(400)
    expect(await rejected.text()).not.toContain('synthetic-query-secret')
  }
})
it('REST query works through HTTP and responds with no-store', async () => {
  const { startHttpFixture } = await import('./helpers/http-fixture')
  const service = await startHttpFixture({ routes: { '/api/platform/query': async req => ({ status: 200, body: await query(req.body) }) } })
  fetcher.mockResolvedValue(response(page([], 0)))
  try {
    // Native fetch bypasses only the mocked upstream boundary in this one HTTP caller.
    const r = await nativeFetch(`${service.baseUrl}/api/platform/query`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source: 'queryList', name: '合成' }) })
    expect(await r.json()).toMatchObject({ status: 'no_record', completeness: 'complete' })
    expect(vi.mocked(setHeader)).toHaveBeenCalledWith(expect.anything(), 'Cache-Control', 'no-store')
  } finally { await service.close() }
})
it('deadline aborts an active upstream request without claiming valid zero records', async () => {
  fetcher.mockImplementation(async (_url: string, init: any) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })
  }))
  expect(await query({ source: 'queryList', name: '合成', maxDurationMs: 20 })).toMatchObject({ status: 'failed', completeness: 'partial', error: { code: 'timeout' }, unfinished: [{ page: 1 }] })
})
it('record cap retains whole pages and returns the overflowing page for retry', async () => {
  fetcher.mockResolvedValueOnce(response(page([{ qymc: '合成1' }, { qymc: '合成2' }], 4))).mockResolvedValueOnce(response(page([{ qymc: '合成3' }, { qymc: '合成4' }], 4, 2)))
  expect(await query({ source: 'queryList', name: '合成', maxRows: 3 })).toMatchObject({ status: 'partial', fetchedCount: 2, error: { code: 'safety_limit' }, unfinished: [{ page: 2 }], rows: [{ qymc: '合成1' }, { qymc: '合成2' }] })
})
it.each(['synthetic-query-secret', 'synthetic-query-%73ecret', 'session=synthetic-query-secret'])('blocks credential wire-form echoes (case %#)', async value => {
  fetcher.mockResolvedValue(response(page([{ qymc: value }])))
  expect(await query({ source: 'queryList', name: '合成' })).toMatchObject({ status: 'failed', error: { code: 'sensitive_response' }, rows: [] })
})
it('short credential components do not corrupt fixed public contract fields', async () => {
  updateCredential('miitCookie', 'session=and', { db })
  fetcher.mockResolvedValue(response(page([{ qymc: '合成' }])))
  expect(await query({ source: 'queryList', name: '合成' })).toMatchObject({ source: 'queryList', status: 'success', effectiveConditions: { combination: 'and' }, completeness: 'complete' })
})
