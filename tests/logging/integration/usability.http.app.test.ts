
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { spawnOwnedChild as spawn, reserveLoopbackPort, stopOwnedChild, waitForHttp } from '../../support/owned-process.mjs'
import { postgresRuntimeFixture } from '../../support/postgres-fixture.mjs'
import { storedLogRows } from '../fixtures/runtime'
import { businessDigest } from '../fixtures/business-state'
import { APPLICATION_LOG_ROUTES } from '../../../lib/logging-route-templates'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

/**
 * #180 actual built Nuxt seam: a fresh synthetic business DB and an independent
 * PostgreSQL log schema. Only public HTTP is asserted; the parent service/fixture is
 * never touched.
 */
const root = mkdtempSync(join(tmpdir(), 'log-usability-180-http-'))
const token = 'synthetic-log180-api', mcpToken = 'synthetic-log180-mcp'
const PRIVATE = 'PRIVATE180_HTTP_NONCE'
let runtime: Awaited<ReturnType<typeof postgresRuntimeFixture>>
let child: ReturnType<typeof spawn>, baseUrl = '', output = ''

const apiHeaders = { authorization: `Bearer ${token}` }
const url = (path: string) => baseUrl + path
async function json(response: Response) { return response.json() as Promise<any> }
async function call(path: string, init: RequestInit = {}) {
  const response = await fetch(url(path), init)
  const text = await response.text()
  let body: any
  try { body = JSON.parse(text) } catch { body = text }
  return { status: response.status, body, headers: response.headers, requestId: response.headers.get('x-request-id')! }
}
async function logs(filter: string) {
  const response = await call('/api/logs?' + new URLSearchParams({ limit: '100', ...Object.fromEntries(new URLSearchParams(filter)) }), { headers: apiHeaders })
  expect(response.status).toBe(200)
  return response.body.rows as any[]
}
async function waitLog(requestId: string) {
  for (let i = 0; i < 80; i++) {
    const rows = await logs('requestId=' + requestId)
    if (rows.length) return rows
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('request log did not persist')
}
async function detail(id: string) {
  const response = await call('/api/logs/' + id, { headers: apiHeaders })
  expect(response.status).toBe(200)
  return response.body
}
async function mcp(method: string, params: unknown, tokenValue?: string) {
  return call('/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(tokenValue ? { authorization: `Bearer ${tokenValue}` } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
}

beforeAll(async () => {
  runtime = await postgresRuntimeFixture({ dir: root })
  const port = await reserveLoopbackPort()
  baseUrl = `http://127.0.0.1:${port}`
  child = spawn(process.execPath, ['.output/server/index.mjs'], {
    cwd: resolve(import.meta.dirname, '../../..'),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env, ...runtime.env, HOST: '127.0.0.1', PORT: String(port), NODE_ENV: 'production',
      NUXT_DB_READONLY: '0',
      NUXT_FILES_DIR: join(root, 'files'), NUXT_INCOMING_DIR: join(root, 'incoming'),
      NUXT_API_TOKEN: token, NUXT_MCP_TOKEN: mcpToken, NUXT_CURATED_PATH: join(root, 'curated.json'), NUXT_RECONCILE_PATH: join(root, 'reconcile.json'),
    },
  })
  child.stdout!.on('data', chunk => { output += chunk.toString() })
  child.stderr!.on('data', chunk => { output += chunk.toString() })
  mkdirSync(join(root, 'files'), { recursive: true })
  mkdirSync(join(root, 'incoming'), { recursive: true })
  await waitForHttp(url('/api/health'), { child, timeoutMs: 120_000 })
}, 360_000)

afterAll(async () => {
  if (child) await stopOwnedChild(child)
  runtime?.close()
  writeFileSync(join(root, 'server.log'), output)
  rmSync(root, { recursive: true, force: true })
})

it('records a real matched HTTP template and method in the protected list and detail', async () => {
  const health = await call(`/api/health?probe=${PRIVATE}`, { headers: { authorization: `Bearer ${PRIVATE}`, cookie: PRIVATE } })
  expect(health.status).toBe(200)
  const rows = await waitLog(health.requestId)
  expect(rows).toHaveLength(1)
  const summary = rows[0]
  expect(summary).toMatchObject({
    source: 'http', module: 'core', operation: 'http.request', outcome: 'success', statusCode: 200,
    origin: {runtime:'node',integration:'nuxt-nitro',capture:'framework',execution:'request'},
    httpMethod: 'GET', httpRoute: '/api/health',
  })
  const event = await detail(summary.id)
  expect(event).toMatchObject({ id: summary.id, module: 'core', httpMethod: 'GET', httpRoute: '/api/health', statusCode: 200 })
  expect(await logs(`requestId=${health.requestId}&module=core&source=http&level=info&outcome=success`))
    .toMatchObject([{ id: summary.id, module: 'core' }])
  expect(await logs(`requestId=${health.requestId}&module=sme-roster`)).toEqual([])
  expect((await call('/api/logs?module=unknown-module', { headers: apiHeaders })).status).toBe(400)
  expect(JSON.stringify({ summary, event })).not.toContain(PRIVATE)
  expect(output).not.toContain(PRIVATE)

  const denied = await call('/api/logs', {})
  expect(denied.status).toBe(401)
  const deniedDetail = await call('/api/logs/' + summary.id, {})
  expect(deniedDetail.status).toBe(401)
})

it('uses a dynamic route template without persisting the concrete id or query value', async () => {
  const response = await call(`/api/files/987654321?name=${PRIVATE}`, { headers: { 'x-request-id': PRIVATE, cookie: PRIVATE } })
  expect([400, 404, 415, 500]).toContain(response.status)
  const rows = await waitLog(response.requestId)
  expect(rows).toHaveLength(1)
  const summary = rows[0]
  expect(summary).toMatchObject({ source: 'http', module: 'core', httpMethod: 'GET', httpRoute: '/api/files/:id' })
  const serialized = JSON.stringify({ summary, detail: await detail(summary.id) })
  expect(serialized).not.toContain('987654321')
  expect(serialized).not.toContain(PRIVATE)
  expect(storedLogRows(runtime)).not.toContain('987654321')
  expect(storedLogRows(runtime)).not.toContain(PRIVATE)
})

for (const action of ['commit', 'preflight'] as const) it(`retains the parse-result ${action} template on authenticated invalid-id POST without business writes`, async () => {
  // Invalid IDs are rejected before opening the business DB or reading a file.
  const fileId = 'issue375-invalid-file-853629741'
  const path = `/api/files/${fileId}/parse-result/${action}`
  const requestURL = new URL(path, baseUrl).href
  const template = `/api/files/:id/parse-result/${action}`
  const dbHash = () => businessDigest(runtime)
  const before = dbHash()
  const response = await call(path, { method: 'POST', headers: { ...apiHeaders, 'content-type': 'application/json' }, body: '{}' })
  expect(response.status).toBe(400)
  // Nitro echoes the submitted URL here; ID privacy covers protected log responses below.
  expect(response.body.url).toBe(requestURL)
  expect(response.headers.get('cache-control')).toBe('no-store')
  expect(response.body.message).toBe('文件 ID 非法')
  expect(response.requestId).toBeTruthy()
  const rows = await waitLog(response.requestId)
  const event = rows.find(row => row.operation === 'http.request')
  expect(event).toMatchObject({ source: 'http', httpMethod: 'POST', httpRoute: template, statusCode: 400 })
  const stored = await detail(event.id)
  expect(stored).toEqual(event)
  expect(JSON.stringify({ rows, stored })).not.toContain(fileId)
  expect(output).not.toContain(fileId)
  expect(storedLogRows(runtime)).not.toContain(fileId)
  expect(dbHash()).toBe(before)
})

it('records the MCP transport template and exposes the same facts through MCP', async () => {
  const listed = await mcp('tools/list', {})
  expect(listed.status).toBe(200)
  const rows = await waitLog(listed.requestId)
  expect(rows[0]).toMatchObject({ source: 'mcp', module: 'core', operation: 'mcp.request', httpMethod: 'POST', httpRoute: '/mcp', origin: {runtime:'node',integration:'mcp-toolkit',capture:'framework',execution:'request'} })

  const rpc = await mcp('tools/call', { name: 'list_runtime_logs', arguments: { requestId: rows[0].requestId, module: 'core', source: 'mcp' } }, mcpToken)
  expect(rpc.status).toBe(200)
  const payload = rpc.body.result.structuredContent ?? JSON.parse(rpc.body.result.content[0].text)
  expect(payload.rows).toMatchObject([{ module: 'core', httpMethod: 'POST', httpRoute: '/mcp' }])
  const excluded = await mcp('tools/call', { name: 'list_runtime_logs', arguments: { requestId: rows[0].requestId, module: 'sme-roster' } }, mcpToken)
  expect(excluded.status).toBe(200)
  expect((excluded.body.result.structuredContent ?? JSON.parse(excluded.body.result.content[0].text)).rows).toEqual([])
})

it('captures real MCP SDK initialize clientInfo once and keeps stateless tool calls unattributed', async () => {
  const client = new Client({ name: 'cursor-vscode', version: '0.49.1' }, { capabilities: {} })
  const transport = new StreamableHTTPClientTransport(new URL(url('/mcp')), {
    requestInit: { headers: { accept: 'application/json, text/event-stream' } },
  })
  try {
    await client.connect(transport)
    const tools = await client.listTools()
    expect(tools.tools.some(tool => tool.name === 'get_platform_capabilities')).toBe(true)
    const result = await client.callTool({ name: 'get_platform_capabilities', arguments: {} })
    expect(result.isError).not.toBe(true)

    let rows: any[] = []
    for (let i = 0; i < 80; i++) {
      rows = await logs('source=mcp&limit=100')
      if (rows.some(row => row.mcp?.client?.name === 'cursor') && rows.some(row => row.operation === 'mcp.tool.get_platform_capabilities')) break
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    const initialized = rows.find(row => row.operation === 'mcp.request' && row.mcp?.rpcMethod === 'initialize')
    expect(initialized).toMatchObject({
      source: 'mcp', operation: 'mcp.request', mcp: {
        transport: 'streamable-http', sessionMode: 'stateless', rpcMethod: 'initialize',
        client: { name: 'cursor', version: '0.49.1', trust: 'self-reported', capturedAt: 'initialize' },
        protocolVersionRequested: expect.stringMatching(/^202[45]-/),
      },
    })
    expect(JSON.stringify(rows)).not.toContain('cursor-vscode')
    expect(JSON.stringify(rows)).not.toContain('mcp-session-id')
    const toolEvent = rows.find(row => row.operation === 'mcp.tool.get_platform_capabilities')!
    expect(toolEvent).toMatchObject({
      source: 'mcp', module: 'sme-roster', mcp: { transport: 'streamable-http', sessionMode: 'stateless', rpcMethod: 'tools/call', tool: 'get_platform_capabilities' },
    })
    expect(toolEvent.mcp?.client).toBeUndefined()
    const detailEvent = await detail(toolEvent.id)
    expect(detailEvent.mcp).toMatchObject({ rpcMethod: 'tools/call', tool: 'get_platform_capabilities' })
    expect(detailEvent.mcp?.client).toBeUndefined()
  } finally {
    await transport.close().catch(() => {})
    await client.close().catch(() => {})
  }
})

it('records a real tus create and final PATCH with the server upload id and per-request phase', async () => {
  const data = 'hello'
  const metadata = [
    `source ${Buffer.from('jxj').toString('base64')}`,
    `kind ${Buffer.from('announcement').toString('base64')}`,
    `year ${Buffer.from('2026').toString('base64')}`,
    `batch ${Buffer.from('1').toString('base64')}`,
    `filename ${Buffer.from('tus-log-180.txt').toString('base64')}`,
  ].join(',')
  const tus = { 'Tus-Resumable': '1.0.0' }
  const created = await call('/api/uploads', {
    method: 'POST',
    headers: { ...tus, 'Upload-Length': String(data.length), 'Upload-Metadata': metadata },
  })
  expect(created.status).toBe(201)
  const id = (created.headers.get('location') ?? '').split('/').filter(Boolean).pop()!
  expect(id).toMatch(/^[a-f0-9]{32}$/)
  const createdRows = await waitLog(created.requestId)
  expect(createdRows.find(row => row.operation === 'file.upload')).toMatchObject({
    source: 'file', module: 'core', outcome: 'started', statusCode: 201,
    tus: { uploadId: id, phase: 'created', method: 'POST', size: data.length, offset: 0 },
  })

  const finished = await call(`/api/uploads/${id}`, {
    method: 'PATCH',
    headers: { ...tus, 'Upload-Offset': '0', 'Content-Type': 'application/offset+octet-stream' },
    body: data,
  })
  expect(finished.status).toBe(204)
  expect(decodeURIComponent(finished.headers.get('x-upload-path') ?? '')).toBe('jxj/announcement/2026/1/tus-log-180.txt')
  const finishedRows = await waitLog(finished.requestId)
  expect(finishedRows.find(row => row.operation === 'file.upload')).toMatchObject({
    source: 'file', module: 'core', outcome: 'success', statusCode: 204,
    origin: {runtime:'node',integration:'tus',capture:'hook',execution:'request'},
    durationMs: expect.any(Number),
    tus: { uploadId: id, phase: 'completed', method: 'PATCH', size: data.length, offset: data.length },
  })
  expect(JSON.stringify({ createdRows, finishedRows })).not.toContain('tus-log-180.txt')
})

it('keeps method but reports no template for an unmatched route', async () => {
  // Unknown /api paths fall through to the SPA renderer (200), but no /api route template exists.
  const response = await call(`/api/does-not-exist/${PRIVATE}`)
  expect([200, 404]).toContain(response.status)
  const rows = await waitLog(response.requestId)
  expect(rows[0]).toMatchObject({ source: 'http', module: null, httpMethod: 'GET', statusCode: response.status })
  expect(rows[0]).not.toHaveProperty('httpRoute')
  expect(JSON.stringify(rows[0])).not.toContain(PRIVATE)
})

it('drops a non-vocabulary method instead of persisting it', async () => {
  const response = await call('/api/health', { method: 'PROPFIND' })
  expect([200, 404, 405, 501]).toContain(response.status)
  const rows = await waitLog(response.requestId)
  expect(rows[0]).not.toHaveProperty('httpMethod')
  expect(JSON.stringify(rows[0])).not.toContain('PROPFIND')
})

it('carries the MCP template into request-scoped semantic tool events', async () => {
  const response = await mcp('tools/call', { name: 'get_platform_capabilities', arguments: {} })
  expect(response.status).toBe(200)
  for (let i = 0; i < 80; i++) {
    const rows = await logs('requestId=' + response.requestId)
    const semantic = rows.find(row => row.operation === 'mcp.tool.get_platform_capabilities')
    if (semantic) {
      expect(semantic).toMatchObject({ source: 'mcp', module: 'sme-roster', httpMethod: 'POST', httpRoute: '/mcp' })
      expect(rows.find(row => row.operation === 'mcp.request')).toMatchObject({ module: 'sme-roster' })
      return
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('semantic MCP event did not persist')
})

it('records the matched HTTP template on a semantic operation', async () => {
  const response = await call('/api/roster/enterprises/999999/aliases')
  expect([200, 404]).toContain(response.status)
  for (let i = 0; i < 80; i++) {
    const rows = await logs('requestId=' + response.requestId)
    const semantic = rows.find(row => row.operation === 'maintenance.alias.list')
    if (semantic) {
      expect(semantic).toMatchObject({ source: 'http', module: 'sme-roster', httpMethod: 'GET', httpRoute: '/api/roster/enterprises/:id/aliases' })
      return
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('semantic HTTP event did not persist')
})


it('accepts exactly the built application route templates and no other spelling', () => {
  const source = readFileSync(join(resolve(import.meta.dirname, '../../..'), '.output/server/chunks/nitro/nitro.mjs'), 'utf8')
  const actual = [...new Set(
    [...source.matchAll(/route: '([^']+)'/g)]
      .map(match => match[1]!)
      .filter(route => route === '/mcp' || route.startsWith('/api/')),
  )].sort()
  // Exact set equality is the contract; a hardcoded total would only duplicate
  // it and go stale whenever a real route ships (e.g. the #453 declarations pair).
  expect([...APPLICATION_LOG_ROUTES].sort()).toEqual(actual)
  expect(actual).toContain('/api/platform/declarations')
  expect(actual).toContain('/api/platform/declarations/:recordId')
})

it('records new annual and candidate HTTP templates without concrete event or task identities', async () => {
  for (const [path, template] of [
    ['/api/roster/events/987654321/annual-process', '/api/roster/events/:id/annual-process'],
    ['/api/roster/annual-correspondence-tasks/not-a-job', '/api/roster/annual-correspondence-tasks/:id'],
  ]) {
    const response = await call(path!)
    expect([400, 404]).toContain(response.status)
    const rows = await waitLog(response.requestId)
    expect(rows.find(row => row.source === 'http')).toMatchObject({ httpMethod: 'GET', httpRoute: template, statusCode: response.status })
    expect(JSON.stringify(rows)).not.toMatch(/987654321|not-a-job/)
  }
})

it('records the requested file id on a real delete failure', async () => {
  const response = await call('/api/files/987654321', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: '{}' })
  expect([400, 404, 409]).toContain(response.status)
  const rows = await waitLog(response.requestId)
  expect(rows.find(row => row.operation === 'file.maintenance.remove')).toMatchObject({
    source: 'file', module: 'core', outcome: 'denied', errorCode: 'file_remove_failed', fileId: 987654321,
  })
})

it('does not fabricate a file target for an invalid delete id', async () => {
  const response = await call('/api/files/alice', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: '{}' })
  expect(response.status).toBe(400)
  const rows = await waitLog(response.requestId)
  expect(rows.some(row => row.source === 'file')).toBe(false)
})


it('saves dual collection rules through protected REST and MCP while disabled business requests still return 200', async () => {
  const patch = (body:unknown, authorized=true) => call('/api/logs/policy',{method:'PATCH',headers:{'content-type':'application/json',...(authorized?apiHeaders:{})},body:JSON.stringify(body)})
  const initial = await call('/api/logs/policy',{headers:apiHeaders})
  expect(initial.status).toBe(200)
  expect(Object.keys(initial.body.collection.sources)).toHaveLength(11)
  expect(Object.keys(initial.body.collection.integrations)).toHaveLength(11)
  expect(initial.body.catalog.integrations.find((x:any)=>x.key==='drizzle')).toMatchObject({state:'supported',configurable:true,category:'technical',runtimes:['node']})
  const base = {retentionDays:initial.body.retentionDays,maxBytes:initial.body.maxBytes}
  expect((await patch({...base,collection:{sources:{http:{enabled:false,minLevel:'debug'}}}},false)).status).toBe(401)
  const disabled=await patch({...base,collection:{sources:{http:{enabled:false,minLevel:'debug'}}}})
  expect(disabled.status).toBe(200)
  expect(disabled.body.revision).toBe(initial.body.revision+1)
  const health=await call('/api/health')
  expect(health.status).toBe(200)
  await new Promise(r=>setTimeout(r,250))
  expect(await logs('requestId='+health.requestId)).toEqual([])
  expect(output).not.toContain(health.requestId)
  expect((await patch({...base})).status).toBe(200)
  expect((await call('/api/logs/policy',{headers:apiHeaders})).body.collection.sources.http.enabled).toBe(false)
  for(const invalid of [{...base,revision:1},{...base,catalog:{}},{...base,collection:{sources:{http:{enabled:true}}}},{...base,collection:{integrations:{unknown_library:{enabled:true,minLevel:'debug'}}}}]) {
    expect((await patch(invalid)).status).toBe(400)
    const rpc=await mcp('tools/call',{name:'set_runtime_log_policy',arguments:invalid},mcpToken)
    expect(rpc.status).toBe(200)
    expect(rpc.body.error.data.code).toBe('invalid_log_input')
  }
  const denied=await mcp('tools/call',{name:'set_runtime_log_policy',arguments:base})
  expect(denied.status).toBe(401)
  const restored=await mcp('tools/call',{name:'set_runtime_log_policy',arguments:{...base,collection:{sources:{http:{enabled:true,minLevel:'debug'}}}}},mcpToken)
  expect(restored.status).toBe(200)
  expect(restored.body.result.isError).not.toBe(true)
  const read=await mcp('tools/call',{name:'get_runtime_log_policy',arguments:{}},mcpToken)
  const policy=read.body.result.structuredContent??JSON.parse(read.body.result.content[0].text)
  expect(policy.collection.sources.http).toEqual({enabled:true,minLevel:'debug'})
  const after=await call('/api/health')
  expect(after.status).toBe(200)
  expect((await waitLog(after.requestId))[0]).toMatchObject({source:'http',outcome:'success'})
  expect((await call('/api/logs/policy',{headers:apiHeaders})).body.status.filtered).toBeGreaterThan(0)
})

async function policyPatch(collection: unknown) {
  const current = await call('/api/logs/policy', { headers: apiHeaders })
  const response = await call('/api/logs/policy', { method: 'PATCH', headers: { ...apiHeaders, 'content-type': 'application/json' },
    body: JSON.stringify({ retentionDays: current.body.retentionDays, maxBytes: current.body.maxBytes, collection }) })
  expect(response.status).toBe(200)
  return response.body
}
async function waitOperation(requestId: string, operation: string) {
  for (let i = 0; i < 80; i++) {
    const rows = await logs(new URLSearchParams({ requestId, operation }).toString())
    if (rows.length) return rows
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('expected fixed operation did not persist: ' + operation)
}

async function waitFiltered(minimum: number) {
  // Intake transport endpoints intentionally have no http.request event.
  // The writer's filtered counter is the observable negative-path witness.
  for (let i = 0; i < 80; i++) {
    const policy = await call('/api/logs/policy', { headers: apiHeaders })
    if (policy.body.status.filtered >= minimum) return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('filtered batch did not finish')
}

it.each([
  ['roster', 'sme-roster', 'client.roster.script_error'],
  ['roster-workspace', 'sme-roster', 'client.other.script_error'],
  ['preview', 'core', 'client.other.script_error'],
  ['ocr', 'core', 'client.other.script_error'],
])('stores the registered module for the %s browser page through Nitro intake', async (page, module, operation) => {
  const accepted = await call('/api/logs/client', {
    method: 'POST',
    headers: { ...apiHeaders, 'content-type': 'application/json' },
    body: JSON.stringify([{ event: { kind: 'script_error', page, level: 'error', url: PRIVATE, module: 'forged' } }]),
  })
  expect(accepted.status).toBe(202)
  expect(accepted.body.accepted).toBe(1)
  const [row] = await waitOperation(accepted.requestId, operation)
  expect(row).toMatchObject({ source: 'client', module, level: 'error', outcome: 'failure', requestId: accepted.requestId })
  expect(JSON.stringify(await detail(row.id))).not.toContain(PRIVATE)
})

it('persists the four real client integration mappings and applies their protected runtime rules', async () => {
  const previous = (await call('/api/logs/policy', { headers: apiHeaders })).body.collection
  const keys = ['tus-client', 'embedpdf', 'pinia-colada', 'vue-router']
  const rules = (enabled: boolean, minLevel = 'debug') => Object.fromEntries(keys.map(key => [key, { enabled, minLevel }]))
  const samples = [
    ['tus_upload_success', 'tus-client', 'client.tus.upload_success'],
    ['pdf_document_ready', 'embedpdf', 'client.embedpdf.document_ready'],
    ['colada_query_success', 'pinia-colada', 'client.colada.query_success'],
    ['router_navigation_success', 'vue-router', 'client.router.navigation_success'],
  ]
  const send = (page: string, signals = samples.map(item => item[0]!)) => call('/api/logs/client', {
    method: 'POST', headers: { ...apiHeaders, 'content-type': 'application/json' },
    body: JSON.stringify(signals.map(signal => ({ event: { kind: 'library_signal', signal, page,
      origin: { runtime: 'node', integration: 'drizzle' }, operation: PRIVATE, params: [PRIVATE], url: PRIVATE, level: 'fatal', outcome: 'denied',
    } }))),
  })
  try {
    await policyPatch({ sources: { client: { enabled: true, minLevel: 'debug' } }, integrations: rules(true) })
    const accepted = await send('files')
    expect(accepted.status).toBe(202)
    expect(accepted.body.accepted).toBe(4)
    for (const [, integration, operation] of samples) {
      const [row] = await waitOperation(accepted.requestId, operation!)
      expect(row).toMatchObject({ source: 'client', module: 'core', outcome: 'success', level: 'info',
        origin: { runtime: 'browser', integration, capture: 'hook', execution: 'page' } })
      expect(JSON.stringify(await detail(row.id))).not.toContain(PRIVATE)
    }
    await policyPatch({ integrations: rules(false) })
    const beforeDisabled = (await call('/api/logs/policy', { headers: apiHeaders })).body.status.filtered
    const disabled = await send('tasks')
    expect(disabled.status).toBe(202)
    await waitFiltered(beforeDisabled + 4)
    expect((await logs('requestId=' + disabled.requestId)).filter(row => row.source === 'client')).toEqual([])
    await policyPatch({ sources: { client: { enabled: false, minLevel: 'debug' } }, integrations: rules(true) })
    const beforeSource = (await call('/api/logs/policy', { headers: apiHeaders })).body.status.filtered
    const sourceDisabled = await send('roster')
    expect(sourceDisabled.status).toBe(202)
    await waitFiltered(beforeSource + 4)
    expect((await logs('requestId=' + sourceDisabled.requestId)).filter(row => row.source === 'client')).toEqual([])
    await policyPatch({ sources: { client: { enabled: true, minLevel: 'info' } }, integrations: rules(true, 'warn') })
    const threshold = await send('other', ['pdf_document_ready', 'pdf_log_warn'])
    expect(threshold.status).toBe(202)
    const warning = await waitOperation(threshold.requestId, 'client.embedpdf.log_warn')
    expect(warning[0]).toMatchObject({ module: null, level: 'warn', outcome: 'unknown', origin: { integration: 'embedpdf' } })
    expect((await logs('requestId=' + threshold.requestId)).filter(row => row.source === 'client')).toHaveLength(1)
    await policyPatch({ sources: { client: { enabled: true, minLevel: 'debug' } }, integrations: rules(true) })
    const restored = await send('settings')
    expect(restored.status).toBe(202)
    for (const [, , operation] of samples) expect(await waitOperation(restored.requestId, operation!)).toHaveLength(1)
    expect(output).not.toContain(PRIVATE)
    expect(storedLogRows(runtime)).not.toContain(PRIVATE)
  } finally { await policyPatch(previous) }
})

it('keeps real worker queries successful while Drizzle and system rules independently suppress attempts', async () => {
  const previous = (await call('/api/logs/policy', { headers: apiHeaders })).body.collection
  const read = async () => {
    const response = await call('/api/roster/current-enterprises?titleCode=specialized_sme&q=' + PRIVATE)
    expect(response.status).toBe(200)
    // The terminal witness is emitted by the same child after its query hooks.
    const events = await waitOperation(response.requestId, 'enterprise_read.execute')
    expect(events.every(row => row.module === 'sme-roster')).toBe(true)
    return response
  }
  try {
    await policyPatch({ sources: { system: { enabled: true, minLevel: 'debug' } }, integrations: { drizzle: { enabled: true, minLevel: 'debug' } } })
    const enabled = await read()
    const attempts = (await logs('requestId=' + enabled.requestId)).filter(row => row.origin?.integration === 'drizzle')
    expect(attempts.length).toBeGreaterThan(0)
    for (const row of attempts) {
      expect(row).toMatchObject({ source: 'system', level: 'debug', outcome: 'started', resourceType: 'database_connection', resourceId: 'enterprise_read',
        origin: { runtime: 'node', integration: 'drizzle', capture: 'hook', execution: 'worker' } })
      expect(Number.isSafeInteger(row.counts.total)).toBe(true)
      expect(row.counts.total).toBeGreaterThan(0)
      expect((await detail(row.id)).counts).toEqual(row.counts)
    }
    const status = (await call('/api/logs/policy', { headers: apiHeaders })).body.status
    expect(status).toMatchObject({ dropped: 0, writeUnknown: 0 })
    expect(Number.isSafeInteger(status.coalesced)).toBe(true)
    await policyPatch({ integrations: { drizzle: { enabled: false, minLevel: 'debug' } } })
    const disabled = await read()
    expect((await logs('requestId=' + disabled.requestId)).filter(row => row.origin?.integration === 'drizzle')).toEqual([])
    await policyPatch({ sources: { system: { enabled: false, minLevel: 'debug' } }, integrations: { drizzle: { enabled: true, minLevel: 'debug' } } })
    const sourceDisabled = await read()
    expect((await logs('requestId=' + sourceDisabled.requestId)).filter(row => row.origin?.integration === 'drizzle')).toEqual([])
    expect(output).not.toContain(PRIVATE)
  } finally { await policyPatch(previous) }
// Three real isolated worker executions plus durable log/policy acknowledgements.
}, 15_000)
