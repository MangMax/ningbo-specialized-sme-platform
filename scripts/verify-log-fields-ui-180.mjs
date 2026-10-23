#!/usr/bin/env node
/**
 * F03 owned verification fixture: synthetic business DB + seeded log SQLite +
 * real Nuxt dev server on a private loopback port. Never touches 50055, the
 * parent manual fixture, real business snapshots or production.
 *
 * Checks below go through the real protected REST handlers and the real
 * worker/SQLite persistence, then read back with GET. Network writes are counted
 * so "cancel sends nothing" can be asserted from the wire, not just the DOM.
 *
 * usage: node scripts/verify-log-fields-ui-180.mjs <worktree> <evidence-dir>
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { reserveLoopbackPort, stopOwnedChild, waitForHttp } from './lib/isolated-local-services.mjs'

const worktree = resolve(process.argv[2] ?? '.')
const evidence = process.argv[3]
if (!evidence) throw new Error('usage: f03-ui-verify.mjs <worktree> <evidence-dir>')
const root = mkdtempSync(join(tmpdir(), 'f03-field-verify-'))
const business = join(root, 'synthetic-business.db'), logDir = join(root, 'logs')
const files = join(root, 'files'), incoming = join(root, 'incoming')
const apiToken = 'f03-owned-token', uploadPayload = Buffer.from('F03_OWNED_TUS_PAYLOAD\n')
mkdirSync(evidence, { recursive: true })

// --- synthetic business schema only: no real data is read or copied. ---
const businessDb = new Database(business)
migrate(drizzle(businessDb), { migrationsFolder: join(worktree, 'db/migrations') })
businessDb.close()

// --- independent log DB seeded just past 1MiB/3 so a real capacity 409 exists later ---
mkdirSync(logDir, { recursive: true, mode: 0o700 })
const logDb = new Database(join(logDir, 'events.db'))
logDb.pragma('auto_vacuum = FULL')
logDb.pragma('application_id = 1163283527')
logDb.pragma('journal_mode = DELETE')
logDb.pragma('synchronous = FULL')
logDb.exec('CREATE TABLE log_policy (id INTEGER PRIMARY KEY CHECK(id=1), retentionDays INTEGER NOT NULL, maxBytes INTEGER NOT NULL, pruned INTEGER NOT NULL DEFAULT 0, cleared INTEGER NOT NULL DEFAULT 0)')
logDb.prepare('INSERT INTO log_policy(id,retentionDays,maxBytes) VALUES(1,?,?)').run(7, 536870912)
logDb.exec('CREATE TABLE log_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, timestamp TEXT NOT NULL, level TEXT NOT NULL, source TEXT NOT NULL, operation TEXT NOT NULL, outcome TEXT NOT NULL, requestId TEXT, traceId TEXT, taskId TEXT, fileId INTEGER, batchId TEXT, resourceId TEXT, summary TEXT NOT NULL, detail TEXT NOT NULL)')
for (const key of ['timestamp', 'level', 'source', 'operation', 'outcome', 'requestId', 'traceId', 'taskId', 'fileId', 'batchId', 'resourceId'])
  logDb.exec('CREATE INDEX IF NOT EXISTS log_' + key + ' ON log_events(' + key + ',seq)')
const insert = logDb.prepare('INSERT INTO log_events(id,timestamp,level,source,operation,outcome,summary,detail) VALUES(@id,@timestamp,@level,@source,@operation,@outcome,@summary,@detail)')
// The real 409 fires when bytes > maxBytes/3 still hold after maintenance's
// bounded 32 x 1000-row delete loop, so the seed must exceed 32000 rows and
// keep enough bytes after it: 34000 rows x ~700B leaves ~1.4MB > 349KB for a
// 1MiB probe. Row size is deliberately small so the fixture stays cheap.
const padding = 'x'.repeat(520)
logDb.transaction(() => {
  for (let i = 0; i < 34000; i++) {
    const event = {
      id: '01900000-0000-4000-8000-' + String(i).padStart(12, '0'),
      timestamp: new Date(Date.now() - 60000 - i * 1000).toISOString(),
      level: 'info', source: 'system', operation: 'logging.clear', outcome: 'success',
      synthetic: true, note: padding
    }
    insert.run({ id: event.id, timestamp: event.timestamp, level: event.level, source: event.source,
      operation: event.operation, outcome: event.outcome,
      summary: JSON.stringify(event), detail: JSON.stringify(event) })
  }
})()
logDb.close()
const seededBytes = readFileSync(join(logDir, 'events.db')).length

// --- private dev server on an owned port ---
const port = await reserveLoopbackPort()
assert.notEqual(port, 50055)
const base = 'http://127.0.0.1:' + port
const child = spawn(process.execPath, [join(worktree, 'node_modules/nuxt/bin/nuxt.mjs'), 'dev', '--host', '127.0.0.1', '--port', String(port)], {
  cwd: worktree, stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env, NODE_ENV: 'development', HOST: '127.0.0.1', PORT: String(port),
    NUXT_BUILD_DIR: join(worktree, '.nuxt'),
    NUXT_DB_PATH: business, NUXT_DB_READONLY: '1', NUXT_LOG_DIR: logDir,
    NUXT_FILES_DIR: files, NUXT_INCOMING_DIR: incoming,
    NUXT_CURATED_PATH: join(root, 'curated.json'), NUXT_RECONCILE_PATH: join(root, 'reconcile.json'),
    NUXT_API_TOKEN: apiToken, NUXT_MCP_TOKEN: 'f03-owned-mcp',
    NUXT_BROWSER_LOGS_ENABLED: 'true', NUXT_OCR_TOKEN: '', NUXT_PLATFORM_COOKIE: ''
  }
})
let output = ''
child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
child.stdout.on('data', (chunk) => (output += chunk))
child.stderr.on('data', (chunk) => (output += chunk))

const browserGet = { 'x-log-browser': '1', 'sec-fetch-site': 'same-origin', referer: base + '/logs' }
const browserWrite = { ...browserGet, origin: base, 'content-type': 'application/json' }
const writes = []
async function call(path, init = {}) {
  const response = await fetch(base + path, { ...init, signal: AbortSignal.timeout(20000) })
  const text = await response.text()
  let body
  try { body = JSON.parse(text) } catch { body = text }
  if (init.method && init.method !== 'GET') writes.push({ path: path.split('?')[0], method: init.method, status: response.status })
  return { status: response.status, body, headers: response.headers, requestId: response.headers.get('x-request-id') }
}
/**
 * Drain is asynchronous (batch flush + worker), so poll the real protected list
 * until the event for that server-generated requestId appears. No fixed sleeps
 * decide correctness; the timeout only bounds a genuine failure.
 */
