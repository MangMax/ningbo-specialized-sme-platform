#!/usr/bin/env node
// Actual built Nuxt -> isolated import worker/SQLite -> evlog drain -> protected REST/MCP reads.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnOwnedChild as spawn, reserveLoopbackPort, waitForHttp, stopOwnedChild } from './lib/isolated-local-services.mjs'

const cwd = resolve(import.meta.dirname, '..')
const root = mkdtempSync(join(tmpdir(), 'nuxt-import187-'))
const reportPath = process.env.IMPORT187_REPORT ?? join(root, 'report.json')
const report = { sourceClean: execFileSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8' }).trim() === '', sourceHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim(), sourceTree: execFileSync('git', ['write-tree'], { cwd, encoding: 'utf8' }).trim(), root, checks: [], lanes: { actualNuxt: 'running', browser: 'unrun', production: 'unrun', capacitySlo: 'unrun' } }
const toolkitRequire = createRequire(import.meta.resolve('@nuxtjs/mcp-toolkit'))
const { Client } = toolkitRequire('@modelcontextprotocol/sdk/client/index.js')
const { StreamableHTTPClientTransport } = toolkitRequire('@modelcontextprotocol/sdk/client/streamableHttp.js')
const apiToken = 'synthetic-api-187', mcpToken = 'synthetic-mcp-187'
const privacy = 'PRIVATE187-' + randomUUID()
const flag = join(root, 'drop-next-worker-response')
const holdFlag = join(root, 'hold-worker-dispatch')
const preload = join(root, 'ipc-fault.cjs')
writeFileSync(preload, `const fs=require('node:fs'); if(process.send && process.argv.some(x=>x.endsWith('/import-execution-worker.mjs'))){
const capture=${JSON.stringify(join(root, 'worker-output.log'))};for(const stream of [process.stdout,process.stderr]){const write=stream.write.bind(stream);stream.write=(chunk,...args)=>{fs.appendFileSync(capture,chunk);return write(chunk,...args);};}
const send=process.send.bind(process);process.send=(message,...args)=>{if(message.type==='result' && fs.existsSync(${JSON.stringify(flag)})){fs.unlinkSync(${JSON.stringify(flag)});process.kill(process.pid,'SIGKILL');return true;}return send(message,...args);};
const on=process.on.bind(process);process.on=(event,listener)=>on(event,event==='message'?(message)=>{const deliver=()=>{if(fs.existsSync(${JSON.stringify(holdFlag)}))setTimeout(deliver,10);else listener(message);};deliver();}:listener);
}`)
let child, base, client, output = ''
const allOutput = []
const dbPath = join(root, 'business', 'roster.db')
const logDir = join(root, 'logs')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function checked(name, fn) { await fn(); report.checks.push(name); console.log(`PASS ${name}`) }
function input(label, rows = 3) { return { idempotencyKey: privacy + '-key-' + label, sourceKind: 'platform_export', sourceIdentity: '/' + privacy + '/' + label + '.xlsx', payload: { exportSnapshot: {
  titleCode: 'specialized_sme', year: 2026, collectedOn: '2026-10-20', originalFilename: privacy + '.xlsx', sha256: 'fixture-' + label,
  rows: Array.from({ length: rows }, (_, i) => ({ sourceRowNo: i + 3, rawFields: { original: privacy + '-raw-' + i } })),
} } } }
async function http(method, path, body, authorized = true) {
  const response = await fetch(base + path, { method, headers: { ...(authorized ? { authorization: 'Bearer ' + apiToken } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
  return { status: response.status, requestId: response.headers.get('x-request-id'), body: await response.json() }
}
const post = (action, body) => http('POST', '/api/roster/import/' + action, body)
const receipt = body => http('GET', '/api/roster/import/receipts?idempotencyKey=' + encodeURIComponent(body.idempotencyKey))
const history = body => http('GET', '/api/roster/import/receipts/history?idempotencyKey=' + encodeURIComponent(body.idempotencyKey))
async function logs(filter) {
  const query = new URLSearchParams({ ...filter, limit: '100' })
  const response = await http('GET', '/api/logs?' + query)
  assert.equal(response.status, 200)
  return response.body.rows
}
async function logged(filter, predicate = rows => rows.length > 0) {
  for (let i = 0; i < 60; i++) { const rows = await logs(filter); if (predicate(rows)) return rows; await delay(50) }
  assert.fail('Missing durable log event: ' + JSON.stringify(filter))
}
async function detail(row) { return (await http('GET', '/api/logs/' + row.id)).body }
async function connect() {
  client = new Client({ name: 'import187-fixture', version: '1' })
  await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), { requestInit: { headers: { authorization: 'Bearer ' + mcpToken } } }))
}
async function mcp(name, args) {
  const result = await client.callTool({ name, arguments: args })
  if (result.structuredContent) return { error: result.isError === true, body: result.structuredContent }
  const text = result.content?.filter(x => x.type === 'text').map(x => x.text).join('\n')
  let body
  try { body = JSON.parse(text) } catch { body = text }
  return { error: result.isError === true, body }
}
async function start(unavailable = false) {
  const port = await reserveLoopbackPort()
  base = 'http://127.0.0.1:' + port
  output = ''
  const env = { ...process.env, NODE_ENV: 'production', HOST: '127.0.0.1', PORT: String(port), NUXT_DB_PATH: dbPath,
    NUXT_FILES_DIR: join(root, 'files'), NUXT_INCOMING_DIR: join(root, 'incoming'), NUXT_CURATED_PATH: join(root, 'curated.json'), NUXT_RECONCILE_PATH: join(root, 'reconcile.json'),
    NUXT_API_TOKEN: apiToken, NUXT_MCP_TOKEN: mcpToken, NUXT_OCR_TOKEN: '', NUXT_OCR_BASE_URL: 'http://127.0.0.1:1', NUXT_PLATFORM_COOKIE: '', NUXT_DB_READONLY: '0',
    NUXT_LOG_DIR: unavailable ? '/dev/null/import187' : logDir, NODE_OPTIONS: '--require=' + preload,
  }
  child = spawn(process.execPath, [join(cwd, '.output/server/index.mjs')], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output += chunk.toString(); allOutput.push(chunk.toString()) })
  await waitForHttp(base + '/api/health', { child, timeoutMs: 30000 }).catch(async () => { await waitForHttp(base + '/', { child, timeoutMs: 30000 }) })
  await connect()
}
async function stop() { await client?.close(); client = undefined; await stopOwnedChild(child); child = undefined }
try {
  mkdirSync(join(root, 'files'), { recursive: true })
  await start()
  await checked('import authorization remains unchanged for REST writes and protected MCP save', async () => {
    assert.equal((await http('POST', '/api/roster/import/commit', input('unauthorized'), false)).status, 401)
    const response = await fetch(base + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 187, method: 'tools/call', params: { name: 'save_roster_batch', arguments: input('unauthorized-mcp') } }) })
    assert.equal(response.status, 401)
  })
  await checked('HTTP preflight and commit persist one semantic event with server request and receipt IDs', async () => {
    const body = input('http', 300)
    const preflight = await post('preflight', body)
    assert.equal(preflight.status, 200); assert.deepEqual(preflight.body.preflight.conflicts, [])
    const commit = await post('commit', body)
    assert.equal(commit.status, 200); assert.equal(commit.body.status, 'committed'); assert.equal(commit.body.summary.written, 301)
    const durable = await receipt(body)
    assert.equal(durable.body.status, 'committed')
    const rows = await logged({ operation: 'import.commit', requestId: commit.requestId })
    assert.equal(rows.length, 1)
    assert.equal(rows[0].outcome, 'success')
    const event = await detail(rows[0])
    assert.equal(event.batchId, durable.body.batchId); assert.equal(event.receiptId, durable.body.receiptId); assert.deepEqual(event.counts, { done: 301, failed: 0 })
    const replay = await post('commit', body)
    assert.deepEqual(replay.body, commit.body)
    assert.equal((await history(body)).body.total, 2)
    assert.equal((await logged({ operation: 'import.commit.replay', requestId: replay.requestId }))[0].outcome, 'success')
    const conflict = await post('commit', { ...body, sourceIdentity: '/' + privacy + '/different.xlsx' })
    assert.equal(conflict.status, 409); assert.equal(conflict.body.error.code, 'idempotency_conflict')
    assert.equal((await detail((await logged({ operation: 'import.submission.commit', requestId: conflict.requestId }))[0])).errorCode, 'idempotency_conflict')
  })
  await checked('HTTP conflict is semantic denial despite HTTP200 and writes no successful commit', async () => {
    const body = input('invalid'); body.payload.exportSnapshot.titleCode = 'invalid-title'
    const preflight = await post('preflight', body)
    assert.ok(preflight.body.preflight.conflicts.length)
    assert.equal((await logged({ operation: 'import.preflight', requestId: preflight.requestId }))[0].outcome, 'denied')
    const failed = await post('commit', body)
    assert.equal(failed.body.status, 'failed'); assert.equal(failed.body.summary.written, 0)
    assert.equal((await logged({ operation: 'import.commit', requestId: failed.requestId }))[0].outcome, 'failure')
    assert.equal((await receipt(body)).body.status, 'failed')
  })
  await checked('actual MCP preflight commit duplicate and conflict retain receipt truth and server correlation', async () => {
    const body = input('mcp')
    assert.equal((await mcp('preflight_roster_batch', body)).body.status, 'preflight')
    const saved = await mcp('save_roster_batch', body)
    assert.equal(saved.error, false); assert.equal(saved.body.status, 'committed')
    const events = await logged({ operation: 'import.commit', batchId: saved.body.batchId })
    assert.equal(events.length, 1); assert.ok(events[0].requestId); assert.ok(events[0].traceId)
    assert.equal((await logged({ operation: 'mcp.request', requestId: events[0].requestId }))[0].source, 'mcp')
    assert.deepEqual((await mcp('save_roster_batch', body)).body, saved.body)
    assert.equal((await history(body)).body.total, 2)
    assert.equal((await logged({ operation: 'import.commit.replay', batchId: saved.body.batchId }))[0].outcome, 'success')
    const conflict = await mcp('save_roster_batch', { ...body, sourceIdentity: privacy + '-other' })
    assert.equal(conflict.error, true); assert.equal(conflict.body.error.code, 'idempotency_conflict')
  })
  await checked('actual HTTP and MCP lost worker responses recover via one durable receipt and same-key replay', async () => {
    for (const lane of ['http', 'mcp']) {
      const body = input('lost-' + lane)
      writeFileSync(flag, 'fixture')
      const lost = lane === 'http' ? await post('commit', body) : await mcp('save_roster_batch', body)
      if (lane === 'http') assert.equal(lost.status, 503); else assert.equal(lost.error, true)
      assert.equal(lost.body.error.code, 'import_outcome_unknown')
      const durable = await receipt(body)
      assert.equal(durable.body.status, 'committed'); assert.equal(durable.body.summary.written, 4)
      const retry = lane === 'http' ? await post('commit', body) : await mcp('save_roster_batch', body)
      assert.equal(retry.body.status, 'committed'); assert.equal(retry.body.batchId, durable.body.batchId)
      assert.equal((await history(body)).body.total, 1)
      assert.equal((await logged({ operation: 'import.commit.replay', batchId: durable.body.batchId }))[0].outcome, 'success')
    }
    assert.ok((await logged({ operation: 'import.execution', outcome: 'unknown' }, rows => rows.length === 2)).every(x => x.requestId))
  })
  await checked('actual HTTP busy admission leaves no receipt and recovers after eight accepted atomic batches', async () => {
    const baseline = (await logs({ operation: 'import.admission', outcome: 'started' })).length
    let pending = []
    try {
      writeFileSync(holdFlag, 'fixture')
      pending = Array.from({ length: 8 }, (_, i) => post('commit', input('backlog-' + i)))
      await logged({ operation: 'import.admission', outcome: 'started' }, rows => rows.length === baseline + 8)
      const body = input('busy')
      const busy = await post('commit', body)
      assert.equal(busy.status, 503); assert.equal(busy.body.error.code, 'import_busy')
      assert.equal((await receipt(body)).status, 404)
      assert.equal((await logged({ operation: 'import.admission', outcome: 'denied', requestId: busy.requestId }))[0].outcome, 'denied')
    } finally { rmSync(holdFlag, { force: true }); await Promise.all(pending) }
    for (const result of await Promise.all(pending)) { assert.equal(result.body.status, 'committed'); assert.equal(result.body.summary.failed, 0) }
  })
  await checked('protected log summaries details MCP and raw store contain no input privacy marker', async () => {
    assert.equal((await http('GET', '/api/logs', undefined, false)).status, 401)
    let cursor
    do {
      const page = await http('GET', '/api/logs?' + new URLSearchParams({ limit: '100', ...(cursor ? { cursor } : {}) }))
      assert.equal(page.status, 200); assert.ok(!JSON.stringify(page.body).includes(privacy))
      for (const row of page.body.rows) assert.ok(!JSON.stringify(await detail(row)).includes(privacy))
      cursor = page.body.nextCursor
    } while (cursor)
    const viaMcp = await mcp('list_runtime_logs', { source: 'import', limit: 100 })
    assert.equal(viaMcp.error, false); assert.ok(viaMcp.body.rows.length); assert.ok(!JSON.stringify(viaMcp.body).includes(privacy))
    assert.ok(!readFileSync(join(logDir, 'events.db')).includes(Buffer.from(privacy)))
  })
  await stop()
  await start(true)
  await checked('logging storage failure preserves actual HTTP and MCP commit conflict replay and durable receipt parity', async () => {
    for (const lane of ['http', 'mcp']) {
      const body = input('log-fault-' + lane, 300)
      const commit = lane === 'http' ? await post('commit', body) : await mcp('save_roster_batch', body)
      assert.equal(commit.body.status, 'committed'); assert.equal(commit.body.summary.written, 301)
      const retry = lane === 'http' ? await post('commit', body) : await mcp('save_roster_batch', body)
      assert.deepEqual(retry.body, commit.body)
      const conflict = lane === 'http' ? await post('commit', { ...body, sourceIdentity: 'different' }) : await mcp('save_roster_batch', { ...body, sourceIdentity: 'different' })
      assert.equal(conflict.body.error.code, 'idempotency_conflict')
      assert.equal((await history(body)).body.total, 1)
      assert.equal((await receipt(body)).body.summary.written, 301)
      const invalid = input('log-fault-invalid-' + lane); invalid.payload.exportSnapshot.titleCode = 'invalid-title'
      const failed = lane === 'http' ? await post('commit', invalid) : await mcp('save_roster_batch', invalid)
      assert.equal(failed.body.status, 'failed'); assert.equal(failed.body.summary.written, 0)
      assert.equal((await receipt(invalid)).body.status, 'failed')
    }
    await delay(250)
    const unavailable = await http('GET', '/api/logs/policy')
    assert.equal(unavailable.status, 503); assert.equal(unavailable.body.status.unavailable, true)
  })
  await stop()
  await checked('all captured stdout and stderr fallback omit original key source path and raw text', async () => {
    assert.ok(!allOutput.join('').includes(privacy))
    const workerOutput = readFileSync(join(root, 'worker-output.log'), 'utf8')
    assert.ok(!workerOutput.includes(privacy)); assert.ok(workerOutput.includes('import.commit'))
    assert.ok(allOutput.join('').includes('logging.drain'))
  })
  report.lanes.actualNuxt = 'pass'
} catch (error) {
  report.lanes.actualNuxt = 'fail'
  report.failure = String(error.stack || error).replaceAll(privacy, '[privacy-marker]')
  console.error(report.failure)
  process.exitCode = 1
} finally {
  await stop()
  writeFileSync(join(root, 'stdout-stderr.log'), allOutput.join(''))
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n')
  console.log('Evidence: ' + reportPath)
}
