import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { useDb } from '../db/client'
import { updateCredential } from '../server/utils/credential-state'
import { whenIdle } from '../server/utils/job-runner'
import { handlePlatformBatchRequest } from '../server/utils/platform-batch-http'

const dir = mkdtempSync(join(tmpdir(), 'pagination-regressions-'))
const db = useDb({ dbPath: join(dir, 'test.sqlite') })
const cookie = 'session=synthetic-pagination-secret'
const upstream = vi.fn()
const uscc = '91330211255994457P'
let body: unknown
let rest: (event: any) => Promise<any>
let mcp: (input: any) => Promise<any>
const query = async (input: unknown) => { body = input; return rest({}) }
const inputFor = (source: string) => source === 'businessList' ? { source, uscc, rdjb: '3', pageSize: 1 } : { source, name: '合成', ...(source === 'queryBusList' ? { rdjb: ['3'] } : {}), pageSize: 1 }
function response(source: string, rows: Record<string, string>[], metadata: Record<string, unknown>) {
  const grid = source === 'queryList' ? 'applyGrid' : source === 'businessList' ? 'businessListGrid' : 'businessGrid'
  const data = JSON.stringify({ zrarData: { grid: { [grid]: { pageSet: rows, ...metadata } } } })
  // businessList's embedded JSON is a supported, independent response form.
  return { ok: true, status: 200, text: async () => source === 'businessList' ? `<script>(function(data){} )(${data});</script>` : data }
}
const batch = (action: 'submit' | 'status' | 'retry', value?: unknown, batchId?: string) => handlePlatformBatchRequest(action, { body: value, batchId, headers: { authorization: 'Bearer synthetic-task' } }, { db, apiToken: 'synthetic-task', filesDir: dir })
beforeAll(async () => {
  vi.stubEnv('NUXT_DB_PATH', join(dir, 'test.sqlite'))
  vi.stubEnv('MIIT_COOKIE', '')
  vi.stubEnv('MIIT_COOKIE_FILE', '')
  vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
  vi.stubGlobal('readBody', async () => body)
  vi.stubGlobal('setHeader', vi.fn())
  vi.stubGlobal('setResponseStatus', vi.fn())
  vi.doMock('@nuxtjs/mcp-toolkit/server', () => ({ defineMcpTool: (definition: unknown) => definition }))
  rest = (await import('../server/api/platform/query.post')).default as any
  const tool = (await import('../server/mcp/tools/query_platform')).default as any
  mcp = async input => {
    const wire = await tool.handler(input)
    expect(JSON.parse(wire.content[0].text)).toEqual(wire.structuredContent)
    return wire.structuredContent
  }
})
beforeEach(() => { updateCredential('miitCookie', cookie, { db }); upstream.mockReset(); vi.stubGlobal('fetch', upstream) })
afterAll(async () => { await whenIdle(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); db.$client.close(); rmSync(dir, { recursive: true, force: true }) })

it.each([true, false, [], [1], ' ', {}, -1, 1.5, 'NaN', '9007199254740992'])('REST and MCP keep malformed totals unknown and traverse every relation (case %#)', async total => {
  for (const source of ['queryList', 'businessList']) {
    upstream.mockImplementation(async (_url: string, init: any) => {
      const page = Number(new URLSearchParams(init.body).get('pageNum'))
      return response(source, page <= 2 ? [{ relation: String(page), tyshxydm: uscc }] : [], { page, ...(page === 1 ? { maxCount: total } : {}) })
    })
    for (const invoke of [query, mcp]) {
      const result = await invoke(inputFor(source))
      expect(result).toMatchObject({ status: 'success', completeness: 'complete', declaredTotal: null, fetchedCount: 2, unfinished: [] })
      expect(result.rows.map((r: any) => r.relation)).toEqual(['1', '2'])
      expect(result.pages.map((p: any) => p.page)).toEqual([1, 2, 3])
      expect(result.pages.every((p: any) => p.declaredTotal === null)).toBe(true)
    }
  }
})

