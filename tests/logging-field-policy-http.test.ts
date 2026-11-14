import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { execFileSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { request } from 'node:http'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { initializeDb } from '../db/client'
import { spawnOwnedChild as spawn, reserveLoopbackPort, stopOwnedChild, waitForHttp } from './helpers/isolated-local-services.mjs'
import { LOG_LEVELS } from '../lib/logging/contract'
import { LOG_FIELD_PROFILES, defaultFieldControls } from '../lib/logging/field-controls'
import { APPLICATION_LOG_ROUTES } from '../lib/logging/route-templates'

const root = mkdtempSync(join(tmpdir(), 'field-policy-http-'))
const logDir = join(root, 'logs'), boundaryLogs = join(root, 'boundary-logs'), dbPath = join(root, 'synthetic.db')
const token = 'synthetic-field-api', mcpToken = 'synthetic-field-mcp', PRIVATE = 'PRIVATE_FIELD_POLICY_RAW_180'
const api = { authorization: `Bearer ${token}` }, policyBase = { retentionDays: 7, maxBytes: 536870912 }
const children: ChildProcess[] = [], observations: unknown[] = []
let baseUrl = '', boundaryUrl = '', output = '', boundaryOutput = '', beforeDbHash = ''
const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')
async function call(path: string, init: RequestInit = {}) {
  const response = await fetch(baseUrl + path, { ...init, signal: AbortSignal.timeout(5000) })
  const text = await response.text()
  let body: any; try { body = JSON.parse(text) } catch { body = text }
  return { status: response.status, body, headers: response.headers, requestId: response.headers.get('x-request-id') }
}
const getPolicy = () => call('/api/logs/policy', { headers: api })
const patch = (body: unknown, authorized = true) => call('/api/logs/policy', { method: 'PATCH', headers: { 'content-type': 'application/json', ...(authorized ? api : {}) }, body: JSON.stringify(body) })
const rpc = (name: string, args: unknown, authorized = true, extra = '') => call('/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(authorized ? { authorization: `Bearer ${mcpToken}` } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: extra || 7, method: 'tools/call', params: { name, arguments: args } }) })
function rpcBody(result: any) { expect(result.body.error).toBeUndefined(); expect(result.body.result.isError).not.toBe(true); return result.body.result.structuredContent ?? JSON.parse(result.body.result.content[0].text) }
async function logFor(requestId: string | null) {
  let rows: any[] = []
  await expect.poll(async () => { const result = await call('/api/logs?' + new URLSearchParams({ requestId: requestId!, limit: '100' }), { headers: api }); expect(result.status).toBe(200); rows = result.body.rows; return rows.length }, { timeout: 6000 }).toBeGreaterThan(0)
  return rows
}
async function boundary(body: string, observedLength?: string, authorized = true, path = '/') {
  const response = await fetch(boundaryUrl + path, { method: 'PATCH', headers: { 'content-type': 'application/json', ...(authorized ? api : {}), ...(observedLength === undefined ? {} : { 'x-fixture-length': observedLength }) }, body, signal: AbortSignal.timeout(5000) })
  return { status: response.status, body: await response.json() as any, headers: response.headers }
}

/** Send only a prefix; the application must respond before the withheld tail. */
function prefixRequest(base: string, authorized: boolean, prefix = '', observed?: string): Promise<{ status: number; text: string; headers: import('node:http').IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = request(new URL('/api/logs/policy', base), { method: 'PATCH', headers: {
      'content-type': 'application/json', 'content-length': '50000', connection: 'close',
      ...(authorized ? api : {}), ...(observed ? { 'x-fixture-length': observed } : {}),
    } }, res => {
      let text = ''; res.on('data', c => { text += c }); res.on('end', () => { resolve({ status: res.statusCode!, text, headers: res.headers }); req.destroy() })
    })
    req.on('error', reject); req.setTimeout(2000, () => { req.destroy(new Error('response waited for withheld body')) })
    req.flushHeaders(); if (prefix) req.write(prefix)
  })
}