async function waitForRow(requestId, predicate, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    const listed = await call('/api/logs?' + new URLSearchParams({ requestId, limit: '10' }), { headers: browserGet })
    if (listed.status === 200) {
      const row = listed.body.rows.find(predicate)
      if (row) return row
      last = listed.body.rows
    }
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  throw new Error('no matching log row for requestId ' + requestId + ': ' + JSON.stringify(last))
}
const readPolicy = () => call('/api/logs/policy', { headers: browserGet })
const patchPolicy = (body) => call('/api/logs/policy', { method: 'PATCH', headers: browserWrite, body: JSON.stringify(body) })
const results = []
const check = (name, fn) => {
  try { fn(); results.push({ name, result: 'PASS' }) }
  catch (error) { results.push({ name, result: 'FAIL', error: String(error?.message ?? error) }); throw error }
}
function persistReceipt(closeout) {
  mkdirSync(evidence, { recursive: true })
  writeFileSync(join(evidence, 'f03-verify-results.json'), JSON.stringify({ root, base, port, pid: child.pid, results, writes, closeout }, null, 2))
  writeFileSync(join(evidence, 'f03-verify-server.log'), output)
}
let stopping = false
async function stop(code = 0) {
  if (stopping) return
  stopping = true
  await stopOwnedChild(child)
  persistReceipt({ seededBytes, writes, childExit: { code: child.exitCode, signal: child.signalCode }, payloadLeakInStdout: output.includes(uploadPayload.toString().trim()) })
  rmSync(root, { recursive: true, force: true })
  writeFileSync(join(evidence, 'f03-verify-closeout.json'), JSON.stringify({
    root, port, pid: child.pid, removedRoot: !existsSync(root),
    childExit: { code: child.exitCode, signal: child.signalCode }, writes, seededBytes
  }, null, 2))
  process.exit(code)
}
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => void stop(0))