it.each(['queryList', 'businessList'])('REST and MCP retain the known total when %s later omits it and reject contradictory empty pages', async source => {
  upstream.mockImplementation(async (_url: string, init: any) => {
    const page = Number(new URLSearchParams(init.body).get('pageNum'))
    return response(source, page === 1 ? [{ relation: '1' }] : [], { page, ...(page === 1 ? { maxCount: 3 } : {}) })
  })
  for (const invoke of [query, mcp]) {
    const result = await invoke(inputFor(source))
    expect(result).toMatchObject({ status: 'partial', completeness: 'partial', declaredTotal: 3, rows: [{ relation: '1' }], unfinished: [{ source, page: 2 }], error: { code: 'invalid_response' } })
    expect(result.pages.map((p: any) => p.status)).toEqual(['success', 'failed'])
  }
})

it.each(['queryList', 'businessList'])('REST and MCP complete %s at the retained total after nonempty pages omit it', async source => {
  upstream.mockImplementation(async (_url: string, init: any) => {
    const page = Number(new URLSearchParams(init.body).get('pageNum'))
    // A fourth request would be a real upstream failure, not an exhaustion signal.
    if (page > 3) return { ok: false, status: 503, text: async () => '' }
    return response(source, [{ relation: String(page) }], { page, ...(page === 1 ? { maxCount: 3 } : {}) })
  })
  for (const invoke of [query, mcp]) {
    const result = await invoke(inputFor(source))
    expect(result).toMatchObject({ status: 'success', completeness: 'complete', declaredTotal: 3, unfinished: [] })
    expect(result.rows.map((r: any) => r.relation)).toEqual(['1', '2', '3'])
    expect(result.pages.map((p: any) => p.declaredTotal)).toEqual([3, null, null])
  }
})

it.each(['queryList', 'businessList'])('batch checkpoints and retries keep the earlier %s total constraint without replaying successful pages', async source => {
  let mode = 'initial'
  let release!: () => void
  let entered!: () => void
  const blocked = new Promise<void>(resolve => { entered = resolve })
  const seen: number[] = []
  upstream.mockImplementation(async (_url: string, init: any) => {
    const page = Number(new URLSearchParams(init.body).get('pageNum')); seen.push(page)
    if (mode === 'initial' && page === 2) { entered(); await new Promise<void>(resolve => { release = resolve }) }
    const rows = page === 1 || mode === 'repaired' ? [{ relation: String(page) }] : []
    return response(source, rows, { page, ...(page === 1 ? { maxCount: 3 } : {}) })
  })
  const receipt = (await batch('submit', { items: [{ query: inputFor(source) }] })).body as any
  await blocked
  let checkpoint: any
  try {
    checkpoint = (await batch('status', undefined, receipt.batchId)).body as any
    expect(checkpoint).toMatchObject({ state: 'running', completeness: 'partial' })
    expect(checkpoint.items[0]).toMatchObject({ unfinished: [{ page: 2 }], segments: [{ declaredTotal: 3, rows: [{ relation: '1' }] }] })
  } finally { release() }
  await whenIdle()
  const first = (await batch('status', undefined, receipt.batchId)).body as any
  expect(first).toMatchObject({ state: 'failed', completeness: 'partial' })
  expect(first.items[0]).toMatchObject({ unfinished: [{ page: 2 }], segments: [{ declaredTotal: 3, error: { code: 'invalid_response' } }] })
  expect(first.items[0].segments[0].rows).toEqual(checkpoint.items[0].segments[0].rows)
  mode = 'still-contradictory'; seen.length = 0
  expect((await batch('retry', { itemIds: receipt.itemIds }, receipt.batchId)).status).toBe(202)
  await whenIdle()
  const second = (await batch('status', undefined, receipt.batchId)).body as any
  expect(second).toMatchObject({ completeness: 'partial', attempt: 2 })
  expect(second.items[0].unfinished).toEqual(first.items[0].unfinished)
  expect(second.items[0].segments[1]).toMatchObject({ declaredTotal: 3, rows: [], error: { code: 'invalid_response' } })
  expect(seen).toEqual([2])
  mode = 'repaired'; seen.length = 0
  await batch('retry', { itemIds: receipt.itemIds }, receipt.batchId); await whenIdle()
  const final = (await batch('status', undefined, receipt.batchId)).body as any
  expect(final).toMatchObject({ batchId: receipt.batchId, itemIds: receipt.itemIds, state: 'done', completeness: 'complete', attempt: 3 })
  expect(final.items[0].segments.slice(0, 2)).toEqual(second.items[0].segments)
  expect(final.items[0].segments.flatMap((s: any) => s.rows).map((r: any) => r.relation)).toEqual(['1', '2', '3'])
  expect(seen).toEqual([2, 3])
})

