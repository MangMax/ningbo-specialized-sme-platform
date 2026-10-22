#!/usr/bin/env node
/** #185: actual built Nuxt -> controlled HTTP socket -> real evlog drain -> protected REST. */
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { reserveLoopbackPort, stopOwnedChild } from './lib/isolated-local-services.mjs'

const root = mkdtempSync(join(tmpdir(), 'platform185-nuxt-'))
const dbPath = join(root, 'synthetic.db'), logs = join(root, 'logs')
const db = new Database(dbPath); migrate(drizzle(db), { migrationsFolder: resolve('db/migrations') }); db.close()
const cookie = 'session=PRIVATE185_COOKIE', marker = 'PRIVATE185_CONTENT'
const checks = [], readbacks = [], scopes = [], healthyResults = new Map()
let mode = 'success', failSecond = true, child, base, output = ''
const delay = ms => new Promise(r => setTimeout(r, ms))
function check(name, fn) { fn(); checks.push({ name, result: 'PASS' }) }
const upstream = createServer(async (req, res) => {
  let body = ''; for await (const chunk of req) body += chunk
  assert.equal(req.headers.cookie, cookie)
  const form = new URLSearchParams(body), page = Number(form.get('pageNum')), title = form.get('rdjb')
  const source = req.url.endsWith('/queryList') ? 'queryList' : req.url.endsWith('/businessList') ? 'businessList' : 'queryBusList'
  scopes.push({ source, page, title })
  let code = mode === 'auth' ? 401 : mode === 'rate' ? 429 : mode === 'failure' || (mode === 'partial' && page === 2 && failSecond) ? 503 : 200
  if (mode === 'timeout') await delay(250)
  const total = mode === 'zero' ? 0 : source === 'businessList' ? 1 : 2
  const grid = source === 'queryList' ? 'applyGrid' : source === 'businessList' ? 'businessListGrid' : 'businessGrid'
  const text = mode === 'session' ? '{"statusCode":"301","message":"登录超时 PRIVATE185_CONTENT"}' : code !== 200 ? marker : JSON.stringify({
    account: { token: marker }, zrarData: { grid: { [grid]: { page, pageSize: Number(form.get('numPerPage')), maxPage: Math.max(1, total), maxCount: total,
      pageSet: total ? [{ qymc: marker, tyshxydm: '91330211255994457P', relation: `${title ?? 'apply'}-${page}` }] : [] } } },
  })
  res.writeHead(code, { 'content-type': 'application/json' }); res.end(text)
})
upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening')
const upstreamBase = `http://127.0.0.1:${upstream.address().port}`
const env = {
  ...process.env, HOST: '127.0.0.1', NODE_ENV: 'production', NUXT_DB_PATH: dbPath, NUXT_DB_READONLY: '0',
  NUXT_FILES_DIR: join(root, 'files'), NUXT_INCOMING_DIR: join(root, 'incoming'), NUXT_LOG_DIR: logs,
  NUXT_CURATED_PATH: join(root, 'curated.json'), NUXT_RECONCILE_PATH: join(root, 'reconcile.json'),
  NUXT_API_TOKEN: 'fixture-api185', NUXT_MCP_TOKEN: 'fixture-mcp185', NUXT_BROWSER_LOGS_ENABLED: 'false',
  NUXT_OCR_TOKEN: '', PADDLEOCR_MCP_AISTUDIO_ACCESS_TOKEN: '', MIIT_COOKIE: cookie, MIIT_COOKIE_FILE: '',
  PLATFORM185_UPSTREAM: upstreamBase, NODE_OPTIONS: '',
}
const headers = { authorization: 'Bearer fixture-api185' }
async function start(extra = {}) {
  const port = await reserveLoopbackPort(); base = `http://127.0.0.1:${port}`
  child = spawn(process.execPath, ['--import', resolve('scripts/lib/platform-logging-185-preload.mjs'), '.output/server/index.mjs'], {
    env: { ...env, ...extra, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', chunk => { output += chunk }); child.stderr.on('data', chunk => { output += chunk })
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null || child.signalCode) throw Error('Owned Nuxt process exited')
    try { if ((await fetch(base + '/api/health', { signal: AbortSignal.timeout(1000) })).ok) return } catch {}
    await delay(100)
  }
  throw Error('Nuxt readiness timed out')
}
async function request(path, body, authorized = false) {
  const response = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(authorized ? headers : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10000) })
  const text = await response.text(); let data; try { data = JSON.parse(text) } catch { data = text }
  return { status: response.status, body: data, requestId: response.headers.get('x-request-id') }
}
async function logsFor(filter, predicate) {
  for (let i = 0; i < 80; i++) {
    const listed = await request('/api/logs?' + new URLSearchParams({ source: 'platform', limit: '100', ...filter }), undefined, true)
    if (listed.status === 200) {
      const details = await Promise.all(listed.body.rows.map(row => request('/api/logs/' + row.id, undefined, true)))
      assert.ok(details.every(detail => detail.status === 200))
      const rows = details.map(detail => detail.body)
      if (predicate(rows)) { readbacks.push(listed.body, ...rows); return rows }
    }
    await delay(100)
  }
  throw Error('Semantic platform event persistence timed out: ' + JSON.stringify(filter))
}
const query = { source: 'queryList', name: marker, pageSize: 1 }
const stableResult = ({ queriedAt, completedAt, ...result }) => result
const checkpointTruth = ({ status, completeness, rows, pages, error, unfinished }) => ({ status, completeness, rows, pages, error, unfinished })
async function mcp(name, args, token) {
  const response = await fetch(base + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }), signal: AbortSignal.timeout(10000) })
  const text = await response.text(), line = text.split('\n').find(line => line.startsWith('data:'))
  const rpc = JSON.parse(line ? line.slice(5) : text)
  const result = rpc.result
  return { status: response.status, requestId: response.headers.get('x-request-id'), body: result ? result.structuredContent ?? JSON.parse(result.content[0].text) : rpc }
}
async function terminal(batchId) {
  for (let i = 0; i < 100; i++) {
    const result = await request('/api/platform/batches/' + batchId)
    if (!['queued', 'running'].includes(result.body.state)) return result.body
    await delay(50)
  }
  throw Error('Batch did not terminate')
}
function businessTables() {
  const db = new Database(dbPath, { readonly: true })
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name != 'job' AND name NOT LIKE 'sqlite_%'").all()
    return Object.fromEntries(tables.map(({ name }) => [name, db.prepare('SELECT count(*) AS n FROM \"' + name.replaceAll('\"', '\"\"') + '\"').get().n]))
  } finally { db.close() }
}
try {
  await start()
  const publicLogs = await request('/api/logs')
  check('protected logs reject public access', () => assert.equal(publicLogs.status, 401))
  const before = businessTables()
  for (const [scenario, business, outcome, errorCode] of [
    ['success', 'success', 'success'], ['zero', 'no_record', 'no_record'], ['auth', 'auth_failed', 'denied', 'auth_failed'],
    ['session', 'auth_failed', 'denied', 'auth_failed'], ['rate', 'failed', 'failure', 'rate_limited'], ['failure', 'failed', 'failure', 'upstream_failed'],
    ['partial', 'partial', 'partial', 'upstream_failed'], ['timeout', 'failed', 'timeout', 'timeout'],
  ]) {
    mode = scenario
    const actual = await request('/api/platform/query', { ...query, ...(scenario === 'timeout' ? { maxDurationMs: 50 } : {}) })
    healthyResults.set(scenario, actual.body)
    const logged = await logsFor({ requestId: actual.requestId }, rows => rows.some(row => row.operation === 'platform.query_list.query'))
    check('actual Nuxt controlled HTTP ' + scenario + ' preserves business and semantic outcome', () => {
      assert.equal(actual.status, 200); assert.equal(actual.body.status, business)
      const completion = logged.filter(row => row.operation === 'platform.query_list.query'); assert.equal(completion.length, 1)
      assert.equal(completion[0].outcome, outcome); assert.equal(completion[0].errorCode, errorCode)
      assert.deepEqual(logged.filter(row => row.operation === 'platform.query_list.page').map(row => row.page).sort(), scenario === 'success' || scenario === 'partial' ? [1, 2] : [1])
      if (scenario === 'partial') { assert.equal(actual.body.fetchedCount, 1); assert.deepEqual(actual.body.unfinished, [{ source: 'queryList', rdjb: null, page: 2 }]) }
      if (scenario === 'success') assert.deepEqual(actual.body.rows.map(row => row.relation), ['apply-1', 'apply-2'])
    })
  }
  mode = 'success'
  for (const [source, rdjb, expected] of [['businessList', 'all', ['1-1', '2-1', '3-1']], ['queryBusList', ['1', '3'], ['1-1', '1-2', '3-1', '3-2']]]) {
    const actual = await request('/api/platform/query', { source, uscc: '91330211255994457P', rdjb, pageSize: 1 })
    const prefix = source === 'businessList' ? 'platform.business_list' : 'platform.query_bus_list'
    const logged = await logsFor({ requestId: actual.requestId }, rows => rows.some(row => row.operation.startsWith(prefix + '.query')))
    check('actual ' + source + ' preserves multiple relations and title/page scope', () => {
      assert.equal(actual.body.status, 'success'); assert.deepEqual(actual.body.rows.map(row => row.relation), expected)
      assert.equal(logged.filter(row => row.operation.startsWith(prefix + '.page.title_')).length, expected.length)
    })
  }
  mode = 'zero'
  const rpc = await mcp('query_platform', query)
  const mcpRows = await logsFor({ requestId: rpc.requestId }, rows => rows.some(row => row.operation === 'platform.query_list.query'))
  check('actual MCP semantic query uses same server request context as transport', () => { assert.equal(rpc.status, 200); assert.equal(rpc.body.status, 'no_record'); assert.equal(mcpRows.length, 2) })
  const concurrent = await Promise.all(Array.from({ length: 3 }, () => mcp('query_platform', query)))
  const concurrentRows = await Promise.all(concurrent.map(rpc => logsFor({ requestId: rpc.requestId }, rows => rows.some(row => row.operation === 'platform.query_list.query'))))
  check('concurrent actual MCP queries keep per-request context isolated', () => { assert.equal(new Set(concurrent.map(rpc => rpc.requestId)).size, 3); assert.ok(concurrentRows.every((rows, index) => rows.length === 2 && rows.every(row => row.requestId === concurrent[index].requestId))) })
  const deniedMcp = await mcp('submit_platform_batch', { items: [{ query }] })
  const deniedRest = await request('/api/platform/batches', { items: [{ query }] })
  check('REST and MCP batch authorization remain enforced', () => { assert.equal(deniedMcp.status, 401); assert.equal(deniedRest.status, 401) })
  mode = 'partial'; failSecond = true
  const submitted = await request('/api/platform/batches', { items: [{ query }, { query: { source: 'businessList', uscc: '91330211255994457P', rdjb: '1', pageSize: 1 } }] }, true)
  assert.equal(submitted.status, 202)
  const receipt = submitted.body, prior = await terminal(receipt.batchId)
  assert.equal(prior.items[0].status, 'partial'); assert.equal(prior.items[1].status, 'success')
  const firstRows = await logsFor({ batchId: receipt.batchId }, rows => rows.some(row => row.operation === 'platform.batch.collect'))
  failSecond = false; scopes.length = 0
  const retried = await request(`/api/platform/batches/${receipt.batchId}/retry`, { itemIds: [receipt.itemIds[0]] }, true)
  assert.equal(retried.status, 202)
  const after = await terminal(receipt.batchId)
  const finalRows = await logsFor({ batchId: receipt.batchId }, rows => rows.filter(row => row.operation === 'platform.batch.collect').length === 2)
  check('actual async batch retry preserves IDs/results and only requests outstanding page', () => {
    assert.equal(after.state, 'done'); assert.equal(after.attempt, 2); assert.equal(after.items[0].status, 'success')
    assert.deepEqual(after.items[0].segments[0], prior.items[0].segments[0]); assert.deepEqual(after.items[1], prior.items[1])
    assert.deepEqual(scopes, [{ source: 'queryList', page: 2, title: null }])
    assert.deepEqual(finalRows.filter(row => row.operation === 'platform.query_list.page' && row.outcome === 'success').map(row => row.page).sort(), [1, 2])
    assert.equal(firstRows.find(row => row.operation === 'platform.query_list.query').requestId, submitted.requestId)
    const resumed = finalRows.find(row => row.operation === 'platform.query_list.query' && row.outcome === 'success')
    assert.equal(resumed.requestId, retried.requestId); assert.equal(resumed.traceId, firstRows[0].traceId)
    assert.equal(resumed.resourceId, receipt.itemIds[0]); assert.equal(resumed.taskId, receipt.batchId)
    const retries = finalRows.filter(row => row.operation === 'platform.batch.retry')
    assert.equal(retries.length, 1); assert.equal(retries[0].requestId, retried.requestId); assert.deepEqual(retries[0].counts, { total: 1 })
  })
  mode = 'zero'
  const rpcBatch = await mcp('submit_platform_batch', { items: [{ query }] }, 'fixture-mcp185')
  await terminal(rpcBatch.body.batchId)
  const rpcBatchRows = await logsFor({ batchId: rpcBatch.body.batchId }, rows => rows.some(row => row.operation === 'platform.batch.collect'))
  check('actual MCP batch context survives response and background collection', () => { assert.equal(rpcBatch.status, 200); assert.ok(rpcBatchRows.every(row => row.requestId === rpcBatch.requestId)) })
  check('collection never writes business facts or audit rows', () => assert.deepEqual(businessTables(), before))
  await stopOwnedChild(child)
  await start({ MIIT_COOKIE: '', PLATFORM185_UPSTREAM: upstreamBase })
  const missing = await request('/api/platform/query', query)
  const missingRows = await logsFor({ requestId: missing.requestId }, rows => rows.some(row => row.operation === 'platform.query_list.query'))
  check('actual missing session stays not_queried', () => { assert.equal(missing.body.status, 'not_queried'); assert.equal(missingRows.length, 1); assert.equal(missingRows[0].outcome, 'skipped'); assert.equal(missingRows[0].errorCode, 'credential_unavailable') })
  await stopOwnedChild(child)
  mode = 'success'
  await start({ NUXT_LOG_DIR: '/dev/null/PRIVATE185_PATH' })
  const faulty = await request('/api/platform/query', query)
  await delay(350)
  const unavailable = await request('/api/logs/policy', undefined, true)
  check('actual failed logging drain preserves platform result and exposes drops', () => { assert.deepEqual(stableResult(faulty.body), stableResult(healthyResults.get('success'))); assert.equal(unavailable.status, 503); assert.equal(unavailable.body.status.unavailable, true); assert.ok(unavailable.body.status.dropped > 0) })
  mode = 'partial'; failSecond = true
  const faultyPartial = await request('/api/platform/query', query)
  const faultyBatch = await request('/api/platform/batches', { items: [{ query }] }, true)
  const faultyTerminal = await terminal(faultyBatch.body.batchId)
  check('actual drain failure preserves partial rows and batch failure checkpoint', () => { assert.deepEqual(stableResult(faultyPartial.body), stableResult(healthyResults.get('partial'))); assert.deepEqual(faultyPartial.body.unfinished, [{ source: 'queryList', rdjb: null, page: 2 }]); assert.equal(faultyTerminal.state, 'failed'); assert.equal(faultyTerminal.items[0].status, 'partial'); assert.deepEqual(checkpointTruth(faultyTerminal.items[0].segments[0]), checkpointTruth(prior.items[0].segments[0])) })
  await stopOwnedChild(child)
  check('privacy markers absent from protected summaries/details and stdout/stderr fallback', () => {
    assert.ok(!JSON.stringify(readbacks).includes('PRIVATE185')); assert.ok(!JSON.stringify(readbacks).includes('91330211255994457P')); assert.ok(!output.includes('PRIVATE185'))
    for (const file of readdirSync(logs)) assert.ok(!readFileSync(join(logs, file)).includes(Buffer.from('PRIVATE185')))
  })
} catch (error) { console.error(error); process.exitCode = 1 }
finally {
  await stopOwnedChild(child); await new Promise(resolve => upstream.close(resolve))
  writeFileSync(join(root, 'server-output.log'), output)
  writeFileSync(join(root, 'results.json'), JSON.stringify({ sourceSha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), sourceTree: execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim(), dirty: !!execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim(), checks }, null, 2))
  console.log(JSON.stringify({ root, passed: checks.length, checks }, null, 2))
}
