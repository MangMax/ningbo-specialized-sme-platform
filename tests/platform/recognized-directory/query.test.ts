import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initializeDb } from '../../../db/client'
import { updateCredential } from '../../../layers/core/server/utils/credential-state'

const dir = mkdtempSync(join(tmpdir(), 'platform-live-'))
const db = initializeDb({ create: true,  dbPath: join(dir, 'test.db') })
const cookie = 'session=synthetic-query-secret'
let body: unknown
let rest: (event: any) => Promise<any>
let tool: { handler: (input: any) => Promise<any> }
const nativeFetch = globalThis.fetch
let routeMeta: any
const fetcher = vi.fn()
function page(rows: Record<string, string>[], total = rows.length, number = 1) {
  return JSON.stringify({ zrarData: { grid: { applyGrid: { pageSet: rows, maxCount: total, page: number, pageSize: 1 } } } })
}
const response = (text: string, status = 200) => ({ ok: status === 200, status, text: async () => text })
async function query(input: unknown) { body = input; return rest({}) }
beforeAll(async () => {
  process.env.NUXT_DB_PATH = join(dir, 'test.db')
  vi.stubGlobal('defineRouteMeta', (meta: any) => { if (meta.openAPI.requestBody) routeMeta = meta })
  vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
  vi.stubGlobal('readBody', async () => body)
  vi.stubGlobal('setHeader', vi.fn())
  vi.stubGlobal('setResponseStatus', vi.fn())
  vi.doMock('@nuxtjs/mcp-toolkit/server', () => ({ defineMcpTool: (definition: unknown) => definition }))
  rest = (await import('../../../layers/sme-roster/server/api/platform/query.post')).default as any
  const definition = (await import('../../../layers/sme-roster/server/mcp/tools/query_platform')).default as any
  tool = { handler: async input => {
    const wire = await definition.handler(input)
    expect(wire.structuredContent).toBeDefined()
    expect(JSON.parse(wire.content[0].text)).toEqual(wire.structuredContent)
    return wire.structuredContent
  } }
})
beforeEach(() => {
  updateCredential('sme-roster.miitCookie', cookie, { db })
  fetcher.mockReset()
  vi.stubGlobal('fetch', fetcher)
})
afterAll(() => { vi.unstubAllGlobals(); delete process.env.NUXT_DB_PATH; rmSync(dir, { recursive: true, force: true }) })
function recognizedPage(rows: Record<string, string>[], total = rows.length, number = 1, size = 2, maxPage = Math.max(1, Math.ceil(total / size))) {
  return JSON.stringify({ zrarData: { grid: { businessGrid: { pageSet: rows, maxCount: total, page: number, pageSize: size, maxPage, nextPage: 1 } } } })
}
it('REST and MCP traverse three pages and all titles without compressing relations or writing SQLite', async () => {
  const before = db.$client.serialize()
  fetcher.mockImplementation(async (url: string, init: any) => {
    expect(url).toContain('/ZjtxxjrBusInfoManageBLH/queryBusList')
    const p = new URLSearchParams(init.body)
    const title = p.get('rdjb')!
    const n = Number(p.get('pageNum'))
    const rows: Record<string, string>[] = title === '1' ? n < 3 ? [{ qymc: `合成${n}甲`, tyshxydm: '91330000TEST000001', extra: '原字段' }, { qymc: `合成${n}乙` }] : [{ qymc: '合成末页' }] : title === '2' ? [] : [{ qymc: '跨称号关系', rdjb: '3', whpc: '2023-2', whpcyear: '' }]
    return response(recognizedPage(rows, title === '1' ? 5 : title === '2' ? 0 : 1, n))
  })
  const input = { source: 'queryBusList', name: '合成', pageSize: 2 }
  const a = await query(input)
  const b = await tool.handler(input)
  expect(a).toMatchObject({ source: 'queryBusList', status: 'success', fetchedCount: 6, declaredTotal: 6, completeness: 'complete', titleScope: { mode: 'selected', rdjb: ['1', '2', '3'] }, unfinished: [] })
  expect(a.pages.map((p: any) => [p.rdjb, p.page])).toEqual([['1', 1], ['1', 2], ['1', 3], ['2', 1], ['3', 1]])
  expect(a.rows[0]).toEqual({ qymc: '合成1甲', tyshxydm: '91330000TEST000001', extra: '原字段' })
  expect(a.rows[5]).toEqual({ qymc: '跨称号关系', rdjb: '3', whpc: '2023-2', whpcyear: '' })
  expect({ ...a, queriedAt: null, completedAt: null }).toEqual({ ...b, queriedAt: null, completedAt: null })
  expect(db.$client.serialize().equals(before), 'database bytes remain unchanged').toBe(true)
})
it('REST and MCP send only verified filters and return the actual restricted scope', async () => {
  const input = { source: 'queryBusList', name: '合成', uscc: '91330000TEST000001', rdjb: ['2'], sqsj: '2024/02/01 - 2024/02/29', rddqrq: '2027', whpcyear: '2023', whpc: '2', szq: '33028100', orderField: 'qymc', orderDirection: 'desc', pageSize: 2 }
  fetcher.mockImplementation(async (_: string, init: any) => {
    const p = Object.fromEntries(new URLSearchParams(init.body))
    expect(p).toEqual({ rdjb: '2', qymc: '合成', tyshxydm: '91330000TEST000001', sqsj: '2024/02/01 - 2024/02/29', rddqrq: '2027', whpcyear: '2023', whpc: '2', szq: '33028100', orderField: 'qymc', orderDirection: 'desc', target: 'businessGrid', pageNum: '1', numPerPage: '2' })
    return response(recognizedPage([{ qymc: '合成', szq: '133028100', whpcyear: '', whpc: '2023-2' }]))
  })
  for (const invoke of [query, tool.handler]) {
    const result = await invoke(input)
    expect(result).toMatchObject({ status: 'success', titleScope: { rdjb: ['2'] }, effectiveConditions: { name: '合成', uscc: '91330000TEST000001', sqsj: input.sqsj, rddqrq: '2027', whpcyear: '2023', whpc: '2', szq: '33028100', orderField: 'qymc', orderDirection: 'desc', combination: 'and' }, rows: [{ szq: '133028100', whpcyear: '', whpc: '2023-2' }] })
  }
})
it.each([
  { whpc: '1' }, { whpcyear: '2023', whpc: '2023-2' }, { whpcyear: '2023', whpc: '16' },
  { sqsj: '2024-02-01' }, { sqsj: '2024/02/30 - 2024/03/01' }, { sqsj: '2024/03/01 - 2024/02/01' },
  { rddqrq: '2027-02-04' }, { whpcyear: '23' }, { szq: '133028100' },
  { orderField: 'rdtime', orderDirection: 'asc' }, { orderField: 'qymc' }, { orderDirection: 'asc' },
  { rdjb: [] }, { rdjb: ['1', '1'] }, { rdjb: ['4'] }, { rdjb: '1' }, { rdjb: 'all' }, { cookie }, { effectiveYear: '2027' },
])('REST MCP and raw RPC reject unsupported or ambiguous recognized conditions (case %#)', async extra => {
  const input = { source: 'queryBusList', name: '合成', ...extra }
  expect(await query(input)).toMatchObject({ error: { code: 'invalid_input' } })
  await expect(tool.handler(input)).rejects.toMatchObject({ statusCode: 400 })
  const { platformQueryRpcError } = await import('../../../layers/sme-roster/server/utils/mcp-platform-query')
  const rejected = platformQueryRpcError({ method: 'tools/call', id: 1, params: { name: 'query_platform', arguments: input } })!
  expect(rejected.status).toBe(400)
  expect(await rejected.text()).not.toContain('synthetic-query-secret')
  expect(fetcher).not.toHaveBeenCalled()
})
it.each(['asc', 'desc'])('supports verified name sort %s with optional restrictions blank by default', async direction => {
  fetcher.mockImplementation(async (_: string, init: any) => {
    const p = new URLSearchParams(init.body)
    for (const key of ['sqsj', 'rddqrq', 'whpcyear', 'whpc', 'szq']) expect(p.get(key)).toBe('')
    expect(p.get('orderDirection')).toBe(direction)
    return response(recognizedPage([], 0))
  })
  expect(await query({ source: 'queryBusList', name: '合成', rdjb: ['1'], pageSize: 2, orderField: 'qymc', orderDirection: direction })).toMatchObject({ status: 'no_record', effectiveConditions: { name: '合成', combination: 'and', orderField: 'qymc', orderDirection: direction } })
})
it.each([
  ['wrong page', { page: 2 }], ['wrong maxPage', { maxPage: 1 }], ['short intermediate page', { pageSet: [{ qymc: '缺行' }] }],
  ['wrong pageSize', { pageSize: 15 }], ['invalid maxPage', { maxPage: 'bad' }],
])('does not claim complete for contradictory recognized pagination: %s', async (_label, patch) => {
  const raw = JSON.parse(recognizedPage([{ qymc: '甲' }, { qymc: '乙' }], 3))
  Object.assign(raw.zrarData.grid.businessGrid, patch)
  fetcher.mockResolvedValue(response(JSON.stringify(raw)))
  for (const invoke of [query, tool.handler]) expect(await invoke({ source: 'queryBusList', name: '合成', rdjb: ['1'], pageSize: 2 })).toMatchObject({ status: 'failed', completeness: 'partial', error: { code: 'invalid_response' }, rows: [], unfinished: [{ rdjb: '1', page: 1 }] })
})
it('partial title traversal identifies every unqueried title and resumes only the selected title', async () => {
  fetcher.mockResolvedValueOnce(response(recognizedPage([{ qymc: '甲' }, { qymc: '乙' }], 3))).mockResolvedValueOnce(response(cookie, 503))
  expect(await query({ source: 'queryBusList', name: '合成', pageSize: 2 })).toMatchObject({ status: 'partial', fetchedCount: 2, declaredTotal: null, unfinished: [{ rdjb: '1', page: 2 }, { rdjb: '2', page: 1 }, { rdjb: '3', page: 1 }] })
  fetcher.mockResolvedValue(response(recognizedPage([{ qymc: '丙' }], 3, 2)))
  expect(await tool.handler({ source: 'queryBusList', name: '合成', pageSize: 2, startPage: 2, rdjb: ['1'] })).toMatchObject({ status: 'success', fullRange: false, fetchedCount: 1, declaredTotal: 3, titleScope: { rdjb: ['1'] }, unfinished: [] })
})
it.each([
  ['empty', () => response(recognizedPage([], 0)), 'no_record', null],
  ['login page', () => response('<form id="loginForm"><input name="password"></form>'), 'auth_failed', 'auth_failed'],
  ['expired', () => response('{"statusCode":"301","message":"登录超时"}'), 'auth_failed', 'auth_failed'],
  ['http auth', () => response(cookie, 403), 'auth_failed', 'auth_failed'],
  ['upstream', () => response(cookie, 503), 'failed', 'upstream_failed'],
  ['rate limit', () => response(cookie, 429), 'failed', 'rate_limited'],
  ['timeout', () => { throw new DOMException(cookie, 'TimeoutError') }, 'failed', 'timeout'],
  ['wrong source grid', () => response(page([], 0)), 'failed', 'upstream_failed'],
  ['secret', () => response(recognizedPage([{ qymc: cookie }])), 'failed', 'sensitive_response'],
] as const)('REST and MCP distinguish recognized %s without leaking credentials', async (_label, upstream, status, code) => {
  fetcher.mockImplementation(upstream)
  for (const invoke of [query, tool.handler]) {
    const result = await invoke({ source: 'queryBusList', uscc: '91330000TEST000001', rdjb: ['3'], pageSize: 2 })
    expect(result).toMatchObject({ status, rows: [], completeness: status === 'no_record' ? 'complete' : 'partial' })
    expect(result.error?.code ?? null).toBe(code)
    expect(JSON.stringify(result)).not.toContain('synthetic-query-secret')
  }
  expect(fetcher).toHaveBeenCalledTimes(2)
})
it.each([{ maxRequests: 1 }, { maxRows: 2 }])('recognized bounds retain whole pages and outstanding titles for %j', async limits => {
  fetcher.mockResolvedValue(response(recognizedPage([{ qymc: '甲' }, { qymc: '乙' }], 3)))
  for (const invoke of [query, tool.handler]) expect(await invoke({ source: 'queryBusList', name: '合成', pageSize: 2, ...limits })).toMatchObject({ status: 'partial', fetchedCount: 2, error: { code: 'safety_limit' }, unfinished: [{ rdjb: '1', page: 2 }, { rdjb: '2', page: 1 }, { rdjb: '3', page: 1 }] })
})
it('missing recognized credentials reports all unqueried titles without using environment credentials', async () => {
  updateCredential('sme-roster.miitCookie', null, { db })
  vi.stubEnv('MIIT_COOKIE', '')
  vi.stubEnv('MIIT_COOKIE_FILE', '')
  try {
    for (const invoke of [query, tool.handler]) expect(await invoke({ source: 'queryBusList', name: '合成' })).toMatchObject({ status: 'not_queried', error: { code: 'credential_unavailable' }, unfinished: [{ rdjb: '1', page: 1 }, { rdjb: '2', page: 1 }, { rdjb: '3', page: 1 }] })
    expect(fetcher).not.toHaveBeenCalled()
  } finally { vi.unstubAllEnvs() }
})
it('REST capabilities MCP discovery and OpenAPI advertise only verified recognized conditions', async () => {
  const capabilities = (await import('../../../layers/sme-roster/server/api/platform/capabilities.get')).default as any
  const toolCaps = (await import('../../../layers/sme-roster/server/mcp/tools/get_platform_capabilities')).default as any
  const cap = capabilities({})
  expect(await toolCaps.handler()).toEqual(cap)
  expect(cap.sources.queryBusList).toMatchObject({ available: true, titleSelection: true, defaultTitles: ['1', '2', '3'], defaultRestrictions: [], sorts: { qymc: ['asc', 'desc'] }, visibility: 'server_session_scope' })
  expect(cap.sources.queryBusList.conditions).toEqual(['name', 'uscc', 'rdjb', 'sqsj', 'rddqrq', 'whpcyear', 'whpc', 'szq', 'orderField', 'orderDirection'])
  const input = routeMeta.openAPI.requestBody.content['application/json'].schema
  expect(input.additionalProperties).toBe(false)
  expect(input.properties.rdjb.oneOf).toEqual([
    { type: 'string', enum: ['1', '2', '3', 'all'] },
    { type: 'array', minItems: 1, maxItems: 3, items: { type: 'string', enum: ['1', '2', '3'] } },
  ])
  const recognized = input.oneOf.find((branch: any) => branch.properties.source.enum[0] === 'queryBusList')
  expect(recognized.properties.rdjb).toEqual({ type: 'array', minItems: 1, maxItems: 3, items: { type: 'string', enum: ['1', '2', '3'] } })
  const business = input.oneOf.find((branch: any) => branch.properties.source.enum[0] === 'businessList')
  expect(business.required).toEqual(['uscc', 'rdjb'])
  expect(business.oneOf.map((branch: any) => branch.properties.rdjb.enum)).toEqual([['1', '2', '3'], ['all']])
  expect(input.properties.orderField.enum).toEqual(['qymc'])
  expect(input.properties.whpc.description).toContain('whpcyear')
  const output = routeMeta.openAPI.responses[200].content['application/json'].schema.properties.effectiveConditions.properties
  for (const key of ['sqsj', 'rddqrq', 'whpcyear', 'whpc', 'szq', 'orderField', 'orderDirection']) expect(output[key].type).toBe('string')
  const { platformQueryRpcError } = await import('../../../layers/sme-roster/server/utils/mcp-platform-query')
  expect(platformQueryRpcError({ method: 'tools/call', params: { name: 'query_platform', arguments: { source: 'queryBusList', name: '合成', rdjb: ['2'], whpcyear: '2023', whpc: '2' } } })).toBeNull()
})
it('recognized query works through HTTP and sets no-store', async () => {
  const { startHttpFixture } = await import('../../support/http')
  const service = await startHttpFixture({ routes: { '/api/platform/query': async req => ({ status: 200, body: await query(req.body) }) } })
  fetcher.mockResolvedValue(response(recognizedPage([], 0)))
  try {
    const r = await nativeFetch(`${service.baseUrl}/api/platform/query`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source: 'queryBusList', name: '合成', rdjb: ['2'], pageSize: 2 }) })
    expect(await r.json()).toMatchObject({ source: 'queryBusList', status: 'no_record', titleScope: { rdjb: ['2'] }, completeness: 'complete' })
    expect(vi.mocked(setHeader)).toHaveBeenCalledWith(expect.anything(), 'Cache-Control', 'no-store')
  } finally { await service.close() }
})
it('all three empty titles are required for a valid no-record result', async () => {
  fetcher.mockResolvedValue(response(recognizedPage([], 0)))
  for (const invoke of [query, tool.handler]) {
    const result = await invoke({ source: 'queryBusList', name: '合成', pageSize: 2 })
    expect(result).toMatchObject({ status: 'no_record', declaredTotal: 0, completeness: 'complete', rows: [], unfinished: [] })
    expect(result.pages.map((p: any) => p.rdjb)).toEqual(['1', '2', '3'])
  }
})
it('an empty first title followed by auth failure cannot become no-record', async () => {
  for (const invoke of [query, tool.handler]) {
    fetcher.mockResolvedValueOnce(response(recognizedPage([], 0))).mockResolvedValueOnce(response(cookie, 401))
    expect(await invoke({ source: 'queryBusList', name: '合成', pageSize: 2 })).toMatchObject({ status: 'partial', declaredTotal: null, completeness: 'partial', error: { code: 'auth_failed' }, unfinished: [{ rdjb: '2', page: 1 }, { rdjb: '3', page: 1 }] })
  }
})
it('a reliable maxPage finishes recognized traversal while absent total remains unknown', async () => {
  fetcher.mockImplementation(async (_: string, init: any) => {
    const n = Number(new URLSearchParams(init.body).get('pageNum'))
    const raw = JSON.parse(recognizedPage(n === 1 ? [{ qymc: '甲' }, { qymc: '乙' }] : [{ qymc: '丙' }], 3, n))
    delete raw.zrarData.grid.businessGrid.maxCount
    return response(JSON.stringify(raw))
  })
  for (const invoke of [query, tool.handler]) expect(await invoke({ source: 'queryBusList', name: '合成', rdjb: ['1'], pageSize: 2 })).toMatchObject({ status: 'success', declaredTotal: null, fetchedCount: 3, completeness: 'complete', unfinished: [] })
  expect(fetcher).toHaveBeenCalledTimes(4)
})
it('recognized overflow keeps whole prior pages and does not discard unfinished titles', async () => {
  fetcher.mockImplementation(async (_: string, init: any) => response(recognizedPage([{ qymc: '甲' }, { qymc: '乙' }], 4, Number(new URLSearchParams(init.body).get('pageNum')))))
  for (const invoke of [query, tool.handler]) expect(await invoke({ source: 'queryBusList', name: '合成', pageSize: 2, maxRows: 3 })).toMatchObject({ status: 'partial', fetchedCount: 2, error: { code: 'safety_limit' }, pages: [{ status: 'success' }, { status: 'failed', fetchedCount: 0 }], unfinished: [{ rdjb: '1', page: 2 }, { rdjb: '2', page: 1 }, { rdjb: '3', page: 1 }] })
})
it('recognized active deadline aborts safely and leaves every title unfinished', async () => {
  fetcher.mockImplementation(async (_: string, init: any) => new Promise((_resolve, reject) => { init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }) }))
  for (const invoke of [query, tool.handler]) expect(await invoke({ source: 'queryBusList', name: '合成', maxDurationMs: 20 })).toMatchObject({ status: 'failed', error: { code: 'timeout' }, unfinished: [{ rdjb: '1', page: 1 }, { rdjb: '2', page: 1 }, { rdjb: '3', page: 1 }] })
})