it.each([20, true, false, [1], [], ' ', 0, 1.5])('REST and MCP reject explicit conflicting or invalid legacy page sizes before admitting rows (case %#)', async pageSize => {
  for (const source of ['queryList', 'businessList']) {
    upstream.mockImplementation(async () => response(source, [{ relation: 'unverified' }], { page: 1, pageSize, maxCount: 60 }))
    for (const invoke of [query, mcp]) {
      const result = await invoke({ ...inputFor(source), pageSize: 50, maxRequests: 1 })
      expect(result).toMatchObject({ status: 'failed', completeness: 'partial', rows: [], unfinished: [{ source, page: 1 }], error: { code: 'invalid_response' } })
      expect(result.pages).toMatchObject([{ status: 'failed', fetchedCount: 0 }])
    }
  }
})

it.each(['queryList', 'businessList'])('batch %s size mismatch stays unfinished through retry and repaired sizes retrieve all 60 relations', async source => {
  let repaired = false
  const seen: number[] = []
  upstream.mockImplementation(async (_url: string, init: any) => {
    const p = new URLSearchParams(init.body), page = Number(p.get('pageNum')); seen.push(page)
    expect(p.get('numPerPage')).toBe('50')
    if (!repaired && page === 2 && seen.length === 2) return { ok: false, status: 503, text: async () => '' }
    const size = repaired ? 50 : 20
    const start = (page - 1) * size
    return response(source, Array.from({ length: Math.min(size, 60 - start) }, (_, i) => ({ relation: String(start + i + 1) })), { page, pageSize: size, maxCount: 60 })
  })
  const receipt = (await batch('submit', { items: [{ query: { ...inputFor(source), pageSize: 50 } }] })).body as any
  await whenIdle()
  const first = (await batch('status', undefined, receipt.batchId)).body as any
  expect(first).toMatchObject({ state: 'failed', completeness: 'partial' })
  expect(first.items[0]).toMatchObject({ unfinished: [{ page: 1 }], segments: [{ rows: [], error: { code: 'invalid_response' } }] })
  seen.length = 0
  await batch('retry', { itemIds: receipt.itemIds }, receipt.batchId); await whenIdle()
  const second = (await batch('status', undefined, receipt.batchId)).body as any
  expect(second.completeness).toBe('partial')
  expect(second.items[0].unfinished).toEqual(first.items[0].unfinished)
  expect(seen).toEqual([1])
  repaired = true; seen.length = 0
  await batch('retry', { itemIds: receipt.itemIds }, receipt.batchId); await whenIdle()
  const final = (await batch('status', undefined, receipt.batchId)).body as any
  expect(final).toMatchObject({ state: 'done', completeness: 'complete' })
  expect(final.items[0].segments.slice(0, 2)).toEqual(second.items[0].segments)
  expect(final.items[0].segments.flatMap((s: any) => s.rows).map((r: any) => r.relation)).toEqual(Array.from({ length: 60 }, (_, i) => String(i + 1)))
  expect(seen).toEqual([1, 2])
})