beforeAll(async () => {
  if (process.env.FIELD_POLICY_SKIP_BUILD !== '1') execFileSync(process.execPath, ['node_modules/nuxt/bin/nuxt.mjs', 'build'], { cwd: resolve('.'), stdio: 'pipe', timeout: 300000 })
  const db = initializeDb({ create: true,  dbPath }); db.$client.close(); beforeDbHash = hash(dbPath)
  for (const name of ['files', 'incoming']) mkdirSync(join(root, name))
  const port = await reserveLoopbackPort(); expect(port).not.toBe(50055); baseUrl = `http://127.0.0.1:${port}`
  const child = spawn(process.execPath, ['.output/server/index.mjs'], { cwd: resolve('.'), stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NODE_ENV: 'production', HOST: '127.0.0.1', PORT: String(port), NUXT_DB_PATH: dbPath, NUXT_DB_READONLY: '1', NUXT_LOG_DIR: logDir, NUXT_FILES_DIR: join(root, 'files'), NUXT_INCOMING_DIR: join(root, 'incoming'), NUXT_API_TOKEN: token, NUXT_MCP_TOKEN: mcpToken, NUXT_CURATED_PATH: join(root, 'curated.json'), NUXT_RECONCILE_PATH: join(root, 'reconcile.json') } }); children.push(child)
  child.stdout!.on('data', c => { output += c }); child.stderr!.on('data', c => { output += c })
  await waitForHttp(baseUrl + '/api/health', { child })
  const boundaryChild = spawn(process.execPath, ['tests/helpers/logging-field-policy-boundary.mjs'], { cwd: resolve('.'), stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { ...process.env, NUXT_LOG_DIR: boundaryLogs } }); children.push(boundaryChild)
  boundaryChild.stdout!.on('data', c => { boundaryOutput += c }); boundaryChild.stderr!.on('data', c => { boundaryOutput += c })
  boundaryUrl = await new Promise<string>((resolve, reject) => { boundaryChild.once('error', reject); boundaryChild.once('exit', () => reject(new Error(boundaryOutput))); boundaryChild.once('message', (m: any) => resolve(`http://127.0.0.1:${m.port}`)) })
  observations.push({ root, baseUrl, boundaryUrl, children: children.map(c => c.pid), artifactHash: hash('.output/server/chunks/nitro/nitro.mjs'), beforeDbHash })
}, 360000)
afterAll(async () => {
  for (const child of children) await stopOwnedChild(child)
  const afterDbHash = existsSync(dbPath) ? hash(dbPath) : null
  observations.push({ afterDbHash, unchangedBusinessDb: afterDbHash === beforeDbHash, children: children.map(c => ({ pid: c.pid, exitCode: c.exitCode, signalCode: c.signalCode })), rawAbsent: !output.includes(PRIVATE) && !boundaryOutput.includes(PRIVATE) })
  if (process.env.FIELD_POLICY_EVIDENCE_DIR) {
    const evidence = process.env.FIELD_POLICY_EVIDENCE_DIR; mkdirSync(evidence, { recursive: true })
    writeFileSync(join(evidence, 'server.log'), output); writeFileSync(join(evidence, 'boundary.log'), boundaryOutput)
    writeFileSync(join(evidence, 'observations.json'), JSON.stringify(observations, null, 2))
  }
  rmSync(root, { recursive: true, force: true })
  expect(output + boundaryOutput).not.toContain(PRIVATE)
  expect(afterDbHash).toBe(beforeDbHash)
})

