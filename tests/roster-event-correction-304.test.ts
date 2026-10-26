import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createApp, createRouter, defineEventHandler, toNodeListener } from 'h3'
import { expect, it, vi } from 'vitest'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { McpToolCallbackResult } from '@nuxtjs/mcp-toolkit/server'
import { schema, useDb } from '../db/client'
import type { EventCorrectionRequest } from '../server/utils/roster-event-correction'
import { dispatchEventCorrectionMcp, isEventCorrectionMcpResult } from '../server/utils/mcp-event-correction'

// Replace only Nuxt registration discovery. Exported tool schemas/handlers,
// MCP SDK HTTP transport, the domain command and SQLite are real.
// This harness does not boot or claim coverage of Nuxt's full MCP middleware.
vi.mock('@nuxtjs/mcp-toolkit/server', () => ({ defineMcpTool: (definition: unknown) => definition }))

// Mirror @nuxtjs/mcp-toolkit 0.24.2 definitions/results.js, including its
// pretty JSON for bare DTOs. Existing content must keep its original bytes.
// #370 R2 keeps transport formatting separate from the complete business-JSON
// byte comparison below; compact encoding here would hide toolkit behavior.
function normalizeFixtureToolResult(result: McpToolCallbackResult): CallToolResult {
  if (typeof result === 'string') return { content: [{ type: 'text', text: result }] }
  if (typeof result === 'number' || typeof result === 'boolean') return { content: [{ type: 'text', text: String(result) }] }
  if (typeof result === 'object' && result !== null
    && !(('content' in result && Array.isArray(result.content)) || 'structuredContent' in result || 'isError' in result)) {
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
  }
  const callResult = result as CallToolResult
  if (callResult.isError && !callResult.content?.length) {
    const text = callResult.structuredContent ? JSON.stringify(callResult.structuredContent) : 'Tool execution failed'
    return { ...callResult, content: [{ type: 'text', text }] }
  }
  if (callResult.structuredContent && !callResult.content?.length) {
    return { ...callResult, content: [{ type: 'text', text: JSON.stringify(callResult.structuredContent) }] }
  }
  return callResult
}

