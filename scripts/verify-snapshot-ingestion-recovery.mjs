#!/usr/bin/env node
// Built artifact, real HTTP/MCP, owned synthetic SQLite only; SIGKILL is never sent to a shared server.
import assert from 'node:assert/strict'

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { forkOwnedChild as fork, reserveLoopbackPort, stopOwnedChild } from './lib/isolated-local-services.mjs'

let dir, db, owned, base, rpcId = 0, primaryError
let allStopped = true
const cleanupErrors = []
const pending = new Set()
// One small synthetic fixture, at most three sequential launchers. No benchmark.
const deadline = Date.now() + 90_000
const receipt = (state, extra = {}) => console.log(JSON.stringify({ phase: 'recovery', state, ...extra }))
async function stop() {
  if (!owned) return
  const child = owned
  // Consume the handle once even if the public stop rejects.
  owned = undefined
  let confirmed = false
  try {
    await stopOwnedChild(child)
    confirmed = true
    receipt('stopped', { pid: child.pid, exit: child.exitCode, signal: child.signalCode })
  } catch (error) {
    const result = error?.stopResult
    confirmed = result?.brand === 'isolated-local-services.stop' && result.version === 1 && result.termination === 'confirmed'
    receipt('stop-error', { pid: child.pid, termination: confirmed ? 'confirmed' : 'unconfirmed', reason: result?.reason })
    throw error
  } finally {
    if (!confirmed) {
      allStopped = false
      child.stdout?.destroy(); child.stderr?.destroy()
      if (child.connected) child.disconnect()
      child.unref()
      cleanupErrors.push(new Error(`Owned termination unconfirmed; pid=${child.pid}; private root retained at ${dir}`))
    }
  }
}
async function request(path, options, consume, timeout = 20_000) {
  const controller = new AbortController()
  pending.add(controller)
  const timer = setTimeout(() => controller.abort(new Error('Request deadline exceeded')), Math.max(1, Math.min(timeout, deadline - Date.now())))
  let response
  try {
    response = await fetch(base + path, { ...options, signal: controller.signal })
    return await consume(response)
  } finally {
    controller.abort()
    clearTimeout(timer)
    pending.delete(controller)
    if (response?.body && !response.bodyUsed) try { await response.body.cancel() }
    catch (error) { cleanupErrors.push(new Error('Response cleanup failed', { cause: error })) }
  }
}
let interrupted
async function run() {
const { createJiti } = createRequire(import.meta.resolve('nuxt/package.json'))('jiti')
const { useDb } = await createJiti(import.meta.url).import('../db/client.ts')
dir = mkdtempSync(join(tmpdir(), 'snapshot-recovery-'))
const dbPath = join(dir, 'roster.db')
db = useDb({ dbPath })
db.$client.close()
db = undefined
const marker = join(dir, 'first-chunk-written'), hook = join(dir, 'kill-boundary.mjs')
const driver = createRequire(resolve('.output/server/index.mjs')).resolve('better-sqlite3')
// Fault injection observes the actual SQLite statement boundary. The native transaction is
// still open when the parent kills this owned process; no production implementation is mocked.
writeFileSync(hook, `import {createRequire} from 'node:module';import {writeFileSync} from 'node:fs';
const Database=createRequire(import.meta.url)(${JSON.stringify(driver)});const probe=new Database(':memory:');const proto=Object.getPrototypeOf(probe.prepare('select 1'));probe.close();let armed=true;
for(const method of ['all','run']){const original=proto[method];proto[method]=function(...args){const out=original.apply(this,args);if(armed&&this.source.startsWith('insert into "platform_export_row"')){armed=false;writeFileSync(${JSON.stringify(marker)},'transaction-open');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,60000)}return out}}`)
async function start(interrupt = false) {
  assert.equal(owned, undefined, 'old owned group must be settled before restart')
  const port = await reserveLoopbackPort()
  base = `http://127.0.0.1:${port}`
  owned = fork('.output/server/index.mjs', [], { execArgv: ['--max-old-space-size=2048', ...(interrupt ? ['--import', hook] : [])], env: {
    ...process.env,
    // The native import worker inherits this observer through NODE_OPTIONS.
    ...(interrupt ? { NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import ${JSON.stringify(hook)}` } : {}),
    HOST: '127.0.0.1', PORT: String(port), NUXT_DB_PATH: dbPath, NUXT_DB_READONLY: '0', NUXT_FILES_DIR: dir, NUXT_INCOMING_DIR: dir,
    NUXT_API_TOKEN: 'synthetic-only', NUXT_MCP_TOKEN: 'synthetic-only', MIIT_COOKIE: '', NUXT_OCR_TOKEN: '', PADDLEOCR_MCP_AISTUDIO_ACCESS_TOKEN: '',
  }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
  let childError, lastError
  owned.on('error', error => { childError = error })
  receipt('started', { pid: owned.pid, port })
  const readyDeadline = Math.min(deadline, Date.now() + 8_000)
  while (Date.now() < readyDeadline) {
    if (childError) throw childError
    assert.equal(owned.exitCode, null, 'owned server exited before readiness')
    assert.equal(owned.signalCode, null, 'owned server signaled before readiness')
    try {
      if (await request('/api/health', { headers: { connection: 'close' } }, async response => { await response.arrayBuffer(); return response.ok }, Math.min(1000, readyDeadline - Date.now()))) return
    } catch (error) { lastError = error }
    await sleep(50)
  }
  throw new Error('built artifact readiness deadline exceeded', { cause: lastError })
}
const input = {
  idempotencyKey: 'synthetic:crash-recovery', sourceKind: 'platform_export', sourceIdentity: 'synthetic.xlsx',
  payload: { exportSnapshot: { titleCode: 'specialized_sme', year: 2026, collectedOn: '2026-10-19', originalFilename: 'synthetic.xlsx', sha256: 'synthetic-recovery',
    rows: Array.from({ length: 300 }, (_, i) => ({ sourceRowNo: i + 3, rawFields: { original: `  原文🙂\n${i}  ` } })),
  } },
}
async function post(action, payload = input) {
  return request(`/api/roster/import/${action}`, { method: 'POST', headers: { connection: 'close', authorization: 'Bearer synthetic-only', 'content-type': 'application/json' }, body: JSON.stringify(payload) }, async response => {
  assert.equal(response.status, 200)
  return response.json()
  })
}
async function rpc(name, args) {
  return request('/mcp', { method: 'POST', headers: { connection: 'close', authorization: 'Bearer synthetic-only', 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } }) }, async response => {
  assert.equal(response.status, 200)
  const text = await response.text(), body = JSON.parse(text.split('\n').find(line => line.startsWith('data: '))?.slice(6) ?? text)
  assert.ok(!body.error && !body.result.isError, 'MCP call must succeed')
  return JSON.parse(body.result.content[0].text)
  })
}
  await start(true)
  const preflight = await post('preflight')
  assert.equal(preflight.preflight.add, 1)
  let interruptedError
  interrupted = post('commit').catch(error => {
    if (error instanceof TypeError && ['UND_ERR_SOCKET', 'ECONNRESET'].includes(error.cause?.code)) return null
    interruptedError = error
    throw error
  })
  void interrupted.catch(error => { interruptedError ??= error })
  for (let i = 0; i < 200 && !existsSync(marker); i++) {
    if (interruptedError) throw interruptedError
    await sleep(25)
  }
  if (interruptedError) throw interruptedError
  assert.ok(existsSync(marker), 'first real insert chunk reached the open transaction')
  await new Promise((resolveExit, rejectExit) => {
    const child = owned
    const finish = error => { clearTimeout(timer); child.off('exit', onExit); error ? rejectExit(error) : resolveExit() }
    const onExit = () => finish()
    const timer = setTimeout(() => finish(new Error('SIGKILL exit deadline exceeded')), 3_000)
    child.once('exit', onExit)
    try { assert.ok(child.kill('SIGKILL'), 'owned SIGKILL sent') } catch (error) { finish(error) }
  })
  assert.equal(owned.signalCode, 'SIGKILL')
  assert.equal(await interrupted, null, 'interrupted HTTP response must not become a success receipt')
  await stop()
  await start()
  assert.equal(await status('/api/roster/correspondences/export-rows/1'), 404, 'no first-chunk business row survived recovery')
  const recovered = await rpc('preflight_roster_batch', input)
  assert.equal(recovered.batchId, preflight.batchId)
  assert.equal(recovered.preflight.add, 1)
  const committed = await rpc('save_roster_batch', input)
  assert.equal(committed.batchId, preflight.batchId)
  assert.equal(committed.status, 'committed')
  assert.equal(committed.summary.written, 301)
  const ids = committed.items[0].detail.rows
  assert.equal(ids.length, 300)
  for (const index of [0, 199, 200, 299]) {
    const { source } = await rpc('get_record_correspondence_source', { kind: 'export_row', id: ids[index] })
    assert.equal(source.sourceRowNo, index + 3)
    assert.deepEqual(source.rawFields, input.payload.exportSnapshot.rows[index].rawFields)
  }
  assert.deepEqual(await post('commit'), committed)
  await stop()
  await start()
  assert.deepEqual(await post('commit'), committed, 'restart after success keeps the original idempotency receipt')
  const large = structuredClone(input)
  large.idempotencyKey = 'synthetic:mcp-size-fallback'
  large.payload.exportSnapshot.sha256 = 'synthetic-large'
  large.payload.exportSnapshot.rows.forEach((row, index) => { row.rawFields = { original: 'x'.repeat(index === 150 ? 1_200_000 : 14_753) } })
  await request('/mcp', { method: 'POST', headers: { connection: 'close', authorization: 'Bearer synthetic-only', 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name: 'preflight_roster_batch', arguments: large } }) }, async rejected => {
  assert.equal(rejected.status, 413, 'existing SDK request capacity remains explicit')
  await rejected.text()
  })
  assert.equal(await status('/api/roster/correspondences/export-rows/301'), 404)
  const largePreflight = await post('preflight', large)
  assert.equal(largePreflight.preflight.add, 1)
  const delivered = await post('commit', large)
  assert.equal(delivered.status, 'committed')
  assert.equal(delivered.summary.written, 301, '413 does not consume the same key as a committed receipt')
  const { source } = await rpc('get_record_correspondence_source', { kind: 'export_row', id: delivered.items[0].detail.rows[150] })
  assert.deepEqual(source.rawFields, large.payload.exportSnapshot.rows[150].rawFields)
  assert.deepEqual(await post('commit', large), delivered)
}
async function status(path) {
  return request(path, { headers: { connection: 'close' } }, async response => { await response.arrayBuffer(); return response.status })
}
try { await run() } catch (error) { primaryError = error }
finally {
  for (const controller of pending) controller.abort(new Error('Verifier cleanup cancelled request'))
  if (interrupted) await Promise.allSettled([interrupted])
  if (db) try { if (db.$client.open) db.$client.close() }
  catch (error) { allStopped = false; cleanupErrors.push(new Error('Database cleanup failed; private root retained', { cause: error })) }
  try { await stop() } catch (error) { cleanupErrors.push(new Error('Child cleanup failed', { cause: error })) }
  if (dir && allStopped) try { rmSync(dir, { recursive: true, force: true }) }
  catch (error) { cleanupErrors.push(new Error(`Private root cleanup failed; retained at ${dir}`, { cause: error })) }
  receipt('finished', { primary: Boolean(primaryError), cleanupErrors: cleanupErrors.length, rootRetained: Boolean(dir && existsSync(dir)) })
}
if (primaryError || cleanupErrors.length) {
  const failure = new AggregateError([...(primaryError ? [primaryError] : []), ...cleanupErrors], 'Recovery verifier failed (primary first, cleanup retained)')
  // Default exception inspection truncates nested cleanup causes.
  const describe = error => ({ name: error.name, message: error.message, code: error.code,
    ...(error.errors ? { errors: error.errors.map(describe) } : {}),
    ...(error.cause ? { cause: describe(error.cause) } : {}),
  })
  console.error(JSON.stringify({ failed: true, diagnostic: describe(failure) }))
  throw failure
}
console.log(JSON.stringify({ passed: true, lane: 'built Nitro HTTP + real MCP; private synthetic SQLite', checks: ['SIGKILL inside transaction after first chunk', 'no partial business rows after restart', 'same-key preflight/commit recovery across HTTP and MCP', 'exact raw/source order at chunk boundary', 'original receipt survives second restart', 'MCP 413 followed by same-key complete HTTP delivery and original receipt replay', 'oversize single item exact MCP readback'], productionChanged: false }))