it.each(['queryList', 'businessList'])('batch %s preserves verified pages when a later page changes size and retries the same boundary', async source => {
  let repaired = false
  const seen: number[] = []
  upstream.mockImplementation(async (_url: string, init: any) => {
    const page = Number(new URLSearchParams(init.body).get('pageNum')); seen.push(page)
    const size = page === 2 && !repaired ? 1 : 2
    return response(source, Array.from({ length: size }, (_, i) => ({ relation: String((page - 1) * 2 + i + 1) })), { page, pageSize: size, maxCount: 6 })
  })
  const receipt = (await batch('submit', { items: [{ query: { ...inputFor(source), pageSize: 2 } }] })).body as any
  await whenIdle()
  const first = (await batch('status', undefined, receipt.batchId)).body as any
  expect(first.items[0]).toMatchObject({ completeness: 'partial', unfinished: [{ page: 2 }], segments: [{ rows: [{ relation: '1' }, { relation: '2' }], error: { code: 'invalid_response' } }] })
  repaired = true; seen.length = 0
  await batch('retry', { itemIds: receipt.itemIds }, receipt.batchId); await whenIdle()
  const final = (await batch('status', undefined, receipt.batchId)).body as any
  expect(final.completeness).toBe('complete')
  expect(final.items[0].segments[0]).toEqual(first.items[0].segments[0])
  expect(final.items[0].segments.flatMap((s: any) => s.rows).map((r: any) => r.relation)).toEqual(['1', '2', '3', '4', '5', '6'])
  expect(seen).toEqual([2, 3])
})

it.each([
  ['boolean page', 'page', true], ['array page', 'page', [1]],
  ['boolean size', 'pageSize', true], ['array size', 'pageSize', [1]],
  ['boolean maxPage', 'maxPage', true], ['array maxPage', 'maxPage', [1]],
] as const)('REST and MCP never accept coerced live pagination metadata: %s', async (_label, field, value) => {
  for (const source of field === 'maxPage' ? ['queryBusList'] : ['queryList', 'businessList', 'queryBusList']) {
    upstream.mockImplementation(async () => response(source, [{ relation: 'unverified' }], { page: 1, pageSize: 1, maxPage: 1, maxCount: 1, [field]: value }))
    for (const invoke of [query, mcp]) {
      const result = await invoke(inputFor(source))
      expect(result).toMatchObject({ status: 'failed', completeness: 'partial', fetchedCount: 0, rows: [], unfinished: [{ source, page: 1 }], error: { code: 'invalid_response' } })
    }
  }
})

it.each([0, '0', 1, '1', ' 1 '])('REST and MCP retain reliable integer totals and numeric pagination strings (case %#)', async maxCount => {
  for (const source of ['queryList', 'businessList', 'queryBusList']) {
    const rows = maxCount === 0 || maxCount === '0' ? [] : [{ relation: '1' }]
    upstream.mockImplementation(async () => response(source, rows, { page: '1', pageSize: '1', maxPage: '1', maxCount }))
    for (const invoke of [query, mcp]) {
      const result = await invoke(inputFor(source))
      expect(result).toMatchObject({ status: rows.length ? 'success' : 'no_record', completeness: 'complete', declaredTotal: rows.length, rows, unfinished: [] })
      expect(result.pages).toMatchObject([{ status: 'success', declaredTotal: rows.length }])
    }
  }
})

it.each(['queryList', 'businessList'])('REST and MCP allow absent legacy size metadata without turning it into an observed size for %s', async source => {
  upstream.mockImplementation(async (_url: string, init: any) => {
    const page = Number(new URLSearchParams(init.body).get('pageNum'))
    return response(source, page === 1 ? [{ relation: '1' }] : [], { page })
  })
  for (const invoke of [query, mcp]) {
    const result = await invoke({ ...inputFor(source), pageSize: 50 })
    expect(result).toMatchObject({ status: 'success', completeness: 'complete', declaredTotal: null, rows: [{ relation: '1' }], unfinished: [], limits: { pageSize: 50 } })
    expect(result.pages.map((p: any) => p.page)).toEqual([1, 2])
  }
})