it.each<{
  name: string
  value: McpToolCallbackResult
  expected: unknown
  same?: boolean
}>([
  { name: 'string', value: '原文 "quoted"', expected: { content: [{ type: 'text', text: '原文 "quoted"' }] } },
  { name: 'number', value: 0, expected: { content: [{ type: 'text', text: '0' }] } },
  { name: 'boolean', value: false, expected: { content: [{ type: 'text', text: 'false' }] } },
  {
    name: 'bare-dto-pretty', value: { event: { revision: 2, decidedYear: null }, rows: ['复核', false] },
    expected: { content: [{ type: 'text', text: '{\n  "event": {\n    "revision": 2,\n    "decidedYear": null\n  },\n  "rows": [\n    "复核",\n    false\n  ]\n}' }] },
  },
  { name: 'bare-array-pretty', value: [1, null], expected: { content: [{ type: 'text', text: '[\n  1,\n  null\n]' }] } },
  {
    name: 'compact-content-and-extra-fields', same: true,
    value: { content: [{ type: 'text', text: '{"event":{"revision":2}}' }], structuredContent: { event: { revision: 2 } }, isError: false, _meta: { trace: 'synthetic' }, extra: 'retained' },
    expected: { content: [{ type: 'text', text: '{"event":{"revision":2}}' }], structuredContent: { event: { revision: 2 } }, isError: false, _meta: { trace: 'synthetic' }, extra: 'retained' },
  },
  { name: 'empty-content-preserved', same: true, value: { content: [], extra: 'retained' }, expected: { content: [], extra: 'retained' } },
  { name: 'false-error-marker-preserved', same: true, value: { isError: false, extra: 'retained' }, expected: { isError: false, extra: 'retained' } },
  {
    name: 'non-array-content-is-bare-dto', value: { content: 'business field' },
    expected: { content: [{ type: 'text', text: '{\n  "content": "business field"\n}' }] },
  },
  {
    name: 'structured-fallback', value: { structuredContent: { z: null, a: [false, '复核'] }, _meta: { trace: 'synthetic' }, extra: 'retained' },
    expected: { structuredContent: { z: null, a: [false, '复核'] }, _meta: { trace: 'synthetic' }, extra: 'retained', content: [{ type: 'text', text: '{"z":null,"a":[false,"复核"]}' }] },
  },
  {
    name: 'structured-empty-content-fallback', value: { structuredContent: {}, content: [], extra: 'retained' },
    expected: { structuredContent: {}, content: [{ type: 'text', text: '{}' }], extra: 'retained' },
  },
  {
    name: 'error-fallback', value: { isError: true, extra: 'retained' },
    expected: { isError: true, extra: 'retained', content: [{ type: 'text', text: 'Tool execution failed' }] },
  },
  {
    name: 'error-empty-content-fallback', value: { isError: true, content: [], _meta: { trace: 'synthetic' } },
    expected: { isError: true, content: [{ type: 'text', text: 'Tool execution failed' }], _meta: { trace: 'synthetic' } },
  },
  {
    name: 'error-structured-fallback', value: { isError: true, structuredContent: { error: { code: 'synthetic_conflict' } }, extra: 'retained' },
    expected: { isError: true, structuredContent: { error: { code: 'synthetic_conflict' } }, extra: 'retained', content: [{ type: 'text', text: '{"error":{"code":"synthetic_conflict"}}' }] },
  },
  {
    name: 'error-existing-content', same: true,
    value: { isError: true, content: [{ type: 'text', text: 'original error' }], structuredContent: { error: { code: 'synthetic_conflict' } }, extra: 'retained' },
    expected: { isError: true, content: [{ type: 'text', text: 'original error' }], structuredContent: { error: { code: 'synthetic_conflict' } }, extra: 'retained' },
  },
])('normalizer control preserves toolkit semantics: $name', ({ value, expected, same }) => {
  const result = normalizeFixtureToolResult(value)
  expect(result).toEqual(expected)
  if (same) expect(result).toBe(value)
})

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'issue304-correction-'))
  const dbPath = join(dir, 'synthetic.db'), db = useDb({ dbPath })
  vi.stubEnv('NUXT_DB_PATH', dbPath)
  for (const key of ['MIIT_COOKIE', 'NUXT_OCR_TOKEN', 'PADDLEOCR_MCP_AISTUDIO_ACCESS_TOKEN', 'NUXT_API_TOKEN', 'NUXT_MCP_TOKEN']) vi.stubEnv(key, '')
  vi.stubGlobal('defineEventHandler', defineEventHandler)
  vi.stubGlobal('useRuntimeConfig', () => ({ apiToken: 'issue304-synthetic', mcpToken: 'issue304-synthetic' }))
  const enterprise = db.insert(schema.enterprise).values({ name: '合成多轮复核企业', nameNorm: '合成多轮复核企业' }).returning().get()
  const record = db.insert(schema.record).values({ enterpriseId: enterprise.id, titleCode: 'specialized_sme', source: 'jxj' }).returning().get()
  const seed = (decidedYear: number | null, fields: Partial<typeof schema.recordEvent.$inferInsert> = {}) => {
    const event = db.insert(schema.recordEvent).values({ recordId: record.id, eventType: 'review', year: 2018, decidedYear, batchSeq: 1, ...fields }).returning().get()
    const evidence = db.insert(schema.recordEvidence).values({ recordEventId: event.id, sourceFile: 'synthetic/issue304.pdf', attachment: '复核名单', page: 2, listNo: event.id }).returning().get()
    return { event, evidence }
  }
  const first = seed(2021), second = seed(2024)
  const request = (key: string, operations: EventCorrectionRequest['operations']): EventCorrectionRequest => ({
    idempotencyKey: `issue304-${key}`, sourceIdentity: 'synthetic:issue304', actor: { type: 'agent', id: 'issue304-test' }, basis: 'Synthetic verified announcement conclusions', operations,
  })
  const op = (id: number, patch: EventCorrectionRequest['operations'][number]['patch'], expectedRevision = 1) => ({ eventId: id, recordId: record.id, enterpriseId: enterprise.id, expectedRevision, patch })
  const { eventCorrectionRoute } = await import('../server/utils/roster-event-correction-route')
  const { correspondenceRoute } = await import('../server/utils/record-correspondence-route')
  const { default: annualRoute } = await import('../server/api/roster/events/[id]/annual-process.get')
  const router = createRouter(), app = createApp()
  router.use('/api/roster/events/corrections/preflight', eventCorrectionRoute('preflight'))
  router.use('/api/roster/events/corrections/commit', eventCorrectionRoute('commit'))
  router.use('/api/roster/events/:id/audit', eventCorrectionRoute('audit'))
  router.use('/api/roster/events/:id/annual-process', annualRoute)
  router.use('/api/roster/events/:id', eventCorrectionRoute('get'))
  router.use('/api/roster/correspondences/preflight', correspondenceRoute('preflight'))
  router.use('/api/roster/correspondences/commit', correspondenceRoute('commit'))
  router.use('/api/roster/correspondences/:id', correspondenceRoute('get', { id: true }))
  app.use(router)
  const [{ default: preflight }, { default: commit }, { default: get }, { default: auditTool }] = await Promise.all([
    import('../server/mcp/tools/preflight_event_corrections'),
    import('../server/mcp/tools/commit_event_corrections'),
    import('../server/mcp/tools/get_official_event'),
    import('../server/mcp/tools/get_event_correction_audit'),
  ])
  const sessions: McpServer[] = []
  const serveMcp = async (req: Parameters<typeof listener>[0], res: Parameters<typeof listener>[1]) => {
    // The SDK requires a fresh stateless transport for every HTTP request.
    const mcp = new McpServer({ name: 'issue304-isolated', version: '1' }); sessions.push(mcp)
    mcp.registerTool(preflight.name!, { inputSchema: preflight.inputSchema }, async (args, extra) => normalizeFixtureToolResult(await preflight.handler(args, extra)))
    mcp.registerTool(commit.name!, { inputSchema: commit.inputSchema }, async (args, extra) => normalizeFixtureToolResult(await commit.handler(args, extra)))
    mcp.registerTool(get.name!, { inputSchema: get.inputSchema }, async (args, extra) => normalizeFixtureToolResult(await get.handler(args, extra)))
    mcp.registerTool(auditTool.name!, { inputSchema: auditTool.inputSchema }, async (args, extra) => normalizeFixtureToolResult(await auditTool.handler(args, extra)))
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    await mcp.connect(transport)
    await transport.handleRequest(req, res)
  }
  const listener = toNodeListener(app)
  const server = createServer((req, res) => {
    if (req.url !== '/mcp') return listener(req, res)
    void serveMcp(req, res).catch(error => { res.statusCode = 500; res.end(String(error)) })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const http = async (path: string, body?: unknown) => {
    const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer issue304-synthetic' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    return { status: response.status, body: await response.json() }
  }
  const post = (action: string, body: unknown) => http(`/api/roster/events/corrections/${action}`, body)
  const read = (id: number) => http(`/api/roster/events/${id}`)
  const audit = (id: number) => http(`/api/roster/events/${id}/audit`)
  const rpc = async (name: string, args: unknown) => {
    const response = await fetch(base + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) })
    const raw = await response.text()
    expect(response.status, raw).toBe(200)
    const wire = JSON.parse(raw)
    expect(wire.error).toBeUndefined()
    return wire.result
  }
  const call = async (name: string, args: unknown) => {
    const result = await rpc(name, args)
    expect(result.isError).not.toBe(true)
    return JSON.parse(result.content[0].text)
  }
  return { db, dbPath, base, enterprise, record, seed, first, second, request, op, http, post, read, audit, rpc, call, close: async () => {
    await new Promise<void>(resolve => server.close(() => resolve()))
    await Promise.all(sessions.map(session => session.close()))
    db.$client.close()
    vi.unstubAllGlobals(); vi.unstubAllEnvs()
    rmSync(dir, { recursive: true, force: true })
  } }
}

