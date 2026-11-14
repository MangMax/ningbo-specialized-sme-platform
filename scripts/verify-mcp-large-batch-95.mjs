#!/usr/bin/env node
// #95 spike: built Nitro, real public transports, owned synthetic SQLite only.
import assert from 'node:assert/strict'

import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { forkOwnedChild as fork, reserveLoopbackPort, stopOwnedChild } from './lib/isolated-local-services.mjs'

const { createJiti } = createRequire(import.meta.resolve('nuxt/package.json'))('jiti')
const { initializeDb } = await createJiti(import.meta.url).import('../db/client.ts')
const dir = mkdtempSync(join(tmpdir(), 'mcp-large-batch-95-'))
const dbPath = join(dir, 'synthetic.sqlite')
initializeDb({ dbPath, create: true }).$client.close()
const apiToken = randomBytes(24).toString('hex')
const mcpToken = randomBytes(24).toString('hex')
assert.notEqual(apiToken, mcpToken)
const port = await reserveLoopbackPort()
const base = `http://127.0.0.1:${port}`
let owned, rpcId = 0

const input = {
  idempotencyKey: 'synthetic:95:single-atomic-batch',
  sourceKind: 'platform_export',
  sourceIdentity: 'synthetic-95.xlsx',
  payload: { exportSnapshot: {
    titleCode: 'specialized_sme', year: 2026, collectedOn: '2026-10-20',
    originalFilename: 'synthetic-95.xlsx', sha256: 'synthetic-95-full',
    rows: Array.from({ length: 300 }, (_, index) => ({
      sourceRowNo: index + 3,
      rawFields: { original: 'x'.repeat(index === 150 ? 1_200_000 : 14_753) },
    })),
  } },
}
const small = { ...input, idempotencyKey: 'synthetic:95:auth-probe', payload: {} }
const jsonBody = JSON.stringify(input)
const httpBytes = Buffer.byteLength(jsonBody)
const rpcBody = (name, args) => JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } })

