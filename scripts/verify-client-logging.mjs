#!/usr/bin/env node
/** #189 actual built Nuxt public seam. All state is a new synthetic fixture. --serve retains only this owned process for browser acceptance. */
import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'node:net'
import { once } from 'node:events'
import { request as httpRequest } from 'node:http'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import Database from 'better-sqlite3'
const { createJiti } = createRequire(import.meta.resolve('nuxt/package.json'))('jiti')
const { createRuntimeSchema } = await createJiti(import.meta.url).import('../db/create-runtime.ts')
const root = mkdtempSync(join(tmpdir(), 'client189-public-'))
const dbPath = join(root, 'synthetic.db')
// Native empty fixture; historical expand migrations are not an application initializer.
const db = new Database(dbPath); db.pragma('foreign_keys = ON'); createRuntimeSchema(db); db.close()
const before = readFileSync(dbPath)
const results = [], marker = 'PRIVATE189_BODY_URL_TOKEN_TEXT'
let child, base, output = ''
const delay = ms => new Promise(r => setTimeout(r, ms))
const token = 'fixture-api189'
const api = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
const body = [{ event: { kind: 'interaction_failure', page: 'logs', level: 'error' } }]
const check = (name, fn) => { fn(); results.push({ name, result: 'PASS' }) }
async function start(extra = {}) {
  const socket = createServer(); socket.listen(0, '127.0.0.1'); await once(socket, 'listening')
  const port = socket.address().port; await new Promise(r => socket.close(r)); base = `http://127.0.0.1:${port}`
  child = spawn(process.execPath, ['.output/server/index.mjs'], { env: {
    ...process.env, NODE_ENV: 'production', HOST: '127.0.0.1', PORT: String(port),
    NUXT_DB_PATH: dbPath, NUXT_DB_READONLY: '1', NUXT_LOG_DIR: join(root, 'logs'),
    NUXT_FILES_DIR: join(root, 'files'), NUXT_INCOMING_DIR: join(root, 'incoming'),
    NUXT_CURATED_PATH: join(root, 'curated.json'), NUXT_RECONCILE_PATH: join(root, 'reconcile.json'),
    NUXT_API_TOKEN: token, NUXT_MCP_TOKEN: 'fixture-mcp189', NUXT_OCR_TOKEN: '', PADDLEOCR_MCP_AISTUDIO_ACCESS_TOKEN: '', MIIT_COOKIE: '',
    ...extra,
  }, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', b => { output += b }); child.stderr.on('data', b => { output += b })
  for (let i = 0; i < 600; i++) {
    if (child.exitCode !== null) throw Error('owned server exited')
    try { if ((await fetch(base + '/api/health', { signal: AbortSignal.timeout(2000) })).ok) return } catch {}
    await delay(100)
  }
  throw Error('readiness timeout')
}
async function stop() {
  if (!child || child.exitCode !== null || child.signalCode) return
  const ended = once(child, 'exit'), timer = setTimeout(() => child.kill('SIGKILL'), 5000)
  child.kill('SIGTERM'); try { await ended } finally { clearTimeout(timer) }
}
async function call(path, options = {}) {
  const response = await fetch(base + path, { signal: AbortSignal.timeout(10000), ...options })
  let body; try { body = await response.json() } catch { body = null }
  return { status: response.status, body, requestId: response.headers.get('x-request-id') }
}
const post = (value, headers = api) => call('/api/logs/client', { method: 'POST', headers, body: JSON.stringify(value) })
async function logs(query) {
  for (let i = 0; i < 50; i++) {
    const found = await call('/api/logs?' + query, { headers: api })
    if (found.status === 200 && found.body.rows.length) return found.body.rows
    await delay(100)
  }
  throw Error('persistence timeout: ' + query)
}
async function chunked(chunks, slow = false) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(base + '/api/logs/client', { method: 'POST', headers: api }, res => {
      res.resume(); res.on('end', () => { req.end(); resolve(res.statusCode) })
    })
    req.on('error', reject)
    for (const chunk of chunks) req.write(chunk)
    if (!slow) req.end()
  })
}
function save() {
  writeFileSync(join(root, 'server-output.log'), output)
  writeFileSync(join(root, 'results.json'), JSON.stringify({ sha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), results }, null, 2))
}
try {
  await start()
  const browserHeaders = () => ({ 'content-type': 'application/json', 'x-log-browser': '1', 'sec-fetch-site': 'same-origin', origin: base })
  const defaultAccepted = await post([{ event: { ...body[0].event, page: 'settings' } }], browserHeaders())
  check('default browser intake accepts same-origin requests', () => assert.equal(defaultAccepted.status, 202))
  assert.equal((await post(body, {})).status, 401)
  assert.equal((await post(body, { ...api, authorization: 'Bearer fixture-mcp189' })).status, 401)
  const malicious = [{ event: { ...body[0].event, source: 'worker', operation: 'import.commit', taskId: marker, requestId: marker,
    traceId: marker, resourceId: marker, fileId: 189, auditId: marker, receiptId: marker, parentEventId: marker,
    id: marker, timestamp: '2000-01-01T00:00:00Z', message: marker, stack: marker, body: marker, url: marker, token: marker,
  }, request: { path: marker }, headers: { authorization: marker } }]
  const accepted = await post(malicious)
  check('actual protected intake accepts only a classified client claim', () => { assert.equal(accepted.status, 202); assert.equal(accepted.body.accepted, 1) })
  const rows = await logs('source=client&requestId=' + accepted.requestId)
  const detail = await call('/api/logs/' + rows[0].id, { headers: api })
  check('actual evlog drain and protected detail use server identity with no claimed execution facts', () => {
    assert.equal(rows.length, 1); assert.equal(detail.body.source, 'client'); assert.equal(detail.body.operation, 'client.logs.interaction_failure')
    assert.equal(detail.body.requestId, accepted.requestId); assert.notEqual(detail.body.id, marker)
    assert.ok(!JSON.stringify(detail.body).includes(marker)); assert.ok(!('taskId' in detail.body)); assert.ok(!('fileId' in detail.body))
  })
  const duplicate = await post(body)
  check('actual duplicate suppression does not append a second event', () => { assert.equal(duplicate.status, 202); assert.equal(duplicate.body.accepted, 0); assert.equal(duplicate.body.duplicates, 1) })
  const invalid = await post([{ event: { ...body[0].event, level: 'fatal' } }])
  check('actual intake rejects unapproved log levels', () => assert.equal(invalid.status, 400))
  const batch = await post(Array(9).fill(body[0]))
  check('actual intake rejects batches above eight events', () => assert.equal(batch.status, 400))
  const oversized = await post([{ event: { ...body[0].event, message: marker.repeat(300) } }])
  check('actual content-length body budget rejects oversized malicious input', () => assert.equal(oversized.status, 413))
  const chunkedStatus = await chunked(['[', ' '.repeat(5000), ']'])
  check('actual chunked body budget rejects oversized input', () => assert.equal(chunkedStatus, 413))
  const slow = await chunked(['['], true)
  check('actual incomplete body expires under bounded read deadline', () => assert.equal(slow, 408))
  const compressed = await post(body, { ...api, 'content-encoding': 'gzip' })
  check('actual compressed bodies cannot bypass the byte budget', () => assert.equal(compressed.status, 415))
  let limited
  for (let i = 0; i < 31; i++) limited = await post(body, { ...api, 'x-forwarded-for': 'different-' + i })
  check('actual socket-based rate limit ignores forged forwarded peer headers', () => assert.equal(limited.status, 429))
  const health = await call('/api/health')
  check('over-limit intake leaves business health unchanged', () => { assert.equal(health.status, 200); assert.equal(health.body.recordCount, 0) })
  const rawTransport = await call('/api/_evlog/ingest', { method: 'POST', headers: api, body: JSON.stringify(body) })
  check('raw evlog transport remains disabled and does not accept events', () => { assert.notEqual(rawTransport.status, 202); assert.equal(rawTransport.body, null) })
  await stop(); await start()
  const browser = await post([{ event: { kind: 'interaction_failure', page: 'settings', level: 'warn' } }], browserHeaders())
  check('default browser access accepts correct provenance without exposing token', () => assert.equal(browser.status, 202))
  const foreign = await post(body, { ...browserHeaders(), origin: 'https://foreign.invalid' })
  check('actual browser capability rejects foreign origin', () => assert.equal(foreign.status, 401))
  const cross = await post(body, { ...browserHeaders(), 'sec-fetch-site': 'cross-site' })
  check('actual browser capability rejects cross-site fetch metadata', () => assert.equal(cross.status, 401))
  const direct = await call('/api/logs')
  check('actual stored logs remain protected', () => assert.equal(direct.status, 401))
  check('synthetic business database bytes remain unchanged', () => assert.deepEqual(readFileSync(dbPath), before))
  check('privacy marker absent from real drain stdout and stderr', () => assert.ok(!output.includes(marker)))
  await stop()
  const blocked = join(root, 'blocked-log-directory'); writeFileSync(blocked, 'synthetic fixture')
  await start({ NUXT_LOG_DIR: join(blocked, 'logs') })
  const faulty = await post([{ event: { kind: 'script_error', page: 'files', level: 'error' } }])
  await delay(500)
  const unavailable = await call('/api/logs/policy', { headers: api })
  const healthyDuringFault = await call('/api/health')
  check('actual client drain failure preserves intake and business result with protected drop accounting', () => {
    assert.equal(faulty.status, 202); assert.equal(healthyDuringFault.status, 200); assert.deepEqual(healthyDuringFault.body, health.body)
    assert.equal(unavailable.status, 503); assert.equal(unavailable.body.status.unavailable, true); assert.ok(unavailable.body.status.dropped > 0)
  })
  await stop(); await start() // Fresh budgets for independent desktop/mobile browser lane.
  const manifest = { root, base, pid: child.pid, dbPath, logDir: join(root, 'logs') }
  writeFileSync(join(root, 'manifest.json'), JSON.stringify(manifest, null, 2))
  if (process.env.CLIENT189_MANIFEST) writeFileSync(process.env.CLIENT189_MANIFEST, JSON.stringify(manifest, null, 2))
  console.log(JSON.stringify({ root, base, checks: results.length }, null, 2)); save()
  if (process.argv.includes('--serve')) {
    console.log('Owned browser fixture ready; terminate this script to close it.')
    await new Promise(resolve => { process.once('SIGTERM', resolve); process.once('SIGINT', resolve) })
  }
} catch (error) { console.error(error); process.exitCode = 1 }
finally { await stop(); save(); console.log('Evidence directory: ' + root) }
