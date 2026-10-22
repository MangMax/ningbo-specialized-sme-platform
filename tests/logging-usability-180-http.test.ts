import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { reserveLoopbackPort, stopOwnedChild, waitForHttp } from '../scripts/lib/isolated-local-services.mjs'
import { useDb } from '../db/client'
import { APPLICATION_LOG_ROUTES } from '../lib/logging/route-templates'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

/**
 * #180 actual built Nuxt seam: a fresh synthetic business DB and an independent
 * log directory. Only public HTTP is asserted; the parent service/fixture is
 * never touched.
 */
const root = mkdtempSync(join(tmpdir(), 'log-usability-180-http-'))
const dbPath = join(root, 'synthetic.db'), logDir = join(root, 'logs')
const token = 'synthetic-log180-api', mcpToken = 'synthetic-log180-mcp'
const PRIVATE = 'PRIVATE180_HTTP_NONCE'
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
  if (process.env.LOG180_SKIP_BUILD !== '1') execFileSync('pnpm', ['build'], { cwd: resolve(import.meta.dirname, '..'), timeout: 300_000, stdio: 'pipe' })
  const db = useDb({ dbPath })
  db.$client.close()
  const port = await reserveLoopbackPort()
  baseUrl = `http://127.0.0.1:${port}`
  child = spawn(process.execPath, ['.output/server/index.mjs'], {
    cwd: resolve(import.meta.dirname, '..'),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env, HOST: '127.0.0.1', PORT: String(port), NODE_ENV: 'production',
      NUXT_DB_PATH: dbPath, NUXT_DB_READONLY: '1', NUXT_LOG_DIR: logDir,
      NUXT_FILES_DIR: join(root, 'files'), NUXT_INCOMING_DIR: join(root, 'incoming'),
      NUXT_API_TOKEN: token, NUXT_MCP_TOKEN: mcpToken, NUXT_BROWSER_LOGS_ENABLED: 'false',
      NUXT_CURATED_PATH: join(root, 'curated.json'), NUXT_RECONCILE_PATH: join(root, 'reconcile.json'),
    },
  })
  child.stdout!.on('data', chunk => { output += chunk.toString() })
  child.stderr!.on('data', chunk => { output += chunk.toString() })
  mkdirSync(logDir, { recursive: true })
  mkdirSync(join(root, 'files'), { recursive: true })
  mkdirSync(join(root, 'incoming'), { recursive: true })
  await waitForHttp(url('/api/health'), { child, timeoutMs: 120_000 })
}, 360_000)

afterAll(async () => {
  await stopOwnedChild(child)
  writeFileSync(join(root, 'server.log'), output)
  if (process.env.LOG180_EVIDENCE_DIR) {
    mkdirSync(process.env.LOG180_EVIDENCE_DIR, { recursive: true })
    writeFileSync(join(process.env.LOG180_EVIDENCE_DIR, 'server.log'), output)
    writeFileSync(join(process.env.LOG180_EVIDENCE_DIR, 'manifest.json'), JSON.stringify({
      sha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      tree: execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim(),
      status: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }),
      fixture: root,
      lane: 'actual built Nuxt HTTP, real evlog drain, protected log list/detail and MCP',
    }, null, 2))
    writeFileSync(join(process.env.LOG180_EVIDENCE_DIR, 'fixture-root.txt'), root)
  } else rmSync(root, { recursive: true, force: true })
})