it('corrects both 2018-origin review rounds through HTTP with stable IDs and append-only replayable audit', async () => {
  const f = await fixture()
  try {
    const { first, second } = f
    const before = await Promise.all([f.read(first.event.id), f.read(second.event.id)])
    const request = f.request('two-rounds', [f.op(first.event.id, { reviewOutcome: 'passed' }), f.op(second.event.id, { reviewOutcome: 'passed' })])
    const plan = await f.post('preflight', request)
    expect(plan.status).toBe(200)
    expect(await Promise.all([f.read(first.event.id), f.read(second.event.id)])).toEqual(before)
    const receipt = await f.post('commit', { request, planHash: plan.body.planHash })
    expect(receipt.status).toBe(200)
    expect(receipt.body.eventIds).toEqual([first.event.id, second.event.id])
    expect(await f.post('commit', { request, planHash: plan.body.planHash })).toEqual(receipt)
    for (const source of [first, second]) {
      expect((await f.read(source.event.id)).body).toMatchObject({ event: { ...source.event, reviewOutcome: 'passed', revision: 2 }, evidence: [source.evidence] })
      expect((await f.audit(source.event.id)).body).toMatchObject({ total: 1, rows: [{ eventId: source.event.id, before: source.event, after: { ...source.event, reviewOutcome: 'passed', revision: 2 }, evidence: [source.evidence] }] })
    }
    const next = f.request('first-round-followup', [f.op(first.event.id, { reviewOutcome: 'failed' }, 2)])
    const nextPlan = await f.post('preflight', next)
    expect(nextPlan.status).toBe(200)
    expect((await f.post('commit', { request: next, planHash: nextPlan.body.planHash })).status).toBe(200)
    expect((await f.audit(first.event.id)).body).toMatchObject({ total: 2, rows: [{ after: { revision: 2, reviewOutcome: 'passed' } }, { before: { revision: 2 }, after: { revision: 3, reviewOutcome: 'failed' } }] })
    expect((await f.read(second.event.id)).body.event).toEqual({ ...second.event, reviewOutcome: 'passed', revision: 2 })
  } finally { await f.close() }
})