it('denies REST and MCP before policy execution and reads no unauthorized body or store', async () => {
  expect(existsSync(join(boundaryLogs, 'events.db'))).toBe(false)
  const result = await boundary(JSON.stringify({ private: PRIVATE }), undefined, false)
  expect(result).toMatchObject({ status: 401, body: { error: { code: 'log_access_denied' } } })
  expect(result.headers.get('cache-control')).toBe('no-store'); expect(result.headers.get('x-fixture-data-readers')).toBe('0')
  expect(existsSync(join(boundaryLogs, 'events.db'))).toBe(false)
  const beforeBody = await prefixRequest(baseUrl, false); expect(beforeBody.status).toBe(401); expect(beforeBody.headers['cache-control']).toBe('no-store')
  const denied = await patch({ private: PRIVATE }, false); expect(denied.status).toBe(401); expect(denied.headers.get('cache-control')).toBe('no-store')
  expect((await call('/api/logs/policy')).status).toBe(401)
  expect((await rpc('set_runtime_log_policy', { private: PRIVATE }, false)).status).toBe(401)
  expect((await call('/api/health')).status).toBe(200)
})

for (const action of ['commit', 'preflight'] as const) it(`retains the parse-result ${action} template on unauthorized POST without exposing the file id`, async () => {
  const fileId = 'issue375-denied-file-942718630'
  const path = `/api/files/${fileId}/parse-result/${action}`
  const requestURL = new URL(path, baseUrl).href
  const template = `/api/files/:id/parse-result/${action}`
  const headerCases: Record<string, string>[] = [{}, { authorization: 'Bearer issue375-wrong-token' }]
  for (const headers of headerCases) {
    const response = await call(path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{}' })
    expect(response.status).toBe(401)
    // Nitro echoes the submitted URL here; ID privacy covers protected log responses below.
    expect(response.body.url).toBe(requestURL)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('www-authenticate')).toBe('Bearer realm="agent-api"')
    expect(response.requestId).toBeTruthy()
    const rows = await logFor(response.requestId)
    const event = rows.find(row => row.operation === 'http.request')
    expect(event).toMatchObject({ source: 'http', httpMethod: 'POST', httpRoute: template, statusCode: 401 })
    const detail = await call('/api/logs/' + event.id, { headers: api })
    expect(detail.status).toBe(200); expect(detail.body).toEqual(event)
    expect(JSON.stringify({ rows, detail: detail.body })).not.toContain(fileId)
  }
  expect(output).not.toContain(fileId)
  expect(readFileSync(join(logDir, 'events.db')).toString()).not.toContain(fileId)
  expect(hash(dbPath)).toBe(beforeDbHash)
})

it('returns protected HTTP catalog complete controls and increasing revision through REST', async () => {
  const initial = await getPolicy(); expect(initial.status).toBe(200); expect(initial.headers.get('cache-control')).toBe('no-store')
  expect(initial.body.catalog.profiles).toEqual(LOG_FIELD_PROFILES)
  expect(initial.body.fieldControls).toEqual(defaultFieldControls(LOG_FIELD_PROFILES))
  const saved = await patch({ ...policyBase, fieldControls: { http: { info: { httpMethod: false } } } })
  expect(saved.status).toBe(200); expect(saved.body.revision).toBe(initial.body.revision + 1)
  expect(saved.body.catalog.profiles).toEqual(LOG_FIELD_PROFILES)
  expect(saved.body.fieldControls.http.info.httpMethod).toBe(false)
  expect((await getPolicy()).body.fieldControls).toEqual(saved.body.fieldControls)
  expect((await patch({ ...policyBase, fieldControls: defaultFieldControls(LOG_FIELD_PROFILES) })).status).toBe(200)
})

