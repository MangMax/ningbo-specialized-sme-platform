import { afterAll, beforeAll, expect, it } from 'vitest'
import { type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initializeDb } from '../../../db/client'
import { LOG_LEVELS } from '../../../layers/core/lib/logging/contract'
import { LOG_FIELD_PROFILES } from '../../../layers/core/lib/logging/field-controls'
import { spawnOwnedChild as spawn, reserveLoopbackPort, stopOwnedChild, waitForHttp } from '../../support/owned-process.mjs'

// Only this checkout's already-built artifact; caller records its frozen tree.
// No production TUS callback, request hook, storage or logger is replaced.
const root = mkdtempSync(join(tmpdir(), 'tus-field-http-'))
const dbPath = join(root, 'synthetic.db'), logs = join(root, 'logs'), files = join(root, 'files'), incoming = join(root, 'incoming')
const payload = Buffer.from('PRIVATE_TUS_FIELD_BYTES_180\n'), token = 'synthetic-tus-field-api', mcpToken = 'synthetic-tus-field-mcp'
const api = { authorization: `Bearer ${token}` }, base = { retentionDays: 7, maxBytes: 536870912 }
const fields = ['tus.method', 'tus.uploadId', 'tus.size', 'tus.offset'] as const
let child: ChildProcess, url = '', output = '', beforeHash = '', initialHealth: unknown
const observations: unknown[] = []
const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')
async function call(path: string, init: RequestInit = {}) {
  const response = await fetch(url + path, { ...init, signal: AbortSignal.timeout(5000) })
  const text = await response.text(); let body: any
  try { body = JSON.parse(text) } catch { body = text }
  return { status: response.status, headers: response.headers, body, requestId: response.headers.get('x-request-id')! }
}
async function rpc(name: string, args: unknown) {
  const response = await call('/mcp', { method: 'POST', headers: { authorization: `Bearer ${mcpToken}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) })
  expect(response.status).toBe(200); expect(response.body.error).toBeUndefined(); expect(response.body.result.isError).not.toBe(true)
  return response.body.result.structuredContent ?? JSON.parse(response.body.result.content[0].text)
}
async function fileEvent(requestId: string) {
  let found: any
  await expect.poll(async () => {
    const result = await call('/api/logs?' + new URLSearchParams({ requestId, source: 'file' }), { headers: api })
    expect(result.status).toBe(200); found = result.body.rows.find((row: any) => row.operation === 'file.upload'); return !!found
  }, { timeout: 6000 }).toBe(true)
  const detail = await call('/api/logs/' + found.id, { headers: api }); expect(detail.status).toBe(200); expect(detail.body).toEqual(found)
  await expect.poll(() => output.split('\n').flatMap(line => { try { return [JSON.parse(line)] } catch { return [] } }).find(row => row.id === found.id)).toEqual(found)
  return found
}
beforeAll(async () => {
  expect(existsSync('.output/server/index.mjs')).toBe(true)
  const db = initializeDb({ create: true,  dbPath }); db.$client.close(); beforeHash = hash(dbPath)
  mkdirSync(files); mkdirSync(incoming)
  const port = await reserveLoopbackPort(); expect(port).not.toBe(50055); url = `http://127.0.0.1:${port}`
  child = spawn(process.execPath, ['.output/server/index.mjs'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), NODE_ENV: 'production', NUXT_DB_PATH: dbPath, NUXT_DB_READONLY: '1', NUXT_LOG_DIR: logs, NUXT_FILES_DIR: files, NUXT_INCOMING_DIR: incoming, NUXT_API_TOKEN: token, NUXT_MCP_TOKEN: mcpToken, NUXT_CURATED_PATH: join(root, 'curated.json'), NUXT_RECONCILE_PATH: join(root, 'reconcile.json') } })
  child.stdout!.on('data', c => { output += c }); child.stderr!.on('data', c => { output += c })
  const ready = await waitForHttp(url + '/api/health', { child }); initialHealth = await ready.json()
  observations.push({ root, url, pid: child.pid, beforeHash, artifactHash: hash('.output/server/chunks/nitro/nitro.mjs') })
}, 90000)
afterAll(async () => {
  await stopOwnedChild(child)
  const afterHash = existsSync(dbPath) ? hash(dbPath) : null
  observations.push({ afterHash, unchangedBusinessDb: afterHash === beforeHash, rawAbsent: !output.includes(payload.toString().trim()), child: { pid: child?.pid, exitCode: child?.exitCode, signalCode: child?.signalCode } })

  rmSync(root, { recursive: true, force: true })
  expect(afterHash).toBe(beforeHash); expect(output).not.toContain(payload.toString().trim())
})
async function roundTrip(disabled?: typeof fields[number]) {
  const rules = Object.fromEntries(fields.map(field => [field, field !== disabled]))
  const saved = await rpc('set_runtime_log_policy', { ...base, fieldControls: { tus: Object.fromEntries(LOG_LEVELS.map(level => [level, rules])) } })
  expect(saved.catalog.profiles).toEqual(LOG_FIELD_PROFILES); expect(saved.catalog.profiles.map((p: any) => p.key)).toEqual(['http', 'tus'])
  const read = await call('/api/logs/policy', { headers: api }); expect(read.body.fieldControls).toEqual(saved.fieldControls)
  expect((await rpc('get_runtime_log_policy', {})).fieldControls).toEqual(saved.fieldControls)
  // Respect the existing ten-lines/second stdout budget for the exact events compared below.
  await new Promise(resolve => setTimeout(resolve, 1050))
  const filename = `tus-${disabled?.slice(4).toLowerCase() ?? 'default'}.txt`
  const metadata = Object.entries({ source: 'jxj', kind: 'announcement', year: '2026', batch: '4', filename }).map(([key, value]) => `${key} ${Buffer.from(value).toString('base64')}`).join(',')
  const created = await call('/api/uploads', { method: 'POST', headers: { 'Tus-Resumable': '1.0.0', 'Upload-Length': String(payload.length), 'Upload-Metadata': metadata } })
  expect(created.status).toBe(201); expect(created.headers.get('tus-resumable')).toBe('1.0.0')
  const id = created.headers.get('location')!.split('/').pop()!; expect(id).toMatch(/^[a-f0-9]{32}$/)
  const rejected = await call('/api/uploads/' + id, { method: 'PATCH', headers: { 'Tus-Resumable': '1.0.0', 'Upload-Offset': '2', 'content-type': 'application/offset+octet-stream' }, body: payload })
  expect(rejected.status).toBe(409)
  const completed = await call('/api/uploads/' + id, { method: 'PATCH', headers: { 'Tus-Resumable': '1.0.0', 'Upload-Offset': '0', 'content-type': 'application/offset+octet-stream' }, body: payload })
  expect(completed.status).toBe(204); expect(completed.headers.get('upload-offset')).toBe(String(payload.length))
  const path = `jxj/announcement/2026/4/${filename}`
  expect(decodeURIComponent(completed.headers.get('x-upload-path')!)).toBe(path)
  expect(readFileSync(join(files, path)).equals(payload)).toBe(true)
  expect(existsSync(join(incoming, id + '.json'))).toBe(false)
  const events = []
  for (const [response, phase, method, outcome, expectedFacts] of [
    [created, 'created', 'POST', 'started', { size: payload.length, offset: 0 }],
    // Native offset errors close the connection; the existing middleware records failure.
    [rejected, 'request-failed', 'PATCH', 'failure', {}],
    [completed, 'completed', 'PATCH', 'success', { size: payload.length, offset: payload.length }],
  ] as const) {
    const event = await fileEvent(response.requestId)
    const expectedTus: any = { uploadId: id, phase, method, ...expectedFacts }
    if (disabled) delete expectedTus[disabled.slice(4)]
    expect(event.tus).toEqual(expectedTus)
    expect(event).toMatchObject({ source: 'file', operation: 'file.upload', statusCode: response.status, outcome, durationMs: expect.any(Number), origin: { integration: 'tus', capture: 'hook' } })
    if (phase === 'request-failed') expect(event.errorCode).toBe('file_upload_failed')
    if (disabled) expect(event.fieldCapture).toEqual({ profile: 'tus', revision: saved.revision, disabled: [disabled] })
    else expect(event).not.toHaveProperty('fieldCapture')
    if (disabled === 'tus.uploadId') expect(JSON.stringify(event)).not.toContain(id)
    events.push(event)
  }
  if (disabled === 'tus.uploadId') expect(output).not.toContain(id)
  expect((await call('/api/health')).body).toEqual(initialHealth); expect(hash(dbPath)).toBe(beforeHash)
  observations.push({ disabled: disabled ?? 'none', uploadId: id, statuses: [created.status, rejected.status, completed.status], landed: path, fileSHA256: hash(join(files, path)), events })
}
it('real TUS defaults preserve creation failure completion context and original file placement without registration', async () => { await roundTrip() })
for (const field of fields) it(`real TUS ${field} off preserves phase response bytes and registration separation`, async () => { await roundTrip(field) })
it('real TUS pre-create rejection has no invented context or capture despite disabled TUS fields', async () => {
  await rpc('set_runtime_log_policy', { ...base, fieldControls: { tus: Object.fromEntries(LOG_LEVELS.map(level => [level, Object.fromEntries(fields.map(field => [field, false]))])) } })
  await new Promise(resolve => setTimeout(resolve, 1050))
  // Missing protocol version is rejected before onIncomingRequest assigns an id.
  // Metadata rejection happens later and legitimately already has a library id.
  const rejected = await call('/api/uploads', { method: 'POST', headers: { 'Upload-Length': '12' } })
  expect(rejected.status).toBe(412)
  const event = await fileEvent(rejected.requestId)
  expect(event).toMatchObject({ source: 'file', outcome: 'denied', errorCode: 'file_upload_rejected' }); expect(event).not.toHaveProperty('tus'); expect(event).not.toHaveProperty('fieldCapture')
})
it('real TUS policy keeps HTTP profile MCP transport and legacy PATCH independently effective', async () => {
  const before = await call('/api/logs/policy', { headers: api })
  const legacy = await call('/api/logs/policy', { method: 'PATCH', headers: { ...api, 'content-type': 'application/json' }, body: JSON.stringify(base) })
  expect(legacy.status).toBe(200); expect(legacy.body.fieldControls).toEqual(before.body.fieldControls)
  const health = await call('/api/health'); expect(health.status).toBe(200); expect(health.body).toEqual(initialHealth)
  let http: any
  await expect.poll(async () => { const listed = await call('/api/logs?' + new URLSearchParams({ requestId: health.requestId }), { headers: api }); http = listed.body.rows.find((e: any) => e.source === 'http'); return !!http }).toBe(true)
  expect(http).toMatchObject({ httpMethod: 'GET', httpRoute: '/api/health', statusCode: 200, durationMs: expect.any(Number) }); expect(http).not.toHaveProperty('fieldCapture')
  const transport = await call('/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) })
  expect(transport.status).toBe(200)
  let mcp: any
  await expect.poll(async () => { const listed = await call('/api/logs?' + new URLSearchParams({ requestId: transport.requestId }), { headers: api }); mcp = listed.body.rows.find((e: any) => e.source === 'mcp'); return !!mcp }).toBe(true)
  expect(mcp).toMatchObject({ httpMethod: 'POST', httpRoute: '/mcp', statusCode: 200, durationMs: expect.any(Number) }); expect(mcp).not.toHaveProperty('fieldCapture')
  expect((await call('/api/logs/policy')).status).toBe(401)
})