it('records a real matched HTTP template and method in the protected list and detail', async () => {
  const health = await call(`/api/health?probe=${PRIVATE}`, { headers: { authorization: `Bearer ${PRIVATE}`, cookie: PRIVATE } })
  expect(health.status).toBe(200)
  const rows = await waitLog(health.requestId)
  expect(rows).toHaveLength(1)
  const summary = rows[0]
  expect(summary).toMatchObject({
    source: 'http', operation: 'http.request', outcome: 'success', statusCode: 200,
    httpMethod: 'GET', httpRoute: '/api/health',
  })
  const event = await detail(summary.id)
  expect(event).toMatchObject({ id: summary.id, httpMethod: 'GET', httpRoute: '/api/health', statusCode: 200 })
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
  expect(summary).toMatchObject({ source: 'http', httpMethod: 'GET', httpRoute: '/api/files/:id' })
  const serialized = JSON.stringify({ summary, detail: await detail(summary.id) })
  expect(serialized).not.toContain('987654321')
  expect(serialized).not.toContain(PRIVATE)
  expect(readFileSync(join(logDir, 'events.db')).toString()).not.toContain('987654321')
  expect(readFileSync(join(logDir, 'events.db')).toString()).not.toContain(PRIVATE)
})

it('records the MCP transport template and exposes the same facts through MCP', async () => {
  const listed = await mcp('tools/list', {})
  expect(listed.status).toBe(200)
  const rows = await waitLog(listed.requestId)
  expect(rows[0]).toMatchObject({ source: 'mcp', operation: 'mcp.request', httpMethod: 'POST', httpRoute: '/mcp' })

  const rpc = await mcp('tools/call', { name: 'list_runtime_logs', arguments: { requestId: rows[0].requestId } }, mcpToken)
  expect(rpc.status).toBe(200)
  const payload = rpc.body.result.structuredContent ?? JSON.parse(rpc.body.result.content[0].text)
  expect(payload.rows[0]).toMatchObject({ httpMethod: 'POST', httpRoute: '/mcp' })
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
      source: 'mcp', mcp: { transport: 'streamable-http', sessionMode: 'stateless', rpcMethod: 'tools/call', tool: 'get_platform_capabilities' },
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
    source: 'file', outcome: 'started', statusCode: 201,
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
    source: 'file', outcome: 'success', statusCode: 204,
    tus: { uploadId: id, phase: 'completed', method: 'PATCH', size: data.length, offset: data.length },
  })
  expect(JSON.stringify({ createdRows, finishedRows })).not.toContain('tus-log-180.txt')
})

it('keeps method but reports no template for an unmatched route', async () => {
  // Unknown /api paths fall through to the SPA renderer (200), but no /api route template exists.
  const response = await call(`/api/does-not-exist/${PRIVATE}`)
  expect([200, 404]).toContain(response.status)
  const rows = await waitLog(response.requestId)
  expect(rows[0]).toMatchObject({ source: 'http', httpMethod: 'GET', statusCode: response.status })
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
      expect(semantic).toMatchObject({ source: 'mcp', httpMethod: 'POST', httpRoute: '/mcp' })
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
      expect(semantic).toMatchObject({ source: 'http', httpMethod: 'GET', httpRoute: '/api/roster/enterprises/:id/aliases' })
      return
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('semantic HTTP event did not persist')
})


it('accepts exactly the built application route templates and no other spelling', () => {
  const source = readFileSync(join(resolve(import.meta.dirname, '..'), '.output/server/chunks/nitro/nitro.mjs'), 'utf8')
  const actual = [...new Set(
    [...source.matchAll(/route: '([^']+)'/g)]
      .map(match => match[1]!)
      .filter(route => route === '/mcp' || route.startsWith('/api/')),
  )].sort()
  expect(actual).toHaveLength(113)
  expect([...APPLICATION_LOG_ROUTES].sort()).toEqual(actual)
})

it('records the requested file id on a real delete failure', async () => {
  const response = await call('/api/files/987654321', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: '{}' })
  expect([400, 404, 409]).toContain(response.status)
  const rows = await waitLog(response.requestId)
  expect(rows.find(row => row.operation === 'file.maintenance.remove')).toMatchObject({
    source: 'file', outcome: 'denied', errorCode: 'file_remove_failed', fileId: 987654321,
  })
})

it('does not fabricate a file target for an invalid delete id', async () => {
  const response = await call('/api/files/alice', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: '{}' })
  expect(response.status).toBe(400)
  const rows = await waitLog(response.requestId)
  expect(rows.some(row => row.source === 'file')).toBe(false)
})