for (const field of LOG_FIELD_PROFILES[0].fields) it(`real request hook omits ${field.key} in protected list detail and stdout`, async () => {
  const preferences = Object.fromEntries(LOG_FIELD_PROFILES[0].fields.map(f => [f.key, f.key !== field.key]))
  const saved = await patch({ ...policyBase, fieldControls: { http: { info: preferences } } }); expect(saved.status).toBe(200)
  // Existing stdout is intentionally limited to ten lines/second. Reserve a fresh
  // window before the specific request whose projection is compared with storage.
  await new Promise(resolve => setTimeout(resolve, 1050))
  const health = await call('/api/health?private=' + PRIVATE); expect(health.status).toBe(200)
  const event = (await logFor(health.requestId)).find(e => e.operation === 'http.request')
  expect(event).toMatchObject({ source: 'http', outcome: 'success', level: 'info', requestId: health.requestId, fieldCapture: { profile: 'http', revision: saved.body.revision, disabled: [field.key] } })
  expect(event).not.toHaveProperty(field.key)
  for (const retained of LOG_FIELD_PROFILES[0].fields.filter(f => f.key !== field.key)) expect(event).toHaveProperty(retained.key)
  const detail = await call('/api/logs/' + event.id, { headers: api }); expect(detail.status).toBe(200); expect(detail.body).toEqual(event)
  await expect.poll(() => output.split('\n').flatMap(line => { try { return [JSON.parse(line)] } catch { return [] } }).find(e => e.id === event.id)).toEqual(event)
  expect((await call('/api/logs/' + event.id)).status).toBe(401)
  expect(JSON.stringify(event)).not.toContain(PRIVATE)
})

it('saves field preferences through MCP tools call and REST mutually while legacy PATCH preserves them', async () => {
  const saved = rpcBody(await rpc('set_runtime_log_policy', { ...policyBase, fieldControls: { http: { info: { httpRoute: false, statusCode: false } } } }))
  expect(saved.fieldControls.http.info).toMatchObject({ httpRoute: false, statusCode: false })
  const rest = await getPolicy(); expect(rest.body.fieldControls).toEqual(saved.fieldControls); expect(rest.body.revision).toBe(saved.revision)
  const legacy = await patch(policyBase); expect(legacy.status).toBe(200); expect(legacy.body.fieldControls).toEqual(saved.fieldControls)
  expect(legacy.body.revision).toBe(saved.revision + 1)
  const restored = await patch({ ...policyBase, fieldControls: { http: { info: { httpRoute: true } } } }); expect(restored.status).toBe(200)
  const read = rpcBody(await rpc('get_runtime_log_policy', {})); expect(read.fieldControls).toEqual(restored.body.fieldControls)
  expect(read.catalog.profiles).toEqual(LOG_FIELD_PROFILES)
  observations.push({ kind: 'rest-mcp-policy', saved, legacy: legacy.body, read })
})

for (const kind of ['top', 'profile', 'level', 'field'] as const) it(`rejects original unknown ${kind} in REST and raw MCP before SDK stripping`, async () => {
  const controls = kind === 'profile' ? { future: {} } : kind === 'level' ? { http: { trace: {} } } : { http: { info: { privateField: PRIVATE } } }
  const args = kind === 'top' ? { ...policyBase, privateField: PRIVATE } : { ...policyBase, fieldControls: controls }
  const before = (await getPolicy()).body.revision
  const rest = await patch(args); expect(rest.status).toBe(400); expect(rest.body.error.code).toBe('invalid_log_input'); expect(rest.headers.get('cache-control')).toBe('no-store')
  const mcp = await rpc('set_runtime_log_policy', args); expect(mcp.status).toBe(200)
  expect(mcp.body.error).toMatchObject({ code: -32602, data: { code: 'invalid_log_input' } }); expect(mcp.headers.get('cache-control')).toBe('no-store')
  expect((await getPolicy()).body.revision).toBe(before)
})

