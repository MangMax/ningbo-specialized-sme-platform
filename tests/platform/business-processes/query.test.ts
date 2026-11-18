import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initializeDb } from '../../../db/client'
import { updateCredential } from '../../../layers/core/server/utils/credential-state'

const dir = mkdtempSync(join(tmpdir(), 'platform-business-'))
const db = initializeDb({ create: true,  dbPath: join(dir, 'test.db') })
const cookie = 'session=synthetic-business-secret'
const uscc = '91330211255994457P'
const fetcher = vi.fn()
let body: unknown
let rest: (event: any) => Promise<any>
let tool: (input: any) => Promise<any>
const response = (text: string, status = 200) => ({ ok: status === 200, status, text: async () => text })
function page(rows: Record<string, string>[], total: number | null = rows.length, n = 1, pageSize?: number) {
  return `<html><tbody></tbody><footer>共 0 条</footer><script>(function(data){} )(${JSON.stringify({ zrarData: { grid: { businessListGrid: { pageSet: rows, ...(total === null ? {} : { maxCount: total }), page: n, ...(pageSize === undefined ? {} : { pageSize }) } } } })});</script></html>`
}
async function query(input: unknown) { body = input; return rest({}) }
const input = { source: 'businessList', uscc, rdjb: 'all' }
beforeAll(async () => {
  process.env.NUXT_DB_PATH = join(dir, 'test.db')
  vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
  vi.stubGlobal('readBody', async () => body)
  vi.stubGlobal('setHeader', vi.fn())
  vi.stubGlobal('setResponseStatus', vi.fn())
  vi.doMock('@nuxtjs/mcp-toolkit/server', () => ({ defineMcpTool: (definition: unknown) => definition }))
  rest = (await import('../../../server/api/platform/query.post')).default as any
  const definition = (await import('../../../server/mcp/tools/query_platform')).default as any
  tool = async args => {
    const wire = await definition.handler(args)
    expect(JSON.parse(wire.content[0].text)).toEqual(wire.structuredContent)
    return wire.structuredContent
  }
})
beforeEach(() => {
  updateCredential('sme-roster.miitCookie', cookie, { db })
  fetcher.mockReset()
  vi.stubGlobal('fetch', fetcher)
})
afterAll(() => { vi.unstubAllGlobals(); delete process.env.NUXT_DB_PATH; rmSync(dir, { recursive: true, force: true }) })
it('REST and MCP preserve all Little Giant relationships across three titles without business writes', async () => {
  const before = db.$client.serialize()
  const rows = Array.from({ length: 6 }, (_, i) => ({ qymc: i < 3 ? '合成曾用名' : '合成现名', tyshxydm: uscc, relationId: String(i) }))
  fetcher.mockImplementation(async (url: string, init: any) => {
    expect(url).toContain('/ZjtxxjrBusInfoManageBLH/businessList')
    expect(init.headers.Cookie).toBe(cookie)
    const p = new URLSearchParams(init.body)
    expect(p.get('tyshxydm')).toBe(uscc)
    expect(p.has('qymc')).toBe(false)
    expect([...p.keys()].sort()).toEqual(['numPerPage', 'pageNum', 'rdjb', 'tyshxydm'])
    const n = Number(p.get('pageNum'))
    return response(p.get('rdjb') === '3' ? page(rows.slice((n - 1) * 3, n * 3), 6, n) : page([], 0))
  })
  const a = await query({ ...input, pageSize: 3 })
  const b = await tool({ ...input, pageSize: 3 })
  expect(a).toMatchObject({ source: 'businessList', status: 'success', rows, fetchedCount: 6, declaredTotal: 6, completeness: 'complete', titleScope: { mode: 'selected', rdjb: ['1', '2', '3'] }, unfinished: [], effectiveConditions: { uscc, combination: 'and' } })
  expect(a.pages.map((p: any) => [p.rdjb, p.page, p.fetchedCount])).toEqual([['1', 1, 0], ['2', 1, 0], ['3', 1, 3], ['3', 2, 3]])
  expect({ ...a, queriedAt: null, completedAt: null }).toEqual({ ...b, queriedAt: null, completedAt: null })
  expect(db.$client.serialize().equals(before), 'database bytes remain unchanged').toBe(true)
})
it.each(['1', '2', '3'])('single title %s has its own scope and a valid zero says nothing about other titles', async rdjb => {
  fetcher.mockResolvedValue(response(page([], 0)))
  for (const invoke of [query, tool]) {
    expect(await invoke({ ...input, rdjb })).toMatchObject({ status: 'no_record', declaredTotal: 0, completeness: 'complete', titleScope: { mode: 'selected', rdjb: [rdjb] }, pages: [{ source: 'businessList', rdjb, page: 1 }] })
  }
  expect(fetcher).toHaveBeenCalledTimes(2)
  for (const [, init] of fetcher.mock.calls) expect(new URLSearchParams(init.body).get('rdjb')).toBe(rdjb)
})
it('a failed title page retains prior rows and still queries the Little Giant title', async () => {
  fetcher.mockImplementation(async (_url: string, init: any) => {
    const p = new URLSearchParams(init.body), title = p.get('rdjb'), n = Number(p.get('pageNum'))
    if (title === '2' && n === 2) return response(cookie, 503)
    return response(title === '2' ? page([{ qymc: '合成曾用名' }], 2) : title === '3' ? page([{ qymc: '合成小巨人' }]) : page([]))
  })
  for (const invoke of [query, tool]) {
    const r = await invoke({ ...input, pageSize: 1 })
    expect(r).toMatchObject({ status: 'partial', completeness: 'partial', declaredTotal: 3, rows: [{ qymc: '合成曾用名' }, { qymc: '合成小巨人' }], unfinished: [{ source: 'businessList', rdjb: '2', page: 2 }], error: { code: 'upstream_failed' } })
    expect(r.pages.map((p: any) => [p.rdjb, p.page, p.status])).toEqual([['1', 1, 'success'], ['2', 1, 'success'], ['2', 2, 'failed'], ['3', 1, 'success']])
    expect(JSON.stringify(r)).not.toContain('synthetic-business-secret')
  }
  fetcher.mockResolvedValue(response(page([{ qymc: '续页' }], 2, 2, 1)))
  expect(await query({ ...input, rdjb: '2', startPage: 2, pageSize: 1 })).toMatchObject({ status: 'success', fullRange: false, completeness: 'complete', rows: [{ qymc: '续页' }], unfinished: [] })
})
it.each([
  ['login page', () => response('<form id="loginForm"><input name="password"></form>'), 'auth_failed', true],
  ['unauthorized', () => response(cookie, 401), 'auth_failed', true],
  ['forbidden', () => response(cookie, 403), 'auth_failed', true],
  ['expired envelope', () => response('{"statusCode":"301","message":"登录超时"}'), 'auth_failed', true],
  ['upstream', () => response(cookie, 503), 'upstream_failed', false],
  ['rate limit', () => response(cookie, 429), 'rate_limited', false],
  ['timeout', () => { throw new DOMException(cookie, 'TimeoutError') }, 'timeout', false],
  ['malformed grid', () => response('{}'), 'upstream_failed', false],
  ['credential echo', () => response(page([{ qymc: 'synthetic-business-%73ecret' }])), 'sensitive_response', false],
  ['account field', () => response(page([{ qymc: '合成', sessionToken: 'synthetic-private-account' }])), 'sensitive_response', false],
] as const)('%s never becomes a valid zero or exposes credentials', async (_label, upstream, code, auth) => {
  fetcher.mockImplementation(upstream)
  for (const invoke of [query, tool]) {
    const r = await invoke(input)
    expect(r).toMatchObject({ status: auth ? 'auth_failed' : 'failed', completeness: 'partial', rows: [], declaredTotal: null, error: { code }, unfinished: ['1', '2', '3'].map(rdjb => ({ source: 'businessList', rdjb, page: 1 })) })
    expect(r.pages).toHaveLength(auth ? 1 : 3)
    expect(JSON.stringify(r)).not.toMatch(/synthetic-business|synthetic-private-account/)
  }
  expect(fetcher).toHaveBeenCalledTimes(auth ? 2 : 6)
})
it.each([
  { source: 'businessList', uscc }, { ...input, uscc: undefined }, { ...input, uscc: 'bad' },
  { ...input, name: '合成' }, { ...input, qymc: '合成' }, { ...input, cookie }, { ...input, rdjb: 1 },
  { ...input, rdjb: '4' }, { ...input, rdjb: ['1', '2', '3'] }, { ...input, sqsj: '2026' },
  { ...input, startPage: 2 }, { source: 'queryList', uscc, rdjb: '3' },
  { ...input, sqsj: '2024/02/01 - 2024/02/29' }, { ...input, rddqrq: '2027' },
  { ...input, whpcyear: '2023', whpc: '2' }, { ...input, szq: '33028100' },
  { ...input, orderField: 'qymc', orderDirection: 'asc' },
])('REST MCP and raw RPC reject unsupported conditions before upstream access (case %#)', async args => {
  expect(await query(args)).toMatchObject({ error: { code: 'invalid_input' } })
  await expect(tool(args)).rejects.toMatchObject({ statusCode: 400 })
  const { platformQueryRpcError } = await import('../../../server/utils/mcp-platform-query')
  const r = platformQueryRpcError({ method: 'tools/call', id: 2, params: { name: 'query_platform', arguments: args } })!
  expect(r.status).toBe(400)
  expect(await r.text()).not.toContain('synthetic-business-secret')
  expect(fetcher).not.toHaveBeenCalled()
})
it('raw RPC accepts supported title selection and capabilities declare its exact meaning', async () => {
  const { platformQueryRpcError } = await import('../../../server/utils/mcp-platform-query')
  for (const rdjb of ['1', '2', '3', 'all']) expect(platformQueryRpcError({ method: 'tools/call', params: { name: 'query_platform', arguments: { ...input, rdjb } } })).toBeNull()
  const cap = (await import('../../../server/mcp/tools/get_platform_capabilities')).default as any
  expect((await cap.handler()).sources.businessList).toMatchObject({ available: true, conditions: ['uscc'], rdjb: ['1', '2', '3', 'all'], titleMeaning: { '1': '创新型中小企业', '2': '专精特新中小企业', '3': '小巨人' } })
})
it.each([{ maxRequests: 1 }, { maxRows: 1 }])('one operation safety budget includes all remaining titles for %j', async limits => {
  fetcher.mockResolvedValue(response(page([{ qymc: '合成' }], 2)))
  for (const invoke of [query, tool]) {
    expect(await invoke({ ...input, pageSize: 1, ...limits })).toMatchObject({ status: 'partial', completeness: 'partial', fetchedCount: 1, declaredTotal: null, error: { code: 'safety_limit' }, unfinished: [{ rdjb: '1', page: 2 }, { rdjb: '2', page: 1 }, { rdjb: '3', page: 1 }] })
  }
  expect(fetcher).toHaveBeenCalledTimes(2)
})
it('an unknown title total stays unknown while every title is completed', async () => {
  fetcher.mockImplementation(async (_url: string, init: any) => {
    const p = new URLSearchParams(init.body), n = Number(p.get('pageNum'))
    return response(p.get('rdjb') === '3' ? page(n === 1 ? [{ qymc: '未知总数关系' }] : [], null, n) : page([]))
  })
  expect(await query(input)).toMatchObject({ status: 'success', completeness: 'complete', declaredTotal: null, fetchedCount: 1, unfinished: [] })
  expect(fetcher).toHaveBeenCalledTimes(4)
})
it('missing credentials mark all three titles unqueried', async () => {
  updateCredential('sme-roster.miitCookie', null, { db })
  const previous = process.env.MIIT_COOKIE
  process.env.MIIT_COOKIE = ''
  try {
    expect(await query(input)).toMatchObject({ status: 'not_queried', completeness: 'not_queried', unfinished: ['1', '2', '3'].map(rdjb => ({ source: 'businessList', rdjb, page: 1 })) })
    expect(fetcher).not.toHaveBeenCalled()
  } finally { if (previous === undefined) delete process.env.MIIT_COOKIE; else process.env.MIIT_COOKIE = previous }
})
it('business and application queries share the global maximum of two active upstream bodies', async () => {
  let active = 0, peak = 0
  fetcher.mockImplementation(async (url: string) => {
    active++; peak = Math.max(peak, active)
    return { ok: true, status: 200, text: async () => {
      await new Promise(resolve => setTimeout(resolve, 5)); active--
      return url.includes('businessList') ? page([]) : '{"zrarData":{"grid":{"applyGrid":{"pageSet":[],"maxCount":0,"page":1}}}}'
    } }
  })
  const results = await Promise.all([tool(input), tool(input), tool({ source: 'queryList', uscc }), tool(input)])
  expect(results.map(r => r.status)).toEqual(['no_record', 'no_record', 'no_record', 'no_record'])
  expect(peak).toBe(2)
  expect(active).toBe(0)
})
it('each title counts its own pagination and retains identical relationships from different titles', async () => {
  const row = { qymc: '合成共同曾用名', rdjb: '原始字段不得覆盖', tyshxydm: uscc }
  fetcher.mockImplementation(async (_url: string, init: any) => {
    const p = new URLSearchParams(init.body), n = Number(p.get('pageNum'))
    return response(page([row], p.get('rdjb') === '1' ? 1 : 2, n))
  })
  for (const invoke of [query, tool]) {
    const r = await invoke({ ...input, pageSize: 1 })
    expect(r).toMatchObject({ status: 'success', declaredTotal: 5, fetchedCount: 5, rows: [row, row, row, row, row], unfinished: [] })
    expect(r.pages.map((p: any) => [p.rdjb, p.page])).toEqual([['1', 1], ['2', 1], ['2', 2], ['3', 1], ['3', 2]])
  }
})
it('row overflow retains whole pages and every uncompleted title position', async () => {
  fetcher.mockImplementation(async (_url: string, init: any) => {
    const p = new URLSearchParams(init.body), n = Number(p.get('pageNum'))
    return response(page([{ qymc: `合成${n}a` }, { qymc: `合成${n}b` }], 4, n))
  })
  expect(await query({ ...input, maxRows: 3, pageSize: 2 })).toMatchObject({ status: 'partial', fetchedCount: 2, rows: [{ qymc: '合成1a' }, { qymc: '合成1b' }], unfinished: [{ rdjb: '1', page: 2 }, { rdjb: '2', page: 1 }, { rdjb: '3', page: 1 }], pages: [{ status: 'success' }, { status: 'failed', fetchedCount: 0, error: { code: 'safety_limit' } }] })
})
it('an active deadline leaves the failed page and all unrequested titles incomplete', async () => {
  const started = Date.now()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(started)
  try {
    fetcher.mockImplementation(async (_url: string, init: any) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        // Native abort timers and Date.now do not share an exact millisecond edge.
        // This case owns total-deadline expiry, not an earlier per-request timeout.
        vi.setSystemTime(started + 20)
        reject(init.signal.reason)
      }, { once: true })
    }))
    const r = await query({ ...input, maxDurationMs: 20 })
    expect(r).toMatchObject({ status: 'partial', completeness: 'partial', rows: [], unfinished: [{ rdjb: '1', page: 1 }, { rdjb: '2', page: 1 }, { rdjb: '3', page: 1 }] })
    expect(r.pages).toHaveLength(1)
    expect(r.pages[0]).toMatchObject({ status: 'failed', error: { code: 'timeout' } })
    expect(fetcher).toHaveBeenCalledTimes(1)
  } finally { vi.useRealTimers() }
})
it('all titles keep the initial credential snapshot and omit envelope account data', async () => {
  fetcher.mockImplementation(async (_url: string, init: any) => {
    expect(init.headers.Cookie).toBe(cookie)
    updateCredential('sme-roster.miitCookie', 'session=synthetic-other-business-account', { db })
    return response(JSON.stringify({ account: { token: 'synthetic-envelope-secret' }, zrarData: { grid: { businessListGrid: { pageSet: [{ qymc: '合成' }], maxCount: 1, page: 1 } } } }))
  })
  const r = await query(input)
  expect(r).toMatchObject({ status: 'success', fetchedCount: 3, declaredTotal: 3 })
  expect(JSON.stringify(r)).not.toMatch(/synthetic-other|synthetic-envelope|synthetic-business/)
  expect(fetcher).toHaveBeenCalledTimes(3)
})
it('a contradictory title page is incomplete even when other titles are valid zero', async () => {
  fetcher.mockImplementation(async (_url: string, init: any) => {
    const p = new URLSearchParams(init.body)
    return response(page([], p.get('rdjb') === '2' ? 3 : 0))
  })
  expect(await query(input)).toMatchObject({ status: 'partial', completeness: 'partial', declaredTotal: null, rows: [], error: { code: 'invalid_response' }, unfinished: [{ rdjb: '2', page: 1 }] })
})
it('an ordinary business failure remains unfinished when a later title reaches the shared request cap', async () => {
  fetcher.mockImplementation(async (_url: string, init: any) => {
    const title = new URLSearchParams(init.body).get('rdjb')
    return title === '1' ? response(cookie, 503) : response(page([{ qymc: '后续称号关系' }], 2))
  })
  for (const invoke of [query, tool]) {
    const result = await invoke({ ...input, pageSize: 1, maxRequests: 2 })
    expect(result).toMatchObject({ status: 'partial', completeness: 'partial', fetchedCount: 1,
      rows: [{ qymc: '后续称号关系' }], error: { code: 'safety_limit' },
      unfinished: [{ source: 'businessList', rdjb: '1', page: 1 }, { source: 'businessList', rdjb: '2', page: 2 }, { source: 'businessList', rdjb: '3', page: 1 }],
    })
    expect(result.pages.map((p: any) => [p.rdjb, p.page, p.status])).toEqual([['1', 1, 'failed'], ['2', 1, 'success']])
  }
})
