import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { useDb } from '../db/client'
import { spawnOwnedChild as spawn, reserveLoopbackPort, stopOwnedChild, waitForHttp } from '../scripts/lib/isolated-local-services.mjs'

// Built-product task context checks. Fresh empty synthetic schema, explicit
// tokens, no parent manual fixture or real business data; no implicit build.
const root = mkdtempSync(join(tmpdir(), 'main-sync-logging-http-'))
const token = 'synthetic-main-sync-token'
let child: ReturnType<typeof spawn> | undefined, base = '', output = ''
let annualSubmission: { jobId: string; requestId: string } | undefined
beforeAll(async () => {
  const db = useDb({ dbPath: join(root, 'synthetic.db') }); db.$client.close()
  const port = await reserveLoopbackPort(); expect(port).not.toBe(50055)
  base = `http://127.0.0.1:${port}`
  child = spawn(process.execPath, ['.output/server/index.mjs'], {
    cwd: resolve(import.meta.dirname, '..'), stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NODE_ENV: 'production', HOST: '127.0.0.1', PORT: String(port), NUXT_DB_PATH: join(root, 'synthetic.db'), NUXT_DB_READONLY: '0', NUXT_LOG_DIR: join(root, 'logs'), NUXT_FILES_DIR: join(root, 'files'), NUXT_INCOMING_DIR: join(root, 'incoming'), NUXT_CURATED_PATH: join(root, 'curated.json'), NUXT_RECONCILE_PATH: join(root, 'reconcile.json'), NUXT_API_TOKEN: token, NUXT_MCP_TOKEN: token, NUXT_OCR_TOKEN: '', NUXT_PLATFORM_COOKIE: '' },
  })
  child.stdout!.on('data', chunk => { output = (output + chunk).slice(-64000) })
  child.stderr!.on('data', chunk => { output = (output + chunk).slice(-64000) })
  await waitForHttp(base + '/api/health', { child, timeoutMs: 30000 })
}, 40_000)
afterAll(async () => { if (child) await stopOwnedChild(child); rmSync(root, { recursive: true, force: true }) })
async function request(path: string, init: RequestInit = {}) {
  const response = await fetch(base + path, { ...init, signal: AbortSignal.timeout(15000) })
  const text = await response.text()
  const body = JSON.parse(text.startsWith('event:') ? text.split('\n').find(line => line.startsWith('data: '))!.slice(6) : text)
  return { status: response.status, body, requestId: response.headers.get('x-request-id') }
}
async function assertTerminal(id: string, requestId: string) {
  let rows: any[] = []
  const deadline = Date.now() + 12000
  while (Date.now() < deadline) {
    const listed = await request('/api/logs?' + new URLSearchParams({ taskId: id, limit: '100' }), { headers: { authorization: `Bearer ${token}` } })
    expect(listed.status).toBe(200)
    rows = listed.body.rows
    if (rows.some(row => row.operation === 'task.finished')) break
    await new Promise(resolve => setTimeout(resolve, 75))
  }
  expect(rows.filter(row => row.operation === 'task.finished'), output.slice(-3000)).toHaveLength(1)
  expect(rows.every(row => row.requestId === requestId && typeof row.traceId === 'string')).toBe(true)
  expect(rows.filter(row => row.operation === 'task.started')).toHaveLength(1)
  expect(JSON.stringify(rows)).not.toContain('PRIVATE_MAIN_SYNC_REQUEST')
}
it.each(['annual', 'candidate'] as const)('correlates actual built REST %s submissions through persisted terminal logs', async kind => {
  const path = kind === 'annual' ? '/api/roster/annual-correspondence-tasks' : '/api/roster/correspondences/tasks'
  const response = await request(path, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-request-id': 'PRIVATE_MAIN_SYNC_REQUEST' }, body: JSON.stringify({ clientRequestId: 'synthetic-rest-' + kind, eventIds: [999] }) })
  expect(response.status).toBe(202)
  expect(response.requestId).toBeTruthy(); expect(response.requestId).not.toBe('PRIVATE_MAIN_SYNC_REQUEST')
  await assertTerminal(response.body.jobId, response.requestId!)
  if (kind === 'annual') annualSubmission = { jobId: response.body.jobId, requestId: response.requestId! }
})
it.each(['annual', 'candidate'] as const)('correlates actual built MCP %s tool submissions through the module context hook', async kind => {
  const name = kind === 'annual' ? 'submit_event_annual_correspondence_task' : 'submit_event_archive_candidate_task'
  const response = await request('/mcp', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: { clientRequestId: 'synthetic-mcp-' + kind, eventIds: [998] } } }) })
  expect(response.status).toBe(200)
  expect(response.body.result.isError).not.toBe(true)
  const receipt = response.body.result.structuredContent ?? JSON.parse(response.body.result.content[0].text)
  await assertTerminal(receipt.jobId, response.requestId!)
})
it('keeps the original annual execution attribution when MCP returns a deduplicated REST task', async () => {
  expect(annualSubmission).toBeDefined()
  const response = await request('/mcp', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'submit_event_annual_correspondence_task', arguments: { clientRequestId: 'synthetic-dedup', eventIds: [999] } } }) })
  expect(response.status).toBe(200)
  expect(response.body.result.isError).not.toBe(true)
  const receipt = response.body.result.structuredContent ?? JSON.parse(response.body.result.content[0].text)
  expect(receipt.jobId).toBe(annualSubmission!.jobId)
  expect(response.requestId).not.toBe(annualSubmission!.requestId)
  await assertTerminal(receipt.jobId, annualSubmission!.requestId)
})