await waitForHttp(base + '/api/health', { child, timeoutMs: 300000 })
writeFileSync(join(evidence, 'f03-verify-manifest.json'), JSON.stringify({ root, base, port, pid: child.pid, seededBytes, businessDb: business, logDir, evidence }, null, 2))
try {
  // Accordion browser evidence needs the full, un-pruned capacity headroom for
  // a real UI 409. `F03_SKIP_CHECKS=1` only starts the same owned fixture and
  // leaves the API checks to the caller; normal runs are unchanged.
  if (process.env.F03_SKIP_CHECKS === '1') {
    persistReceipt({ ok: true, skippedChecks: true })
    console.log(JSON.stringify({ verdict: 'SERVER_ONLY', base, port, pid: child.pid }))
    await new Promise(() => {})
  }
  const initial = await readPolicy()
  assert.equal(initial.status, 200, 'GET policy ' + initial.status)
  const profiles = initial.body.catalog.profiles
  check('real GET publishes http and tus catalogs with complete all-true controls', () => {
    assert.deepEqual(profiles.map((p) => p.key), ['http', 'tus'])
    assert.deepEqual(profiles[0].fields.map((f) => f.key), ['httpMethod', 'httpRoute', 'statusCode', 'durationMs'])
    assert.deepEqual(profiles[1].fields.map((f) => f.key), ['tus.method', 'tus.uploadId', 'tus.size', 'tus.offset'])
    assert.deepEqual(profiles[1].levels, ['debug', 'info', 'warn', 'error'])
    for (const profile of profiles)
      for (const level of profile.levels)
        for (const field of profile.fields)
          assert.equal(initial.body.fieldControls[profile.key][level][field.key], true)
  })
  const revision0 = initial.body.revision

  const retentionOnly = await patchPolicy({ retentionDays: 7, maxBytes: 536870912 })
  assert.equal(retentionOnly.status, 200, 'retention PATCH ' + retentionOnly.status)
  check('a default save carries no fieldControls and preserves every leaf', () => {
    assert.equal(retentionOnly.body.revision, revision0 + 1)
    assert.deepEqual(retentionOnly.body.fieldControls, initial.body.fieldControls)
  })

  const partial = await patchPolicy({ retentionDays: 7, maxBytes: 536870912, fieldControls: { http: { info: { httpRoute: false } } } })
  assert.equal(partial.status, 200, 'partial PATCH ' + partial.status)
  const afterPartial = await readPolicy()
  check('one partial leaf persists on GET while sibling levels stay true', () => {
    assert.equal(afterPartial.body.fieldControls.http.info.httpRoute, false)
    assert.equal(afterPartial.body.fieldControls.http.info.httpMethod, true)
    assert.equal(afterPartial.body.fieldControls.http.warn.httpRoute, true)
    assert.equal(afterPartial.body.fieldControls.tus.info['tus.uploadId'], true)
    assert.equal(afterPartial.body.revision, partial.body.revision)
  })

  const tusPatch = await patchPolicy({
    retentionDays: 7, maxBytes: 536870912,
    fieldControls: { http: { info: { statusCode: false } }, tus: { info: { 'tus.uploadId': false } } }
  })
  assert.equal(tusPatch.status, 200, 'tus PATCH ' + tusPatch.status)
  const revisionAfterFields = tusPatch.body.revision

  const health = await call('/api/health')
  assert.equal(health.status, 200)
  const httpRow = await waitForRow(health.requestId, (row) => row.operation === 'http.request')
  const detailHttp = await call('/api/logs/' + httpRow.id, { headers: browserGet })
  assert.equal(detailHttp.status, 200)

  // batch must be digits per the real landing rule; a wrong value is a 400.
  const metadata = Object.entries({ source: 'jxj', kind: 'announcement', year: '2026', batch: '4', filename: 'f03.txt' })
    .map((pair) => pair[0] + ' ' + Buffer.from(pair[1]).toString('base64')).join(',')
  const created = await call('/api/uploads', { method: 'POST', headers: { 'Tus-Resumable': '1.0.0', 'Upload-Length': String(uploadPayload.length), 'Upload-Metadata': metadata } })
  assert.equal(created.status, 201, 'TUS create ' + created.status)
  const uploadId = created.headers.get('location').split('/').pop()
  const completed = await call('/api/uploads/' + uploadId, { method: 'PATCH', headers: { 'Tus-Resumable': '1.0.0', 'Upload-Offset': '0', 'content-type': 'application/offset+octet-stream' }, body: uploadPayload })
  assert.equal(completed.status, 204, 'TUS patch ' + completed.status)
  const tusRow = await waitForRow(completed.requestId, (row) => row.tus?.phase === 'completed')
  const detailTus = await call('/api/logs/' + tusRow.id, { headers: browserGet })
  assert.equal(detailTus.status, 200)

  const tooSmall = await patchPolicy({ retentionDays: 6, maxBytes: 1048576, fieldControls: { http: { warn: { durationMs: false } } } })
  const after409 = await readPolicy()
  const refresh = await readPolicy()

  check('real HTTP capture names the disabled fields and drops their values', () => {
    assert.equal(detailHttp.body.fieldCapture.profile, 'http')
    assert.equal(detailHttp.body.fieldCapture.revision, revisionAfterFields)
    assert.deepEqual([...detailHttp.body.fieldCapture.disabled].sort(), ['httpRoute', 'statusCode'])
    assert.equal(detailHttp.body.httpMethod, 'GET')
    assert.equal(detailHttp.body.httpRoute, undefined)
    assert.equal(detailHttp.body.statusCode, undefined)
    assert.equal(detailHttp.body.outcome, 'success')
    assert.match(detailHttp.body.id, /^[0-9a-f-]{36}$/)
    assert.ok(detailHttp.body.timestamp)
  })
  check('real TUS capture keeps phase/id-free context and the original event id/time', () => {
    assert.deepEqual(detailTus.body.fieldCapture, { profile: 'tus', revision: revisionAfterFields, disabled: ['tus.uploadId'] })
    assert.equal(detailTus.body.tus.phase, 'completed')
    assert.equal(detailTus.body.tus.method, 'PATCH')
    assert.equal(detailTus.body.tus.size, uploadPayload.length)
    assert.equal(detailTus.body.tus.offset, uploadPayload.length)
    assert.equal(detailTus.body.tus.uploadId, undefined)
    assert.equal(detailTus.body.source, 'file')
    assert.match(detailTus.body.id, /^[0-9a-f-]{36}$/)
    assert.ok(!JSON.stringify(detailTus.body).includes(uploadId))
  })
  check('real capacity shrink returns 409 and leaves the committed policy untouched', () => {
    assert.equal(tooSmall.status, 409)
    assert.equal(tooSmall.body.error.code, 'policy_capacity_pending')
    assert.equal(after409.body.revision, revisionAfterFields)
    assert.equal(after409.body.fieldControls.http.warn.durationMs, true)
    assert.equal(after409.body.fieldControls.http.info.httpRoute, false)
    assert.equal(after409.body.fieldControls.http.info.statusCode, false)
    assert.equal(after409.body.fieldControls.tus.info['tus.uploadId'], false)
  })
  check('fresh readback keeps exactly the saved leaves and revision', () => {
    assert.deepEqual(refresh.body.fieldControls, after409.body.fieldControls)
    assert.equal(refresh.body.revision, revisionAfterFields)
  })
  check('reads never appear as writes on the wire', () => {
    assert.deepEqual(writes.map((w) => w.method), ['PATCH', 'PATCH', 'PATCH', 'POST', 'PATCH', 'PATCH'])
  })
  persistReceipt({ ok: true, seededBytes, writes, revision0, revisionAfterFields })
  console.log(JSON.stringify({ verdict: 'PASS', base, port, pid: child.pid, results, writes }, null, 2))
  await new Promise(() => {})
} catch (error) {
  persistReceipt({ ok: false, seededBytes, writes, error: String(error?.stack ?? error) })
  console.error('FIXTURE FAILURE', error)
  await stop(1)
}