it('corrects a review round through MCP HTTP and reads the same stable event evidence receipt and audit', async () => {
  const f = await fixture()
  try {
    const before = (await f.read(f.second.event.id)).body
    const request = f.request('mcp-round', [f.op(f.first.event.id, { decidedYear: 2022, reviewOutcome: 'passed' })])
    const plan = await f.call('preflight_event_corrections', request)
    expect(plan).toMatchObject({ batchStatus: 'preflight', targets: [{ before: { decidedYear: 2021 }, after: { decidedYear: 2022 } }] })
    expect((await f.call('get_official_event', { eventId: f.first.event.id })).event.revision).toBe(1)
    const receipt = await f.call('commit_event_corrections', { request, planHash: plan.planHash })
    expect(receipt.eventIds).toEqual([f.first.event.id])
    expect(await f.call('commit_event_corrections', { request, planHash: plan.planHash })).toEqual(receipt)
    const read = await f.call('get_official_event', { eventId: f.first.event.id })
    expect(read).toEqual((await f.read(f.first.event.id)).body)
    expect(read).toMatchObject({ event: { id: f.first.event.id, year: 2018, batchSeq: 1, decidedYear: 2022, reviewOutcome: 'passed', revision: 2 }, evidence: [f.first.evidence] })
    const audit = await f.call('get_event_correction_audit', { eventId: f.first.event.id, page: 1, pageSize: 1 })
    expect(audit).toMatchObject({ total: 1, rows: [{ before: f.first.event, after: { decidedYear: 2022, revision: 2 }, evidence: [f.first.evidence] }] })
    expect(audit).toEqual((await f.http(`/api/roster/events/${f.first.event.id}/audit?page=1&pageSize=1`)).body)
    expect((await f.read(f.second.event.id)).body).toMatchObject({ event: before.event, record: before.record, evidence: before.evidence, files: before.files })
    const conflicting = f.request('mcp-opposite-outcome', [f.op(f.first.event.id, { decidedYear: 2024, reviewOutcome: 'failed' }, 2)])
    const rejected = await f.rpc('preflight_event_corrections', conflicting)
    expect(rejected.isError).toBe(true)
    expect(rejected.content[0].text).toContain('Another event occupies')
    expect((await f.audit(f.first.event.id)).body.total).toBe(1)
  } finally { await f.close() }
})

it.each(['passed', 'failed'] as const)('rejects the same review matter with a %s outcome without partial writes', async outcome => {
  const f = await fixture()
  try {
    f.db.$client.prepare('UPDATE record_event SET review_outcome = ? WHERE id = ?').run('passed', f.second.event.id)
    const before = await Promise.all([f.read(f.first.event.id), f.read(f.second.event.id)])
    const request = f.request(`same-matter-${outcome}`, [f.op(f.first.event.id, { decidedYear: 2024, reviewOutcome: outcome })])
    expect(await f.post('preflight', request)).toMatchObject({ status: 409, body: { error: { code: 'natural_key_conflict' } } })
    expect(await Promise.all([f.read(f.first.event.id), f.read(f.second.event.id)])).toEqual(before)
    for (const id of [f.first.event.id, f.second.event.id]) expect((await f.audit(id)).body).toMatchObject({ total: 0, rows: [] })
  } finally { await f.close() }
})

it('checks both projected review rounds and permits a swap while rejecting final-state convergence', async () => {
  const f = await fixture()
  try {
    const converging = f.request('converging-rounds', [f.op(f.first.event.id, { decidedYear: 2023, reviewOutcome: 'passed' }), f.op(f.second.event.id, { decidedYear: 2023, reviewOutcome: 'failed' })])
    expect(await f.post('preflight', converging)).toMatchObject({ status: 409, body: { error: { code: 'natural_key_conflict' } } })
    expect((await f.read(f.first.event.id)).body.event).toEqual(f.first.event)
    expect((await f.read(f.second.event.id)).body.event).toEqual(f.second.event)
    const swapping = f.request('swapping-rounds', [f.op(f.first.event.id, { decidedYear: 2024 }), f.op(f.second.event.id, { decidedYear: 2021 })])
    const plan = await f.post('preflight', swapping)
    expect(plan.status).toBe(200)
    expect((await f.post('commit', { request: swapping, planHash: plan.body.planHash })).status).toBe(200)
    for (const [source, decidedYear] of [[f.first, 2024], [f.second, 2021]] as const) {
      expect((await f.read(source.event.id)).body).toMatchObject({ event: { ...source.event, decidedYear, revision: 2 }, evidence: [source.evidence] })
      expect((await f.audit(source.event.id)).body.total).toBe(1)
    }
  } finally { await f.close() }
})