it('keeps MCP transport fields when every HTTP field is disabled and health responses remain unchanged', async () => {
  const baseline = await call('/api/health')
  expect((await patch({ ...policyBase, fieldControls: { http: { info: Object.fromEntries(LOG_FIELD_PROFILES[0].fields.map(f => [f.key, false])) } } })).status).toBe(200)
  const mcp = await call('/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) })
  expect(mcp.status).toBe(200)
  const event = (await logFor(mcp.requestId)).find(e => e.operation === 'mcp.request')
  expect(event).toMatchObject({ source: 'mcp', httpMethod: 'POST', httpRoute: '/mcp', statusCode: 200, durationMs: expect.any(Number) }); expect(event).not.toHaveProperty('fieldCapture')
  const health = await call('/api/health'); expect(health.status).toBe(baseline.status); expect(health.body).toEqual(baseline.body)
})

for (const size of [4095, 4096, 4097]) it(`bounds actual REST JSON whitespace at ${size} UTF8 bytes`, async () => {
  const text = JSON.stringify(policyBase); const body = text + ' '.repeat(size - Buffer.byteLength(text))
  const result = await call('/api/logs/policy', { method: 'PATCH', headers: { ...api, 'content-type': 'application/json' }, body })
  expect(result.status).toBe(size > 4096 ? 413 : 200); expect(result.headers.get('cache-control')).toBe('no-store')
  if (size > 4096) expect(result.body).toEqual({ error: { code: 'log_body_too_large' } })
})
for (const size of [4095, 4096, 4097]) it(`counts actual multibyte body rather than character length at ${size} bytes`, async () => {
  const prefix = JSON.stringify({ ...policyBase, privateField: PRIVATE + '汉'.repeat(1200) })
  const body = prefix + ' '.repeat(size - Buffer.byteLength(prefix)); expect(Buffer.byteLength(body)).toBe(size); expect(body.length).toBeLessThan(4096)
  const result = await call('/api/logs/policy', { method: 'PATCH', headers: { ...api, 'content-type': 'application/json' }, body })
  expect(result.status).toBe(size > 4096 ? 413 : 400); expect(result.headers.get('cache-control')).toBe('no-store')
  expect(JSON.stringify(result.body)).not.toContain(PRIVATE)
})

it('limits actual stream bytes despite an underdeclared observed length and rejects before reading the remainder', async () => {
  const text = JSON.stringify(policyBase), body = text + ' '.repeat(50000)
  const response = await boundary(body, '1'); expect(response.status).toBe(413); expect(response.body).toEqual({ error: { code: 'log_body_too_large' } })
  expect(response.headers.get('cache-control')).toBe('no-store')
  // A false positive from merely comparing the observed header cannot pass this case.
  expect(Number(response.headers.get('x-fixture-read-bytes'))).toBeGreaterThan(4096)
  expect((await boundary(JSON.stringify(policyBase), '1')).status).toBe(200)
  const prefix = JSON.stringify(policyBase) + ' '.repeat(5000)
  const early = await prefixRequest(boundaryUrl, true, prefix, '1')
  expect(early.status).toBe(413); expect(JSON.parse(early.text)).toEqual({ error: { code: 'log_body_too_large' } })
})

for (const length of ['missing', 'not-a-number', '1e3', '-1', '0', '4097']) it(`rejects observed Content-Length case ${length} without reading the body`, async () => {
  const result = await boundary(JSON.stringify(policyBase), length)
  expect(result.status).toBe(413); expect(result.headers.get('x-fixture-data-readers')).toBe('0'); expect(result.headers.get('cache-control')).toBe('no-store')
})

it('returns stable no-store 400 for malformed JSON without leaking raw input', async () => {
  const response = await call('/api/logs/policy', { method: 'PATCH', headers: { ...api, 'content-type': 'application/json' }, body: '{"private":"' + PRIVATE })
  expect(response.status).toBe(400); expect(response.body).toEqual({ error: { code: 'invalid_log_input' } }); expect(response.headers.get('cache-control')).toBe('no-store')
  expect((await call('/api/health')).status).toBe(200)
})

it('preserves clear authorization explicit range confirmation and safe parse errors', async () => {
  const clear = (body: string, authorized = true) => call('/api/logs/clear', { method: 'POST', headers: { 'content-type': 'application/json', ...(authorized ? api : {}) }, body })
  expect((await clear('{}', false)).status).toBe(401)
  for (const body of [{ confirm: true }, { from: '2000-01-01', to: '2000-01-02', confirm: false }]) { const result = await clear(JSON.stringify(body)); expect(result.status).toBe(400); expect(result.body.error.code).toBe('invalid_log_input') }
  const valid = await clear(JSON.stringify({ from: '2000-01-01', to: '2000-01-02', confirm: true })); expect(valid.status).toBe(200); expect(valid.body).toEqual({ deleted: 0, hasMore: false })
  const malformed = await clear('{"private":"' + PRIVATE); expect(malformed.status).toBe(400); expect(malformed.body).toEqual({ error: { code: 'invalid_log_input' } }); expect(malformed.headers.get('cache-control')).toBe('no-store')
})

it('publishes matching closed MCP and static OpenAPI profile level and field schemas', async () => {
  const listed = await call('/mcp', { method: 'POST', headers: { authorization: `Bearer ${mcpToken}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) })
  const tool = listed.body.result.tools.find((t: any) => t.name === 'set_runtime_log_policy')
  expect(tool.inputSchema.required).toEqual(['retentionDays', 'maxBytes'])
  const schema = tool.inputSchema.properties.fieldControls; expect(schema).toBeDefined(); expect(schema.additionalProperties).toBe(false)
  expect(Object.keys(schema.properties)).toEqual(LOG_FIELD_PROFILES.map(p => p.key))
  for (const profile of LOG_FIELD_PROFILES) {
    const levels = schema.properties[profile.key]; expect(levels.additionalProperties).toBe(false); expect(Object.keys(levels.properties)).toEqual([...LOG_LEVELS])
    for (const level of LOG_LEVELS) { const fields = levels.properties[level]; expect(fields.additionalProperties).toBe(false); expect(Object.keys(fields.properties)).toEqual(profile.fields.map(f => f.key)); expect(fields.required ?? []).toEqual([]); for (const field of profile.fields) expect(fields.properties[field.key].type).toBe('boolean') }
  }
  let metadata: any
  vi.stubGlobal('defineRouteMeta', (m: any) => { metadata = m })
  try {
    await import('../server/api/logs/policy.patch'); const patchMeta = metadata.openAPI
    const wire = patchMeta.requestBody.content['application/json'].schema
    expect(wire.required).toEqual(['retentionDays', 'maxBytes']); expect(wire.additionalProperties).toBe(false)
    const controls = wire.properties.fieldControls; expect(controls.additionalProperties).toBe(false); expect(Object.keys(controls.properties)).toEqual(LOG_FIELD_PROFILES.map(p => p.key))
    expect(Object.keys(controls.properties.http.properties)).toEqual([...LOG_LEVELS]); expect(controls.properties.http.additionalProperties).toBe(false)
    expect(Object.keys(controls.properties.http.properties.debug.properties)).toEqual(LOG_FIELD_PROFILES[0].fields.map(f => f.key)); expect(controls.properties.http.properties.debug.additionalProperties).toBe(false)
    await import('../server/api/logs/policy.get'); const getMeta = metadata.openAPI
    const response = getMeta.responses[200].content['application/json'].schema
    const document: any = { paths: { '/api/logs/policy': { get: getMeta, patch: patchMeta } } }
    const dereference = (schema: any): any => schema.$ref
      ? schema.$ref.slice(2).split('/').map((key: string) => key.replaceAll('~1', '/').replaceAll('~0', '~')).reduce((node: any, key: string) => node[key], document)
      : schema
    expect(response.required).toContain('fieldControls'); expect(response.properties.fieldControls.required).toEqual(LOG_FIELD_PROFILES.map(p => p.key))
    for (const profile of LOG_FIELD_PROFILES) {
      const effective = response.properties.fieldControls.properties[profile.key]
      expect(effective.required).toEqual([...LOG_LEVELS]); expect(effective.additionalProperties).toBe(false)
      expect(Object.keys(controls.properties[profile.key].properties)).toEqual([...LOG_LEVELS]); expect(controls.properties[profile.key].additionalProperties).toBe(false)
      for (const level of LOG_LEVELS) {
        for (const [candidate, required] of [[controls.properties[profile.key].properties[level], false], [effective.properties[level], true]] as const) {
          const fields = dereference(candidate)
          expect(fields.additionalProperties).toBe(false)
          expect(Object.keys(fields.properties)).toEqual(profile.fields.map(f => f.key))
          expect(fields.required ?? []).toEqual(required ? profile.fields.map(f => f.key) : [])
          for (const field of profile.fields) expect(fields.properties[field.key]).toEqual({ type: 'boolean' })
        }
      }
    }
    expect(dereference(patchMeta.responses[200].content['application/json'].schema)).toEqual(response)
    const catalog = response.properties.catalog.properties.profiles.items
    expect(catalog.properties.key.enum).toEqual(LOG_FIELD_PROFILES.map(p => p.key))
    expect(catalog.properties.levels.items.enum).toEqual([...LOG_LEVELS])
    expect(catalog.properties.fields.items.properties.key.enum).toEqual(LOG_FIELD_PROFILES.flatMap(p => p.fields.map(f => f.key)))
    expect(catalog.properties.source.enum).toEqual([...new Set(LOG_FIELD_PROFILES.map(p => p.source))])

  } finally { vi.unstubAllGlobals() }
})

it('uses policy argument budget rather than the JSONRPC envelope and preserves production OpenAPI guards', async () => {
  const previous = (await getPolicy()).body.fieldControls
  const result = await rpc('set_runtime_log_policy', policyBase, true, ' '.repeat(5000)); expect(result.status).toBe(200); expect(rpcBody(result).fieldControls).toEqual(previous)
  for (const path of ['/_openapi.json', '/_scalar', '/_swagger']) expect((await call(path)).status).toBe(404)
  for (const path of ['/api/health', '/api/jobs/kinds']) expect((await call(path)).status).toBe(200)
  const built = readFileSync('.output/server/chunks/nitro/nitro.mjs', 'utf8')
  const actual = [...new Set([...built.matchAll(/route: '([^']+)'/g)].map(m => m[1]!).filter(route => route === '/mcp' || route.startsWith('/api/')))].sort()
  expect(actual).toEqual([...APPLICATION_LOG_ROUTES].sort())
  expect(output + boundaryOutput).not.toContain(PRIVATE)
  expect(readFileSync(join(logDir, 'events.db')).toString()).not.toContain(PRIVATE)
  expect(hash(dbPath)).toBe(beforeDbHash)
})


it('keeps missing length rejection in real HTTP and separates native invalid length parsing', async () => {
  const missing = await new Promise<{ status: number; text: string; noStore: unknown }>((resolve, reject) => {
    const req = request(new URL('/api/logs/policy', baseUrl), { method: 'PATCH', headers: { ...api, 'content-type': 'application/json', 'transfer-encoding': 'chunked', connection: 'close' } }, res => {
      let text = ''; res.on('data', c => { text += c }); res.on('end', () => resolve({ status: res.statusCode!, text, noStore: res.headers['cache-control'] }))
    }); req.on('error', reject); req.end(JSON.stringify(policyBase))
  })
  expect(missing.status).toBe(413); expect(missing.noStore).toBe('no-store')
  const raw = await new Promise<string>((resolve, reject) => {
    const socket = connect(Number(new URL(baseUrl).port), '127.0.0.1'); let text = ''
    socket.on('error', reject); socket.setTimeout(2000, () => socket.destroy(new Error('native parser timeout')))
    socket.on('data', c => { text += c }); socket.on('end', () => resolve(text))
    socket.on('connect', () => socket.end('PATCH /api/logs/policy HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: invalid\r\nConnection: close\r\n\r\n' + PRIVATE))
  })
  expect(raw).toMatch(/^HTTP\/1\.1 400/); expect(raw).not.toContain(PRIVATE)
  observations.push({ kind: 'native-invalid-content-length', layer: 'Node HTTP parser before Nitro', status: 400 })
})