it('REST and MCP retain independent known totals across business titles when later metadata is missing', async () => {
  upstream.mockImplementation(async (_url: string, init: any) => {
    const p = new URLSearchParams(init.body), page = Number(p.get('pageNum')), title = p.get('rdjb')
    const total = title === '1' ? 2 : title === '2' ? 0 : 1
    return response('businessList', total ? [{ relation: `${title}:${page}` }] : [], { page, ...(page === 1 ? { maxCount: total } : {}) })
  })
  for (const invoke of [query, mcp]) {
    const result = await invoke({ ...inputFor('businessList'), rdjb: 'all' })
    expect(result).toMatchObject({ status: 'success', completeness: 'complete', declaredTotal: 3, unfinished: [] })
    expect(result.rows.map((r: any) => r.relation)).toEqual(['1:1', '1:2', '3:1'])
    expect(result.pages.map((p: any) => [p.rdjb, p.page, p.declaredTotal])).toEqual([['1', 1, 2], ['1', 2, null], ['2', 1, 0], ['3', 1, 1]])
  }
})

it.each(['queryList', 'businessList'])('REST and MCP reject a changed %s total even after an intervening page omits it', async source => {
  upstream.mockImplementation(async (_url: string, init: any) => {
    const page = Number(new URLSearchParams(init.body).get('pageNum'))
    return response(source, [{ relation: String(page) }], { page, ...(page === 1 ? { maxCount: 3 } : page === 3 ? { maxCount: 4 } : {}) })
  })
  for (const invoke of [query, mcp]) {
    const result = await invoke({ ...inputFor(source), maxRequests: 3 })
    expect(result).toMatchObject({ status: 'partial', completeness: 'partial', declaredTotal: 3, rows: [{ relation: '1' }, { relation: '2' }], unfinished: [{ page: 3 }], error: { code: 'invalid_response' } })
    expect(result.pages.map((p: any) => p.status)).toEqual(['success', 'success', 'failed'])
  }
})

it.each(['queryList', 'businessList'])('REST and MCP keep known %s totals as constraints when later totals are malformed or size is absent', async source => {
  for (const later of [undefined, null, false, [], ' ']) {
    upstream.mockImplementation(async (_url: string, init: any) => {
      const page = Number(new URLSearchParams(init.body).get('pageNum'))
      return response(source, page === 1 ? [{ relation: '1' }] : [], { page, maxCount: page === 1 ? 3 : later })
    })
    for (const invoke of [query, mcp]) {
      const result = await invoke({ ...inputFor(source), pageSize: 50 })
      expect(result).toMatchObject({ status: 'partial', completeness: 'partial', declaredTotal: 3, rows: [{ relation: '1' }], unfinished: [{ page: 2 }], error: { code: 'invalid_response' } })
      expect(result.pages.map((p: any) => p.status)).toEqual(['success', 'failed'])
    }
  }
})