async function http(method, path, body, token = apiToken) {
  return fetch(`${base}${path}`, {
    method, signal: AbortSignal.timeout(30_000),
    headers: { connection: 'close', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
  })
}
async function rpc(name, args, token = mcpToken) {
  const response = await fetch(`${base}/mcp`, {
    method: 'POST', signal: AbortSignal.timeout(30_000),
    headers: { connection: 'close', ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: rpcBody(name, args),
  })
  const raw = await response.text()
  let body
  try { body = JSON.parse(raw.split('\n').find(line => line.startsWith('data: '))?.slice(6) ?? raw) } catch {}
  return { status: response.status, body }
}
function rpcValue(response) {
  assert.equal(response.status, 200)
  assert.ok(response.body?.result && !response.body.result.isError && !response.body.error)
  return JSON.parse(response.body.result.content[0].text)
}
async function receipt() {
  return http('GET', `/api/roster/import/receipts?idempotencyKey=${encodeURIComponent(input.idempotencyKey)}`)
}
async function post(action) {
  const response = await http('POST', `/api/roster/import/${action}`, jsonBody)
  assert.equal(response.status, 200, `HTTP ${action} must succeed`)
  return response.json()
}

try {
  owned = fork('.output/server/index.mjs', [], {
    execArgv: ['--max-old-space-size=2048'],
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), NUXT_DB_PATH: dbPath, NUXT_DB_READONLY: '0',
      NUXT_FILES_DIR: dir, NUXT_INCOMING_DIR: dir, NUXT_API_TOKEN: apiToken, NUXT_MCP_TOKEN: mcpToken,
      MIIT_COOKIE: '', NUXT_OCR_TOKEN: '', PADDLEOCR_MCP_AISTUDIO_ACCESS_TOKEN: '' },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  })
  let ready = false
  for (let attempt = 0; attempt < 120; attempt++) {
    assert.equal(owned.exitCode, null, 'owned built server exited before readiness')
    try { ready = (await http('GET', '/api/health')).ok } catch {}
    if (ready) break
    await sleep(50)
  }
  assert.ok(ready, 'owned built server becomes ready')

  assert.equal((await http('POST', '/api/roster/import/preflight', small, mcpToken)).status, 401,
    'MCP credential cannot authorize HTTP import')
  assert.equal((await rpc('save_roster_batch', small, apiToken)).status, 401,
    'HTTP credential cannot authorize MCP write')

  const listBody = JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/list', params: {} })
  async function listAtBytes(bytes) {
    const response = await fetch(`${base}/mcp`, {
      method: 'POST', signal: AbortSignal.timeout(30_000),
      headers: { connection: 'close', 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: listBody + ' '.repeat(bytes - Buffer.byteLength(listBody)),
    })
    const text = await response.text()
    return { status: response.status, text }
  }
  const atLimit = await listAtBytes(4 * 1024 * 1024)
  assert.equal(atLimit.status, 200, 'exactly 4 MiB remains admissible')
  const overLimit = await listAtBytes(4 * 1024 * 1024 + 1)
  assert.equal(overLimit.status, 413, 'one byte above the SDK limit is rejected')
  assert.match(overLimit.text, /Payload Too Large: Request body must not exceed 4194304 bytes/)

  const mcpBytes = Buffer.byteLength(rpcBody('preflight_roster_batch', input))
  assert.ok(mcpBytes > 4 * 1024 * 1024 && httpBytes > 4 * 1024 * 1024)
  const rejected = await rpc('preflight_roster_batch', input, null)
  assert.equal(rejected.status, 413, 'oversized MCP call is rejected at the public transport')
  assert.equal(rejected.body?.error?.code, -32000)
  assert.equal(rejected.body.error.message, 'Payload Too Large: Request body must not exceed 4194304 bytes')
  assert.equal((await receipt()).status, 404, '413 did not create a preflight batch or receipt')

  const preflight = await post('preflight')
  assert.equal(preflight.status, 'preflight')
  assert.equal(preflight.preflight.add, 1)
  const before = await (await receipt()).json()
  assert.equal(before.batchId, preflight.batchId)
  assert.equal(before.status, 'preflight')
  assert.equal(before.summary, null)

  const committed = await post('commit')
  assert.equal(committed.batchId, preflight.batchId)
  assert.equal(committed.status, 'committed')
  assert.deepEqual(committed.summary, { written: 301, skipped: 0, failed: 0, evidenceRepointed: 0 })
  const rowIds = committed.items[0].detail.rows
  assert.equal(rowIds.length, 300)
  assert.equal(new Set(rowIds).size, 300)
  for (const index of [0, 149, 150, 199, 200, 299]) {
    const response = await http('GET', `/api/roster/correspondences/export-rows/${rowIds[index]}`)
    assert.equal(response.status, 200)
    const { source } = await response.json()
    assert.equal(source.sourceRowNo, index + 3)
    assert.deepEqual(source.rawFields, input.payload.exportSnapshot.rows[index].rawFields)
  }
  const durable = await (await receipt()).json()
  assert.equal(durable.status, 'committed')
  assert.equal(durable.summary.written, 301)
  assert.ok(durable.receiptId > 0)
  assert.deepEqual(rpcValue(await rpc('get_roster_import_receipt', { idempotencyKey: input.idempotencyKey })), durable)
  const historyPath = `/api/roster/import/receipts/history?idempotencyKey=${encodeURIComponent(input.idempotencyKey)}`
  const beforeReplay = await (await http('GET', historyPath)).json()
  assert.deepEqual(beforeReplay.rows.map(row => row.operation), ['preflight', 'commit'])
  assert.deepEqual(await post('commit'), committed, 'same-key replay returns identical full receipt')
  assert.deepEqual(await (await receipt()).json(), durable, 'replay retains one durable receipt')
  const history = await (await http('GET', historyPath)).json()
  assert.deepEqual(history, beforeReplay, 'same-key replay did not add a receipt attempt')
  assert.equal(history.total, 2)
  assert.equal(history.rows[1].receiptId, durable.receiptId)

  console.log(JSON.stringify({ passed: true, sourceSha: process.env.SOURCE_SHA ?? null,
    lane: 'built Nitro public HTTP/MCP on owned synthetic SQLite', httpBytes, mcpBytes,
    mcpAtLimitStatus: atLimit.status, mcpOverLimitStatus: overLimit.status,
    mcpStatus: rejected.status, mcpErrorCode: rejected.body.error.code,
    httpAuthWithMcpToken: 401, mcpWriteAuthWithHttpToken: 401,
    preflightStatus: preflight.status, commitStatus: committed.status,
    rowsWritten: committed.summary.written, rowsReadBack: 6, replayIdentical: true, receiptHistoryCount: history.total,
    productionChanged: false }))
} finally {
  await stopOwnedChild(owned)
  rmSync(dir, { recursive: true, force: true })
}