it.each([
  { name: 'incoming-unknown-decision', setup: '', patch: { decidedYear: null } },
  { name: 'stored-unknown-decision', setup: 'UPDATE record_event SET decided_year = NULL WHERE decided_year = 2024', patch: { reviewOutcome: 'passed' as const } },
  { name: 'unknown-original-batch', setup: 'UPDATE record_event SET batch_seq = NULL', patch: { reviewOutcome: 'passed' as const } },
  { name: 'unknown-original-year', setup: 'UPDATE record_event SET year = NULL', patch: { reviewOutcome: 'passed' as const } },
])('preserves conservative collision protection for $name', async ({ name, setup, patch }) => {
  const f = await fixture()
  try {
    if (setup) f.db.$client.exec(setup)
    const before = await Promise.all([f.read(f.first.event.id), f.read(f.second.event.id)])
    const request = f.request(name, [f.op(f.first.event.id, patch)])
    expect(await f.post('preflight', request)).toMatchObject({ status: 409, body: { error: { code: 'natural_key_conflict' } } })
    expect(await Promise.all([f.read(f.first.event.id), f.read(f.second.event.id)])).toEqual(before)
    expect((await f.audit(f.first.event.id)).body.total).toBe(0)
  } finally { await f.close() }
})

it('rejects an invalid committed MCP receipt as an internal error without swallowing business errors or appending audit', async () => {
  const f = await fixture()
  try {
    const request = f.request('invalid-mcp-receipt', [f.op(f.first.event.id, { reviewOutcome: 'passed' })])
    const plan = await f.call('preflight_event_corrections', request)
    const args = { request, planHash: plan.planHash }
    const receipt = await f.call('commit_event_corrections', args)
    const before = await f.read(f.first.event.id), auditBefore = await f.audit(f.first.event.id)
    const stale = f.request('stale-before-result-guard', [f.op(f.first.event.id, { reviewOutcome: 'failed' })])
    expect(() => dispatchEventCorrectionMcp('preflight', stale, { db: f.db, authorized: true })).toThrowError(expect.objectContaining({ code: 'stale_revision', statusCode: 409 }))
    expect(() => dispatchEventCorrectionMcp('preflight', stale, { db: f.db })).toThrowError(expect.objectContaining({ code: 'unauthorized', statusCode: 401 }))
    // A malformed historical receipt is not a new business decision or a reason to rewrite it.
    f.db.$client.prepare('UPDATE import_batch SET summary = NULL WHERE id = ?').run(receipt.batchId)
    expect(() => dispatchEventCorrectionMcp('commit', args, { db: f.db, authorized: true })).toThrowError(expect.objectContaining({ code: 'internal_error', statusCode: 500, message: 'Invalid event correction MCP result' }))
    const rejected = await f.rpc('commit_event_corrections', args)
    expect(rejected).toEqual({ isError: true, content: [{ type: 'text', text: 'Invalid event correction MCP result' }] })
    expect(await f.read(f.first.event.id)).toEqual(before)
    expect(await f.audit(f.first.event.id)).toEqual(auditBefore)
  } finally { await f.close() }
})

it.each([
  { name: 'empty-string', value: '' },
  { name: 'zero', value: 0 },
  { name: 'false', value: false },
  { name: 'empty-array', value: [] },
  { name: 'empty-record', value: {} },
  { name: 'array-with-json-omissions', value: [1, 'result', null, undefined] },
  { name: 'nested-record', value: { result: { rows: [1, 2], missing: undefined, unknown: null } } },
  { name: 'null-prototype-record', value: { __proto__: null, result: 'safe' } },
  { name: 'sdk-tool-result', value: { content: [{ type: 'text', text: 'result' }], isError: false, structuredContent: { total: 0 } } },
])('accepts a transport-safe SDK result without changing its bytes: $name', ({ value }) => {
  const before = JSON.stringify(value)
  expect(isEventCorrectionMcpResult(value)).toBe(true)
  expect(JSON.stringify(value)).toBe(before)
})

it.each([
  { name: 'null-root', value: null },
  { name: 'undefined-root', value: undefined },
  { name: 'function', value: () => 'not a result' },
  { name: 'symbol', value: Symbol('not a result') },
  { name: 'bigint', value: 1n },
  { name: 'non-record-object', value: new Date('2026-10-25T00:00:00Z') },
  { name: 'nested-non-record', value: { result: new Map([['key', 'value']]) } },
  { name: 'symbol-property', value: { [Symbol('hidden')]: 'not a JSON field' } },
])('rejects an unsupported SDK result: $name', ({ value }) => {
  expect(isEventCorrectionMcpResult(value)).toBe(false)
})