it.each([
  ['queryList', false], ['businessList', false], ['queryList', true], ['businessList', true],
] as const)('batch %s preserves actual short-page consumption across retries with restart=%s', async (source, restart) => {
  let mode = 'initial'
  let release!: () => void
  let entered!: () => void
  const blocked = new Promise<void>(resolve => { entered = resolve })
  const seen: number[] = []
  upstream.mockImplementation(async (_url: string, init: any) => {
    const p = new URLSearchParams(init.body), page = Number(p.get('pageNum')); seen.push(page)
    expect(p.get('numPerPage')).toBe('50')
    if (mode === 'initial' && page === 2) { entered(); await new Promise<void>(resolve => { release = resolve }) }
    if (mode === 'partly-repaired' && page === 3) return { ok: false, status: 503, text: async () => '' }
    return response(source, page === 1 || mode.includes('repaired') ? [{ relation: String(page) }] : [], { page, ...(page === 1 ? { maxCount: 3 } : {}) })
  })
  const receipt = (await batch('submit', { items: [{ query: { ...inputFor(source), pageSize: 50 } }] })).body as any
  await blocked
  let restarted: typeof db | undefined
  let checkpoint: any
  try {
    checkpoint = (await batch('status', undefined, receipt.batchId)).body as any
    expect(checkpoint).toMatchObject({ state: 'running', completeness: 'partial' })
    expect(checkpoint.items[0]).toMatchObject({ unfinished: [{ page: 2 }], segments: [{ rows: [{ relation: '1' }], declaredTotal: 3 }] })
    if (restart) {
      const path = join(dir, `short-page-${source}.sqlite`)
      writeFileSync(path, db.$client.serialize())
      restarted = useDb({ dbPath: path })
    }
  } finally { release(); await whenIdle() }
  const invoke = (action: 'status' | 'retry', value?: unknown) => handlePlatformBatchRequest(action, { batchId: receipt.batchId, body: value, headers: { authorization: 'Bearer synthetic-task' } }, { db: restarted ?? db, apiToken: 'synthetic-task', filesDir: dir })
  try {
    const first = (await invoke('status')).body as any
    expect(first).toMatchObject({ state: 'failed', completeness: 'partial' })
    expect(first.items[0].segments[0].rows).toEqual(checkpoint.items[0].segments[0].rows)
    if (restart) {
      expect(first.error).toContain('重启')
      expect(first.items[0]).toEqual(checkpoint.items[0])
    }
    mode = 'contradictory'; seen.length = 0
    expect((await invoke('retry', { itemIds: receipt.itemIds })).status).toBe(202); await whenIdle()
    const second = (await invoke('status')).body as any
    expect(second).toMatchObject({ state: 'failed', completeness: 'partial', attempt: 2 })
    expect(second.items[0]).toMatchObject({ unfinished: [{ page: 2 }], segments: [first.items[0].segments[0], { rows: [], declaredTotal: 3, error: { code: 'invalid_response' } }] })
    expect(seen).toEqual([2])
    mode = 'partly-repaired'; seen.length = 0
    await invoke('retry', { itemIds: receipt.itemIds }); await whenIdle()
    const third = (await invoke('status')).body as any
    expect(third).toMatchObject({ state: 'failed', completeness: 'partial', attempt: 3 })
    expect(third.items[0].unfinished.map((p: any) => p.page)).toEqual([3])
    expect(third.items[0].segments.slice(0, 2)).toEqual(second.items[0].segments)
    expect(third.items[0].segments.flatMap((s: any) => s.rows).map((r: any) => r.relation)).toEqual(['1', '2'])
    expect(seen).toEqual([2, 3])
    mode = 'repaired'; seen.length = 0
    await invoke('retry', { itemIds: receipt.itemIds }); await whenIdle()
    const final = (await invoke('status')).body as any
    expect(final).toMatchObject({ batchId: receipt.batchId, itemIds: receipt.itemIds, state: 'done', completeness: 'complete', attempt: 4 })
    expect(final.items[0].segments.slice(0, 3)).toEqual(third.items[0].segments)
    expect(final.items[0].segments.flatMap((s: any) => s.rows).map((r: any) => r.relation)).toEqual(['1', '2', '3'])
    expect(final.items[0].segments.at(-1)).toMatchObject({ fullRange: false, fetchedCount: 1 })
    expect(seen).toEqual([3])
  } finally { await whenIdle(); restarted?.$client.close() }
})

it.each([
  ['queryList', 'REST'], ['queryList', 'MCP'], ['businessList', 'REST'], ['businessList', 'MCP'],
])('%s %s manual continuation cannot infer prior coverage from requested size', async (source, entry) => {
  upstream.mockImplementation(async () => response(source!, [], { page: 2, maxCount: 3 }))
  const result = await (entry === 'REST' ? query : mcp)({ ...inputFor(source!), startPage: 2, pageSize: 50 })
  expect(result).toMatchObject({ status: 'failed', completeness: 'partial', fullRange: false, rows: [], declaredTotal: null, unfinished: [{ page: 2 }], error: { code: 'invalid_response' } })
})

