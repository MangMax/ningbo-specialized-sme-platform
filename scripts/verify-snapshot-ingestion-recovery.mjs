#!/usr/bin/env node
// Built artifact, real HTTP/MCP, owned synthetic SQLite only; SIGKILL is never sent to a shared server.
import assert from 'node:assert/strict'

import { existsSync, mkdtempSync, rmSync, realpathSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve, relative, isAbsolute } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { forkOwnedChild as fork, reserveLoopbackPort, stopOwnedChild, getOwnedChildStartFailure } from './lib/isolated-local-services.mjs'

let dir, db, owned, base, childError, rpcId = 0, primaryError
let oracle
let attempted = false, stopAttempted = false
let allStopped = true
const cleanupErrors = []
const pending = new Set()
// One small synthetic fixture, at most four sequential launchers. No benchmark.
const deadline = Date.now() + 90_000
const receipt = (state, extra = {}) => console.log(JSON.stringify({ phase: 'recovery', state, ...extra }))
const cleanupReceipt = (...args) => { try { receipt(...args) } catch (error) { cleanupErrors.push(new Error('Cleanup receipt failed', { cause: error })) } }
async function stop() {
  if (stopAttempted) return
  stopAttempted = true
  if (!owned) {
    if (attempted) { allStopped = false; throw new Error('Acquisition attempted without authenticated child; private root retained at '+dir) }
    return
  }
  const child = owned
  // Consume the handle once even if the public stop rejects.
  owned = undefined
  let confirmed = false
  try {
    await stopOwnedChild(child)
    confirmed = true
    cleanupReceipt('stopped', { pid: child.pid, exit: child.exitCode, signal: child.signalCode })
  } catch (error) {
    const result = error?.stopResult
    confirmed = result?.brand === 'isolated-local-services.stop' && result.version === 1 && result.termination === 'confirmed' && result.groupId === child.pid
    cleanupReceipt('stop-error', { pid: child.pid, termination: confirmed ? 'confirmed' : 'unconfirmed', reason: result?.reason })
    throw error
  } finally {
    if (!confirmed) {
      allStopped = false
      for (const action of [
        ...[...new Set(child.stdio ?? [])].filter(Boolean).map(stream => () => stream.destroy?.()),
        () => { if (child.connected) child.disconnect() }, () => child.unref(),
      ]) try { action() } catch (error) { cleanupErrors.push(new Error('Local handle release failed', { cause: error })) }
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
const scopedPath = relative(realpathSync(dir), realpathSync(dbPath))
assert.ok(scopedPath && !scopedPath.startsWith('..') && !isAbsolute(scopedPath), 'oracle requires this run private DB')
const Database = createRequire(import.meta.url)(driver)
oracle = new Database(dbPath, { readonly: true, fileMustExist: true })
// Each checkpoint is after awaited requests and before the next write; this run
// has no concurrent client. Finite observations cannot exclude infinite delayed writes.
function snapshot(stage) {
  const state = oracle.transaction(() => ({
    batches: oracle.prepare('SELECT * FROM platform_export_batch ORDER BY id').all(),
    rows: oracle.prepare('SELECT * FROM platform_export_row ORDER BY batch_id,source_row_no,id').all(),
    commands: oracle.prepare('SELECT * FROM import_batch ORDER BY id').all(),
    receipts: oracle.prepare('SELECT * FROM import_receipt ORDER BY id').all(),
  }))()
  receipt('checkpoint', { stage, counts: Object.fromEntries(Object.entries(state).map(([key, rows]) => [key, rows.length])) })
  return state
}
const normalKey = 'synthetic:crash-recovery', largeKey = 'synthetic:mcp-size-fallback'
const normalHistory = ['preflight', 'processing', 'preflight', 'committed']
const summary = { written: 301, skipped: 0, failed: 0, evidenceRepointed: 0 }
const camel = row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key.replace(/_([a-z])/g, (_, c) => c.toUpperCase()), value]))
function raw(index, large = false) {
  return { original: large ? 'x'.repeat(index === 150 ? 1_200_000 : 14_753) : `  原文🙂\n${index}  ` }
}
function collection(state, histories, versions) {
  for (const rows of Object.values(state)) {
    assert.equal(new Set(rows.map(row => row.id)).size, rows.length, 'unique physical IDs')
    for (const row of rows) assert.ok(Number.isSafeInteger(row.id) && row.id > 0, 'positive physical ID')
  }
  assert.deepEqual(state.commands.map(row => row.idempotency_key).sort(), Object.keys(histories).sort(), 'complete command keys')
  assert.equal(state.batches.length, versions.length, 'complete business batch count')
  assert.equal(state.rows.length, versions.length * 300, 'complete business row count')
  for (const row of state.rows) assert.ok(state.batches.some(batch => batch.id === row.batch_id), 'export row has parent')
  for (const row of state.receipts) assert.ok(state.commands.some(command => command.id === row.batch_id), 'receipt has command parent')
  for (const command of state.commands) {
    const history = histories[command.idempotency_key]
    assert.equal(command.source_kind, 'platform_export')
    assert.equal(command.source_identity, 'synthetic.xlsx')
    assert.equal(command.source_sha256, null)
    assert.equal(command.error, null)
    assert.ok(Number.isFinite(Date.parse(command.created_at)), 'command timestamp')
    const committed = history.at(-1) === 'committed'
    assert.equal(command.status, committed ? 'committed' : 'preflight')
    assert.deepEqual(JSON.parse(command.summary), committed ? summary : null, 'literal command summary')
    assert.equal(command.committed_at !== null, committed)
    const attempts = state.receipts.filter(row => row.batch_id === command.id)
    assert.deepEqual(attempts.map(row => row.status), history, 'literal receipt history')
    for (let index = 0; index < attempts.length; index++) {
      const row = attempts[index], status = history[index]
      assert.equal(row.operation, status === 'preflight' ? 'preflight' : 'commit')
      assert.match(row.request_hash, /^[a-f0-9]{64}$/)
      const body = JSON.parse(row.request_body)
      assert.equal(body.idempotencyKey, command.idempotency_key, 'retained request association')
      assert.equal(body.sourceKind, 'platform_export')
      assert.equal(body.payload.exportSnapshot.rows.length, 300)
      const isLarge = command.idempotency_key === largeKey
      assert.equal(body.payload.exportSnapshot.sha256, isLarge ? 'synthetic-large' : 'synthetic-recovery')
      for (let i = 0; i < 300; i++) {
        assert.equal(body.payload.exportSnapshot.rows[i].sourceRowNo, i + 3)
        assert.deepEqual(body.payload.exportSnapshot.rows[i].rawFields, raw(i, isLarge), `literal request raw row ${i}`)
      }
      assert.ok(Number.isFinite(Date.parse(row.created_at)), 'receipt timestamp')
      assert.equal(row.completed_at !== null, status !== 'processing')
      assert.deepEqual(JSON.parse(row.summary), status === 'committed' ? summary : null, 'literal receipt summary')
      assert.equal(JSON.parse(row.item_results ?? '[]').length, status === 'committed' ? 1 : 0, 'literal receipt item count')
    }
  }
  for (const [version, key] of versions.entries()) {
    const batch = state.batches[version], command = state.commands.find(row => row.idempotency_key === key)
    assert.ok(command && batch.import_batch_id === command.id, 'export batch has expected command parent')
    assert.equal(batch.title_code, 'specialized_sme'); assert.equal(batch.year, 2026)
    assert.equal(batch.collected_on, '2026-10-19'); assert.equal(batch.original_filename, 'synthetic.xlsx')
    assert.equal(batch.sha256, key === largeKey ? 'synthetic-large' : 'synthetic-recovery')
    assert.equal(batch.source_document_id, null); assert.equal(batch.import_status, 'imported')
    assert.equal(batch.replaced_batch_id, version === 0 ? null : state.batches[0].id)
    assert.ok(Number.isFinite(Date.parse(batch.created_at)), 'batch timestamp')
    const rows = state.rows.filter(row => row.batch_id === batch.id)
    assert.equal(rows.length, 300, 'complete version row count'); assert.equal(batch.row_count, rows.length)
    for (let i = 0; i < 300; i++) {
      const row = rows[i]
      assert.equal(row.source_row_no, i + 3, 'literal source coordinate')
      for (const column of ['uscc_raw', 'name_raw', 'district', 'province', 'city', 'reg_status']) assert.equal(row[column], null)
      assert.ok(Number.isFinite(Date.parse(row.created_at)), 'row timestamp')
      assert.deepEqual(JSON.parse(row.raw_fields), raw(i, key === largeKey), `literal raw row ${i}`)
    }
    // Receipt IDs are checked against independent physical discovery, never used to discover it.
    const expectedIDs = rows.map(row => row.id)
    for (const items of [command.item_results, ...state.receipts.filter(row => row.batch_id === command.id && row.status === 'committed').map(row => row.item_results)]) {
      const result = JSON.parse(items)
      assert.equal(result.length, 1); assert.equal(result[0].ok, true)
      assert.deepEqual(result[0].detail.rows, expectedIDs, 'receipt row IDs match physical input order')
    }
  }
}
async function get(path) {
  return request(path, { headers: { connection: 'close', authorization: 'Bearer synthetic-only' } }, async response => {
    assert.equal(response.status, 200); return response.json()
  })
}
async function publicState(state, histories, versions) {
  const list = await get('/api/platform/snapshots')
  assert.equal(list.count, state.batches.length, 'public complete batch count')
  assert.deepEqual(list.rows.map(item => item.batch), state.batches.map(camel), 'public unfiltered batch set')
  for (const item of list.rows) {
    assert.equal(item.rowCount, item.batch.rowCount)
    assert.equal(item.importStatus, item.batch.importStatus)
    assert.equal(item.replacedBatchId, item.batch.replacedBatchId)
  }
  for (const key of Object.keys(histories)) {
    const command = state.commands.find(row => row.idempotency_key === key)
    const attempts = state.receipts.filter(row => row.batch_id === command.id)
    const seen = []
    for (let page = 1; page <= attempts.length; page++) {
      const result = await get(`/api/roster/import/receipts/history?idempotencyKey=${encodeURIComponent(key)}&pageSize=1&page=${page}`)
      assert.equal(result.total, attempts.length); assert.equal(result.rows.length, 1)
      const row = result.rows[0], expected = attempts[page - 1]
      assert.equal(row.receiptId, expected.id); assert.equal(row.batchId, command.id)
      assert.equal(row.status, expected.status); assert.equal(row.operation, expected.operation)
      assert.equal(row.createdAt, expected.created_at); assert.equal(row.completedAt, expected.completed_at)
      assert.equal(row.itemCount, expected.status === 'committed' ? 1 : 0)
      seen.push(row.receiptId)
    }
    assert.equal(new Set(seen).size, attempts.length, 'unique complete public history')
  }
  for (const [version, key] of versions.entries()) {
    const batch = state.batches[version]
    const rows = state.rows.filter(row => row.batch_id === batch.id)
    for (let i = 0; i < rows.length; i++) {
      const { source } = await rpc('get_record_correspondence_source', { kind: 'export_row', id: rows[i].id })
      assert.equal(source.id, rows[i].id); assert.equal(source.batchId, batch.id)
      assert.equal(source.sourceRowNo, i + 3)
      assert.deepEqual(source.batch, camel(batch))
      for (const field of ['usccRaw', 'nameRaw', 'district', 'province', 'city', 'regStatus']) assert.equal(source[field], null)
      assert.deepEqual(source.rawFields, raw(i, key === largeKey), `public literal raw row ${i}`)
    }
  }
}
const initial = snapshot('R0')
collection(initial, {}, [])
// Fault injection observes the actual SQLite statement boundary. The native transaction is
// still open when the parent kills this owned process; no production implementation is mocked.
writeFileSync(hook, `import {createRequire} from 'node:module';import {writeFileSync} from 'node:fs';
const Database=createRequire(import.meta.url)(${JSON.stringify(driver)});const probe=new Database(':memory:');const proto=Object.getPrototypeOf(probe.prepare('select 1'));probe.close();let armed=true;
for(const method of ['all','run']){const original=proto[method];proto[method]=function(...args){const out=original.apply(this,args);if(armed&&this.source.startsWith('insert into "platform_export_row"')){armed=false;writeFileSync(${JSON.stringify(marker)},'transaction-open');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,60000)}return out}}`)
function registerChild(handle) {
  handle.on('error', error => { childError ??= error })
  for (const stream of new Set(handle.stdio ?? [])) {
    stream?.on?.('error', error => { childError ??= error })
    stream?.resume?.()
  }
}
async function start(interrupt = false) {
  assert.equal(owned, undefined, 'old owned group must be settled before restart')
  const port = await reserveLoopbackPort()
  base = `http://127.0.0.1:${port}`
  childError = undefined
  attempted = true
  stopAttempted = false
  try {
  owned = fork('.output/server/index.mjs', [], { execArgv: ['--max-old-space-size=2048', ...(interrupt ? ['--import', hook] : [])], env: {
    ...process.env,
    // The native import worker inherits this observer through NODE_OPTIONS.
    ...(interrupt ? { NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import ${JSON.stringify(hook)}` } : {}),
    HOST: '127.0.0.1', PORT: String(port), NUXT_DB_PATH: dbPath, NUXT_DB_READONLY: '0', NUXT_FILES_DIR: dir, NUXT_INCOMING_DIR: dir,
    NUXT_API_TOKEN: 'synthetic-only', NUXT_MCP_TOKEN: 'synthetic-only', MIIT_COOKIE: '', NUXT_OCR_TOKEN: '', PADDLEOCR_MCP_AISTUDIO_ACCESS_TOKEN: '',
  }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
  } catch (error) {
    owned = getOwnedChildStartFailure(error)?.child
    if (owned) try { registerChild(owned) } catch (registrationError) { cleanupErrors.push(new Error('Partial child registration failed', { cause: registrationError })) }
    throw error
  }

  let lastError
  registerChild(owned)
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
  collection(snapshot('Rpre'), { [normalKey]: ['preflight'] }, [])
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
  collection(snapshot('Rcrash'), { [normalKey]: ['preflight', 'processing'] }, [])
  const recovered = await rpc('preflight_roster_batch', input)
  assert.equal(recovered.batchId, preflight.batchId)
  assert.equal(recovered.preflight.add, 1)
  const committed = await rpc('save_roster_batch', input)
  assert.equal(committed.batchId, preflight.batchId)
  assert.equal(committed.status, 'committed')
  assert.equal(committed.summary.written, 301)
  const stable = snapshot('Rcommit')
  collection(stable, { [normalKey]: normalHistory }, [normalKey])
  assert.deepEqual(committed.items[0].detail.rows, stable.rows.map(row => row.id), 'returned unique IDs in physical order')
  await publicState(stable, { [normalKey]: normalHistory }, [normalKey])
  assert.deepEqual(await post('commit'), committed)
  assert.deepEqual(snapshot('Rreplay'), stable, 'normal replay unchanged')
  await stop()
  await start()
  assert.deepEqual(await post('commit'), committed, 'restart after success keeps the original idempotency receipt')
  assert.deepEqual(snapshot('R413-before'), stable, 'normal restart unchanged')
  const large = structuredClone(input)
  large.idempotencyKey = 'synthetic:mcp-size-fallback'
  large.payload.exportSnapshot.sha256 = 'synthetic-large'
  large.payload.exportSnapshot.rows.forEach((row, index) => { row.rawFields = { original: 'x'.repeat(index === 150 ? 1_200_000 : 14_753) } })
  await request('/mcp', { method: 'POST', headers: { connection: 'close', authorization: 'Bearer synthetic-only', 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name: 'preflight_roster_batch', arguments: large } }) }, async rejected => {
  assert.equal(rejected.status, 413, 'existing SDK request capacity remains explicit')
  await rejected.text()
  })
  assert.deepEqual(snapshot('R413-after'), stable, '413 complete four-table atomicity before fallback')
  assert.equal(await status('/api/roster/import/receipts?idempotencyKey=synthetic%3Amcp-size-fallback'), 404, 'literal large key absent before fallback')
  assert.equal(await status('/api/roster/correspondences/export-rows/301'), 404)
  const largePreflight = await post('preflight', large)
  assert.equal(largePreflight.preflight.add, 1)
  const delivered = await post('commit', large)
  assert.equal(delivered.status, 'committed')
  assert.equal(delivered.summary.written, 301, '413 does not consume the same key as a committed receipt')
  const final = snapshot('Rlarge')
  const histories = { [normalKey]: normalHistory, [largeKey]: ['preflight', 'committed'] }
  collection(final, histories, [normalKey, largeKey])
  for (const key of Object.keys(stable)) assert.deepEqual(final[key].slice(0, stable[key].length), stable[key], `old ${key} unchanged`)
  assert.deepEqual(delivered.items[0].detail.rows, final.rows.filter(row => row.batch_id === final.batches[1].id).map(row => row.id), 'large returned unique IDs in physical order')
  await publicState(final, histories, [normalKey, largeKey])
  assert.deepEqual(await post('commit', large), delivered)
  assert.deepEqual(snapshot('Rlarge-replay'), final, 'large replay unchanged')
  await stop()
  await start()
  assert.deepEqual(await post('commit'), committed)
  assert.deepEqual(await post('commit', large), delivered)
  assert.deepEqual(snapshot('Rstable'), final, 'large restart and both replays unchanged')
  await publicState(final, histories, [normalKey, largeKey])
  assert.deepEqual(snapshot('Rpublic-stable'), final, 'public reads unchanged')
}
async function status(path) {
  return request(path, { headers: { connection: 'close', authorization: 'Bearer synthetic-only' } }, async response => { await response.arrayBuffer(); return response.status })
}
try { await run() } catch (error) { primaryError = error }
finally {
  for (const controller of pending) controller.abort(new Error('Verifier cleanup cancelled request'))
  if (interrupted) await Promise.allSettled([interrupted])
  if (db) try { if (db.$client.open) db.$client.close() }
  catch (error) { allStopped = false; cleanupErrors.push(new Error('Database cleanup failed; private root retained', { cause: error })) }
  try { await stop() } catch (error) { cleanupErrors.push(new Error('Child cleanup failed', { cause: error })) }
  if (oracle) try { oracle.close(); oracle = undefined }
  catch (error) { cleanupErrors.push(new Error('Readonly oracle close failed; private root retained', { cause: error })) }
  if (dir && allStopped && !oracle) try { rmSync(dir, { recursive: true, force: true }) }
  catch (error) { cleanupErrors.push(new Error(`Private root cleanup failed; retained at ${dir}`, { cause: error })) }
  cleanupReceipt('finished', { primary: Boolean(primaryError), cleanupErrors: cleanupErrors.length, rootRetained: Boolean(dir && existsSync(dir)) })
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
console.log(JSON.stringify({ passed: true, lane: 'built Nitro HTTP + real MCP; private synthetic SQLite', checks: ['SIGKILL inside transaction after first chunk', 'no partial business rows after restart', 'same-key preflight/commit recovery across HTTP and MCP', 'all normal and large literal rows, coordinates, unique IDs and parents', 'original receipt survives second restart', 'MCP 413 followed by same-key complete HTTP delivery and original receipt replay', 'unfiltered four-table 413 atomicity before fallback', 'large success restart and both replays unchanged'], productionChanged: false }))