it('rejects object code and cycles without executing accessors proxies or toJSON and permits shared references', () => {
  let executed = false
  const accessor = { get value() { executed = true; return 'unsafe' } }
  const proxy = new Proxy({}, { getPrototypeOf() { executed = true; throw new Error('unsafe proxy') } })
  const customJson = { toJSON() { executed = true; return 'unsafe' } }
  const cyclic: { self?: unknown } = {}; cyclic.self = cyclic
  for (const value of [accessor, proxy, { nested: customJson }, cyclic]) expect(isEventCorrectionMcpResult(value)).toBe(false)
  expect(executed).toBe(false)
  const shared = { value: 'safe' }, result = { first: shared, second: shared }
  expect(isEventCorrectionMcpResult(result)).toBe(true)
  expect(JSON.stringify(result)).toBe('{"first":{"value":"safe"},"second":{"value":"safe"}}')
})

// Historical case name retained. #370 R2 explicitly revises the old raw-wire
// oracle: compare complete business JSON bytes after ONE MCP text parse and
// compact serialization, preserving every value and object key sequence.
// Toolkit pretty DTOs and get_official_event's compact content differ on wire;
// assert their full envelopes/formats separately, never recursively unwrap.
it('preserves exact REST and MCP result bytes for preflight commit replay event and audit', async () => {
  const f = await fixture()
  try {
    const request = f.request('mcp-result-bytes', [f.op(f.first.event.id, { reviewOutcome: 'passed' })])
    const compare = async (path: string, name: string, args: Record<string, unknown>, body?: unknown) => {
      const response = await fetch(f.base + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer issue304-synthetic' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
      expect(response.status).toBe(200)
      const bytes = await response.text(), wire = await f.rpc(name, args)
      expect(wire.isError).not.toBe(true)
      expect(JSON.stringify(JSON.parse(wire.content[0].text))).toBe(bytes)
      expect(wire).toEqual({ content: [{ type: 'text', text: name === 'get_official_event' ? bytes : JSON.stringify(JSON.parse(bytes), null, 2) }] })
      return JSON.parse(bytes)
    }
    const plan = await compare('/api/roster/events/corrections/preflight', 'preflight_event_corrections', request, request)
    const args = { request, planHash: plan.planHash }
    const receipt = await compare('/api/roster/events/corrections/commit', 'commit_event_corrections', args, args)
    expect(receipt.eventIds).toEqual([f.first.event.id])
    expect(await compare('/api/roster/events/corrections/commit', 'commit_event_corrections', args, args)).toEqual(receipt)
    const read = await compare(`/api/roster/events/${f.first.event.id}`, 'get_official_event', { eventId: f.first.event.id })
    expect(read).toMatchObject({ event: { id: f.first.event.id, revision: 2 }, evidence: [f.first.evidence] })
    const audit = await compare(`/api/roster/events/${f.first.event.id}/audit`, 'get_event_correction_audit', { eventId: f.first.event.id })
    expect(audit).toMatchObject({ total: 1, rows: [{ eventId: f.first.event.id, before: { revision: 1 }, after: { revision: 2 } }] })
  } finally { await f.close() }
})

it('isolates corrections from matching review coordinates on another enterprise or title and preserves explicit unknowns', async () => {
  const f = await fixture()
  try {
    const otherEnterprise = f.db.insert(schema.enterprise).values({ name: '合成对照企业', nameNorm: '合成对照企业' }).returning().get()
    const records = [
      f.db.insert(schema.record).values({ enterpriseId: otherEnterprise.id, titleCode: 'specialized_sme', source: 'jxj' }).returning().get(),
      f.db.insert(schema.record).values({ enterpriseId: f.enterprise.id, titleCode: 'innovative_sme', source: 'jxj' }).returning().get(),
    ]
    const controls = records.map(record => f.seed(2021, { recordId: record.id, reviewOutcome: 'failed' }))
    const before = await Promise.all(controls.map(source => f.read(source.event.id)))
    const request = f.request('scope-isolation', [f.op(f.first.event.id, { reviewOutcome: 'passed' })])
    const plan = await f.post('preflight', request)
    expect(plan.status).toBe(200)
    expect((await f.post('commit', { request, planHash: plan.body.planHash })).status).toBe(200)
    expect(await Promise.all(controls.map(source => f.read(source.event.id)))).toEqual(before)
    const unknown = f.request('explicit-unknowns', [f.op(f.first.event.id, { batchSeq: null, decidedYear: null, reviewOutcome: null }, 2)])
    const unknownPlan = await f.post('preflight', unknown)
    expect(unknownPlan.status).toBe(200)
    expect((await f.post('commit', { request: unknown, planHash: unknownPlan.body.planHash })).status).toBe(200)
    expect((await f.read(f.first.event.id)).body).toMatchObject({ event: { year: 2018, batchSeq: null, decidedYear: null, reviewOutcome: null, revision: 3 }, evidence: [f.first.evidence] })
    expect((await f.read(f.second.event.id)).body.event).toEqual(f.second.event)
  } finally { await f.close() }
})

it('rejects evidence and revision drift after multi-round preflight without changing the second round', async () => {
  const f = await fixture()
  try {
    const request = f.request('source-version-drift', [f.op(f.first.event.id, { reviewOutcome: 'passed' }), f.op(f.second.event.id, { reviewOutcome: 'passed' })])
    const plan = await f.post('preflight', request)
    expect(plan.status).toBe(200)
    f.db.$client.prepare('UPDATE record_evidence SET page = 3 WHERE id = ?').run(f.first.evidence.id)
    expect(await f.post('commit', { request, planHash: plan.body.planHash })).toMatchObject({ status: 409, body: { error: { code: 'plan_mismatch' } } })
    f.db.$client.prepare('UPDATE record_evidence SET page = 2 WHERE id = ?').run(f.first.evidence.id)
    const concurrent = f.request('new-revision', [f.op(f.first.event.id, { reviewOutcome: 'failed' })])
    const otherPlan = await f.post('preflight', concurrent)
    expect(otherPlan.status).toBe(200)
    expect((await f.post('commit', { request: concurrent, planHash: otherPlan.body.planHash })).status).toBe(200)
    expect(await f.post('commit', { request, planHash: plan.body.planHash })).toMatchObject({ status: 409, body: { error: { code: 'stale_revision' } } })
    expect((await f.read(f.first.event.id)).body.event).toMatchObject({ revision: 2, reviewOutcome: 'failed' })
    expect((await f.audit(f.first.event.id)).body.total).toBe(1)
    expect((await f.read(f.second.event.id)).body.event).toEqual(f.second.event)
    expect((await f.audit(f.second.event.id)).body.total).toBe(0)
    expect((await f.post('preflight', request)).body.batchStatus).toBe('preflight')
  } finally { await f.close() }
})

it('rolls back both review rounds audit revisions and receipt after a later SQL failure and retries the original plan', async () => {
  const f = await fixture()
  try {
    const request = f.request('atomic-rounds', [f.op(f.first.event.id, { reviewOutcome: 'passed' }), f.op(f.second.event.id, { reviewOutcome: 'passed' })])
    const before = await Promise.all([f.read(f.first.event.id), f.read(f.second.event.id)])
    const plan = await f.post('preflight', request)
    expect(plan.status).toBe(200)
    f.db.$client.exec(`CREATE TRIGGER issue304_fail_second BEFORE UPDATE ON record_event WHEN OLD.id = ${f.second.event.id} BEGIN SELECT RAISE(ABORT, 'issue304 synthetic failure'); END`)
    expect(await f.post('commit', { request, planHash: plan.body.planHash })).toMatchObject({ status: 500, body: { error: { code: 'transaction_failed' } } })
    expect(await Promise.all([f.read(f.first.event.id), f.read(f.second.event.id)])).toEqual(before)
    for (const id of [f.first.event.id, f.second.event.id]) expect((await f.audit(id)).body.total).toBe(0)
    expect((await f.post('preflight', request)).body.batchStatus).toBe('preflight')
    f.db.$client.exec('DROP TRIGGER issue304_fail_second')
    const receipt = await f.post('commit', { request, planHash: plan.body.planHash })
    expect(receipt).toMatchObject({ status: 200, body: { eventIds: [f.first.event.id, f.second.event.id] } })
    expect(await f.post('commit', { request, planHash: plan.body.planHash })).toEqual(receipt)
    for (const source of [f.first, f.second]) {
      expect((await f.read(source.event.id)).body).toMatchObject({ event: { ...source.event, reviewOutcome: 'passed', revision: 2 }, evidence: [source.evidence] })
      expect((await f.audit(source.event.id)).body.total).toBe(1)
    }
  } finally { await f.close() }
})

it('preserves correspondence IDs while requiring revalidation and changing annual source generation after a review correction', async () => {
  const f = await fixture()
  try {
    const query = f.db.insert(schema.platformQuery).values({ interface: 'business_list', queryKey: 'synthetic-issue304', rdjb: '2', titleCode: 'specialized_sme', queriedAt: '2026-10-25', status: 'success' }).returning().get()
    const relation = f.db.insert(schema.platformRelation).values({ queryId: query.id, sequenceNo: 1, enterpriseId: f.enterprise.id, verificationStatus: 'confirmed', declareKind: 'review', year: 2021 }).returning().get()
    const correspondence = { idempotencyKey: 'issue304-correspondence', sourceIdentity: 'synthetic:issue304', actor: { type: 'agent', id: 'issue304-test' }, basis: 'Explicit synthetic row context', ruleId: 'manual', ruleVersion: '1', operations: [{ action: 'create', status: 'confirmed', edge: { type: 'event_process', eventId: f.first.event.id, relationId: relation.id, role: 'context_only' } }] }
    const confirmedPlan = await f.http('/api/roster/correspondences/preflight', correspondence)
    expect(confirmedPlan.status).toBe(200)
    const confirmed = await f.http('/api/roster/correspondences/commit', { request: correspondence, planHash: confirmedPlan.body.planHash })
    expect(confirmed.status).toBe(200)
    const correspondenceId = confirmed.body.correspondenceIds[0]
    const path = `/api/roster/correspondences/${correspondenceId}`
    const before = (await f.http(path)).body
    expect(before).toMatchObject({ id: correspondenceId, requiresRevalidation: false, status: 'confirmed' })
    const annualBefore = await f.http(`/api/roster/events/${f.first.event.id}/annual-process`)
    expect(annualBefore.status).toBe(200)
    const request = f.request('correspondence-source-change', [f.op(f.first.event.id, { reviewOutcome: 'passed' })])
    const plan = await f.post('preflight', request)
    expect(plan.status).toBe(200)
    expect(plan.body.impact.requiresRevalidation).toBe(1)
    expect((await f.post('commit', { request, planHash: plan.body.planHash })).status).toBe(200)
    expect((await f.http(path)).body).toMatchObject({ id: correspondenceId, eventId: f.first.event.id, relationId: relation.id, status: 'confirmed', requiresRevalidation: true })
    const annualAfter = await f.http(`/api/roster/events/${f.first.event.id}/annual-process`)
    expect(annualAfter.status).toBe(200)
    expect(annualAfter.body.sourceGeneration).not.toBe(annualBefore.body.sourceGeneration)
    expect(annualAfter.body.sourceRefs.event).toMatchObject({ id: f.first.event.id, revision: 2, year: 2018, decidedYear: 2021 })
    expect((await f.read(f.first.event.id)).body.evidence).toEqual([f.first.evidence])
  } finally { await f.close() }
})

it('rechecks sibling occupancy at commit and leaves the other correction and receipt uncommitted', async () => {
  const f = await fixture()
  try {
    const request = f.request('occupancy-drift', [f.op(f.first.event.id, { decidedYear: 2022 })])
    const plan = await f.post('preflight', request)
    expect(plan.status).toBe(200)
    const competing = f.request('competing-round', [f.op(f.second.event.id, { decidedYear: 2022, reviewOutcome: 'failed' })])
    const otherPlan = await f.post('preflight', competing)
    expect(otherPlan.status).toBe(200)
    expect((await f.post('commit', { request: competing, planHash: otherPlan.body.planHash })).status).toBe(200)
    expect(await f.post('commit', { request, planHash: plan.body.planHash })).toMatchObject({ status: 409, body: { error: { code: 'natural_key_conflict' } } })
    expect((await f.read(f.first.event.id)).body.event).toEqual(f.first.event)
    expect((await f.audit(f.first.event.id)).body.total).toBe(0)
    expect((await f.post('preflight', request)).body.batchStatus).toBe('preflight')
  } finally { await f.close() }
})

it.each([
  { name: 'stale-version', overrides: { expectedRevision: 2 }, code: 'stale_revision', status: 409 },
  { name: 'wrong-enterprise', overrides: { enterpriseId: 999999 }, code: 'target_mismatch', status: 409 },
  { name: 'wrong-record', overrides: { recordId: 999999 }, code: 'target_mismatch', status: 409 },
  { name: 'no-change', overrides: { patch: { decidedYear: 2024 } }, code: 'no_change', status: 422 },
  { name: 'invalid-outcome', overrides: { patch: { reviewOutcome: 'unknown' } }, code: 'invalid_request', status: 400 },
  { name: 'invalid-batch', overrides: { patch: { batchSeq: 0 } }, code: 'invalid_request', status: 400 },
  { name: 'invalid-year-order', overrides: { patch: { decidedYear: 2017 } }, code: 'invalid_event_combination', status: 422 },
])('rejects an entire multi-round batch for $name', async ({ name, overrides, code, status }) => {
  const f = await fixture()
  try {
    const before = await Promise.all([f.read(f.first.event.id), f.read(f.second.event.id)])
    const request = f.request(name, [f.op(f.first.event.id, { reviewOutcome: 'passed' }), f.op(f.second.event.id, { reviewOutcome: 'passed' })])
    const invalid = { ...request, operations: [request.operations[0], { ...request.operations[1], ...overrides }] }
    expect(await f.post('preflight', invalid)).toMatchObject({ status, body: { error: { code } } })
    expect(await Promise.all([f.read(f.first.event.id), f.read(f.second.event.id)])).toEqual(before)
    for (const id of [f.first.event.id, f.second.event.id]) expect((await f.audit(id)).body.total).toBe(0)
  } finally { await f.close() }
})