it.each(['queryList', 'businessList'])('batch %s with an unobserved initial prefix stays unfinished on repeated empty continuation', async source => {
  upstream.mockImplementation(async () => response(source, [], { page: 2, maxCount: 3 }))
  const receipt = (await batch('submit', { items: [{ query: { ...inputFor(source), startPage: 2, pageSize: 50 } }] })).body as any
  await whenIdle()
  const first = (await batch('status', undefined, receipt.batchId)).body as any
  expect(first).toMatchObject({ state: 'failed', completeness: 'partial' })
  expect(first.items[0]).toMatchObject({ unfinished: [{ page: 2 }], segments: [{ fullRange: false, rows: [], error: { code: 'invalid_response' } }] })
  await batch('retry', { itemIds: receipt.itemIds }, receipt.batchId); await whenIdle()
  const final = (await batch('status', undefined, receipt.batchId)).body as any
  expect(final).toMatchObject({ state: 'failed', completeness: 'partial', attempt: 2 })
  expect(final.items[0].unfinished).toEqual(first.items[0].unfinished)
  expect(final.items[0].segments[0]).toEqual(first.items[0].segments[0])
  expect(final.items[0].segments[1]).toMatchObject({ fullRange: false, rows: [], error: { code: 'invalid_response' } })
})

it.each(['queryList', 'businessList', 'queryBusList'])('REST and MCP preserve a verified remaining-page continuation for %s', async source => {
  upstream.mockImplementation(async () => response(source, [{ relation: '2' }], { page: 2, pageSize: 1, maxCount: 2, maxPage: 2 }))
  for (const invoke of [query, mcp]) {
    const result = await invoke({ ...inputFor(source), startPage: 2 })
    expect(result).toMatchObject({ status: 'success', completeness: 'complete', fullRange: false, declaredTotal: 2, rows: [{ relation: '2' }], unfinished: [] })
  }
})

it.each(['queryList', 'businessList'])('REST and MCP preserve unknown-total and zero-total remaining ranges for %s', async source => {
  for (const maxCount of [undefined, 0]) {
    upstream.mockImplementation(async (_url: string, init: any) => {
      const page = Number(new URLSearchParams(init.body).get('pageNum'))
      return response(source, maxCount === undefined && page === 2 ? [{ relation: 'tail' }] : [], { page, maxCount })
    })
    for (const invoke of [query, mcp]) {
      const result = await invoke({ ...inputFor(source), startPage: 2, pageSize: 50 })
      expect(result).toMatchObject({ status: maxCount === 0 ? 'no_record' : 'success', completeness: 'complete', fullRange: false, declaredTotal: maxCount === 0 ? 0 : null, rows: maxCount === 0 ? [] : [{ relation: 'tail' }], unfinished: [] })
    }
  }
})

it('business retry counts only accepted pages of the unfinished title', async () => {
  const seen: string[] = []
  upstream.mockImplementation(async (_url: string, init: any) => {
    const p = new URLSearchParams(init.body), title = p.get('rdjb'), page = Number(p.get('pageNum')); seen.push(`${title}:${page}`)
    const rows = title === '1' ? [{ relation: 'other:1' }, { relation: 'other:2' }] : title === '3' && page === 1 ? [{ relation: 'target:1' }] : []
    return response('businessList', rows, { page, ...(page === 1 ? { maxCount: title === '1' ? 2 : title === '2' ? 0 : 3 } : {}) })
  })
  const receipt = (await batch('submit', { items: [{ query: { source: 'businessList', uscc, rdjb: 'all', pageSize: 50 } }] })).body as any
  await whenIdle()
  const first = (await batch('status', undefined, receipt.batchId)).body as any
  expect(first).toMatchObject({ completeness: 'partial' })
  expect(first.items[0].unfinished).toEqual([{ source: 'businessList', rdjb: '3', page: 2 }])
  seen.length = 0
  await batch('retry', { itemIds: receipt.itemIds }, receipt.batchId); await whenIdle()
  const final = (await batch('status', undefined, receipt.batchId)).body as any
  expect(final).toMatchObject({ state: 'failed', completeness: 'partial' })
  expect(final.items[0].unfinished).toEqual(first.items[0].unfinished)
  expect(final.items[0].segments[0]).toEqual(first.items[0].segments[0])
  expect(final.items[0].segments.flatMap((s: any) => s.rows).map((r: any) => r.relation)).toEqual(['other:1', 'other:2', 'target:1'])
  expect(seen).toEqual(['3:2'])
})
