#!/usr/bin/env node
// Fault injection against the built Nitro server and a fresh synthetic SQLite DB.
// Only child processes started by this script receive SIGKILL.
import assert from 'node:assert/strict'

import { existsSync, mkdtempSync, rmSync, realpathSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve, relative, isAbsolute } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { forkOwnedChild as fork, reserveLoopbackPort, stopOwnedChild, getOwnedChildStartFailure } from './lib/isolated-local-services.mjs'

let root, useDb, driver
let allStopped = true
let openOracles = 0
const cleanupErrors = []
let primaryError
const results = []

async function run() {
const { createJiti } = createRequire(import.meta.resolve('nuxt/package.json'))('jiti')
;({ useDb } = await createJiti(import.meta.url).import('../db/client.ts'))
driver = createRequire(resolve('.output/server/index.mjs')).resolve('better-sqlite3')
const phases = ['batch-finalized', 'receipt-finalized', 'commit-returned']
root = mkdtempSync(join(tmpdir(), 'snapshot-finalization-'))

  for (const phase of phases) await verify(phase)
}

async function verify(phase) {
  const dir = join(root, phase), dbPath = join(dir, 'roster.db'), marker = join(dir, 'paused')
  const hook = join(dir, 'fault-hook.mjs')
  let db, oracle, child, base, childError, primary
  let attempted = false, stopAttempted = false
  const errors = []
  const pending = new Set()
  const deadline = Date.now() + 90_000
  const emitReceipt = (state, extra = {}) => console.log(JSON.stringify({ phase, state, ...extra }))
  const cleanupReceipt = (...args) => { try { emitReceipt(...args) } catch (error) { errors.push(new Error('Cleanup receipt failed', { cause: error })) } }
  async function stop() {
    if (stopAttempted) return
    stopAttempted = true
    if (!child) {
      if (attempted) { allStopped = false; throw new Error('Acquisition attempted without authenticated child; private root retained at '+root) }
      return
    }
    const owned = child
    let confirmed = false
    try {
      await stopOwnedChild(owned)
      confirmed = true
      cleanupReceipt('stopped', { pid: owned.pid, exit: owned.exitCode, signal: owned.signalCode })
    } catch (error) {
      const result = error?.stopResult
      confirmed = result?.brand === 'isolated-local-services.stop' && result.version === 1 && result.termination === 'confirmed'
      cleanupReceipt('stop-error', { pid: owned.pid, termination: confirmed ? 'confirmed' : 'unconfirmed', reason: result?.reason })
      throw error
    } finally {
      if (confirmed) child = undefined
      else {
        allStopped = false
        for (const action of [
          ...[...new Set(owned.stdio ?? [])].filter(Boolean).map(stream => () => stream.destroy?.()),
          () => { if (owned.connected) owned.disconnect() }, () => owned.unref(),
        ]) try { action() } catch (error) { errors.push(new Error('Local handle release failed', { cause: error })) }
        errors.push(new Error(`Owned termination unconfirmed; pid=${owned.pid}; private root retained at ${root}`))
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
      catch (error) { errors.push(new Error('Response cleanup failed', { cause: error })) }
    }
  }
  try {
  db = useDb({ dbPath })
  db.$client.close()
  db = undefined
  const scopedPath = relative(realpathSync(root), realpathSync(dbPath))
  assert.ok(scopedPath && !scopedPath.startsWith('..') && !isAbsolute(scopedPath), 'oracle requires this run private DB')
  const Database = createRequire(import.meta.url)(driver)
  oracle = new Database(dbPath, { readonly: true, fileMustExist: true })
  openOracles++
  // Observe driver statements only. The production import, ledger, and transaction
  // implementation remain unchanged; each marker is written after native run returns.
  writeFileSync(hook, `import {createRequire} from 'node:module';import {writeFileSync} from 'node:fs';
const Database=createRequire(import.meta.url)(${JSON.stringify(driver)});
const probe=new Database(':memory:');const proto=Object.getPrototypeOf(probe.prepare('select 1'));probe.close();
let armed=true,receiptFinalized=false;const phase=${JSON.stringify(phase)};
const original=proto.run;proto.run=function(...args){const out=original.apply(this,args);
 const statement=this.source.trim().toLowerCase(),values=JSON.stringify(args);
 const batch=statement.startsWith('update "import_batch"')&&values.includes('committed');
 const receipt=statement.startsWith('update "import_receipt"')&&values.includes('committed');
 if(receipt)receiptFinalized=true;
 const matched=phase==='batch-finalized'?batch:phase==='receipt-finalized'?receipt:receiptFinalized&&statement==='commit';
 if(armed&&matched){armed=false;writeFileSync(${JSON.stringify(marker)},phase);Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,60000)}
 return out};`)
  const input = {
    idempotencyKey: `synthetic:finalization:${phase}`, sourceKind: 'platform_export', sourceIdentity: 'synthetic.xlsx',
    payload: { exportSnapshot: { titleCode: 'specialized_sme', year: 2026, collectedOn: '2026-10-20', originalFilename: 'synthetic.xlsx', sha256: `synthetic-${phase}`,
      rows: Array.from({ length: 300 }, (_, index) => ({ sourceRowNo: index + 3, rawFields: { original: `  原文🙂\n${index}  ` } })),
    } },
  }
  function registerChild(handle) {
    handle.on('error', error => { childError ??= error })
    for (const stream of new Set(handle.stdio ?? [])) {
      stream?.on?.('error', error => { childError ??= error })
      stream?.resume?.()
    }
  }
  async function start(interrupt = false) {
    assert.equal(child, undefined, 'old owned group must be settled before restart')
    const port = await reserveLoopbackPort()
    base = `http://127.0.0.1:${port}`
    childError = undefined
    attempted = true
    stopAttempted = false
    try {
    child = fork('.output/server/index.mjs', [], { execArgv: ['--max-old-space-size=2048', ...(interrupt ? ['--import', hook] : [])], env: {
      ...process.env,
      // Import execution is a nested OS process with explicit argv. Carry the
      // same driver observer through its inherited environment as well.
      ...(interrupt ? { NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import ${JSON.stringify(hook)}` } : {}),
      HOST: '127.0.0.1', PORT: String(port), NUXT_DB_PATH: dbPath, NUXT_DB_READONLY: '0', NUXT_FILES_DIR: dir, NUXT_INCOMING_DIR: dir,
      NUXT_API_TOKEN: 'synthetic-only', NUXT_MCP_TOKEN: 'synthetic-only', MIIT_COOKIE: '', NUXT_OCR_TOKEN: '', PADDLEOCR_MCP_AISTUDIO_ACCESS_TOKEN: '',
    }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
    } catch (error) {
      child = getOwnedChildStartFailure(error)?.child
      if (child) try { registerChild(child) } catch (registrationError) { errors.push(new Error('Partial child registration failed', { cause: registrationError })) }
      throw error
    }
    registerChild(child)
    const readyDeadline = Math.min(deadline, Date.now() + 8_000)
    let lastError
    while (Date.now() < readyDeadline) {
      if (childError) throw childError
      assert.equal(child.exitCode, null, 'owned server exited before readiness')
      assert.equal(child.signalCode, null, 'owned server signaled before readiness')
      try {
        if (await request('/api/health', { headers: { connection: 'close' } }, async response => { await response.arrayBuffer(); return response.ok }, Math.min(1000, readyDeadline - Date.now()))) return
      } catch (error) { lastError = error }
      await sleep(50)
    }
    throw new Error('built artifact did not become ready', { cause: lastError })
  }
  async function post(action) {
    return request(`/api/roster/import/${action}`, { method: 'POST', headers: { connection: 'close', authorization: 'Bearer synthetic-only', 'content-type': 'application/json' }, body: JSON.stringify(input) }, async response => {
      assert.equal(response.status, 200, `${action} status`)
      return response.json()
    })
  }
  async function get(path) {
    return request(path, { headers: { connection: 'close', authorization: 'Bearer synthetic-only' } }, async response => ({ status: response.status, body: await response.json() }))
  }
  const receiptPath = `/api/roster/import/receipts?idempotencyKey=${encodeURIComponent(input.idempotencyKey)}`
  const historyPath = `/api/roster/import/receipts/history?idempotencyKey=${encodeURIComponent(input.idempotencyKey)}`
  // Each projection is an unfiltered physical table enumeration. No response ID,
  // source identity, or expected key participates in discovering the collection.
  function snapshot() {
    return oracle.transaction(() => ({
      batches: oracle.prepare(`SELECT id,title_code,year,collected_on,original_filename,sha256,row_count,
        import_status,source_document_id,import_batch_id,replaced_batch_id,created_at
        FROM platform_export_batch ORDER BY id`).all(),
      rows: oracle.prepare(`SELECT id,batch_id,source_row_no,uscc_raw,name_raw,district,province,city,
        reg_status,raw_fields,created_at FROM platform_export_row ORDER BY batch_id,source_row_no,id`).all(),
      commands: oracle.prepare(`SELECT id,idempotency_key,source_kind,source_identity,source_sha256,status,
        preflight_result,item_results,summary,error,created_at,committed_at FROM import_batch ORDER BY id`).all(),
      receipts: oracle.prepare(`SELECT id,batch_id,operation,request_hash,request_body,status,summary,
        item_results,created_at,completed_at FROM import_receipt ORDER BY id`).all(),
    }))()
  }
  const summary = { written: 301, skipped: 0, failed: 0, evidenceRepointed: 0 }
  const raw = index => ({ original: `  原文🙂\n${index}  ` })
  const positiveId = id => assert.ok(Number.isSafeInteger(id) && id > 0, 'positive safe ID')
  const timestamp = value => assert.ok(typeof value === 'string' && /^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(Date.parse(value)), 'timestamp format')
  function assertCollection(state, statuses, hasBusiness) {
    for (const collection of Object.values(state)) {
      assert.equal(new Set(collection.map(row => row.id)).size, collection.length, 'unique physical IDs')
      for (const row of collection) { positiveId(row.id); timestamp(row.created_at) }
    }
    const commandIds = new Set(state.commands.map(row => row.id))
    const batchIds = new Set(state.batches.map(row => row.id))
    for (const row of state.rows) assert.ok(batchIds.has(row.batch_id), 'export row has parent')
    for (const batch of state.batches) assert.ok(commandIds.has(batch.import_batch_id), 'export batch has command parent')
    for (const receipt of state.receipts) assert.ok(commandIds.has(receipt.batch_id), 'receipt has command parent')
    assert.equal(state.batches.length, hasBusiness ? 1 : 0, 'complete business batch count')
    assert.equal(state.rows.length, hasBusiness ? 300 : 0, 'complete business row count')
    assert.equal(state.commands.length, statuses.length ? 1 : 0, 'complete command count')
    assert.deepEqual(state.receipts.map(row => row.status), statuses, 'complete receipt history')
    if (!statuses.length) return
    const command = state.commands[0]
    assert.equal(command.idempotency_key, `synthetic:finalization:${phase}`)
    assert.equal(command.source_kind, 'platform_export')
    assert.equal(command.source_identity, 'synthetic.xlsx')
    assert.equal(command.source_sha256, null)
    assert.equal(command.status, hasBusiness ? 'committed' : 'preflight')
    assert.equal(command.error, null)
    assert.deepEqual(JSON.parse(command.summary), hasBusiness ? summary : null)
    if (hasBusiness) timestamp(command.committed_at)
    else assert.equal(command.committed_at, null)
    const plan = JSON.parse(command.preflight_result)
    assert.equal(plan.add, 1)
    for (const [index, receipt] of state.receipts.entries()) {
      assert.equal(receipt.batch_id, command.id)
      assert.equal(receipt.operation, statuses[index] === 'preflight' ? 'preflight' : 'commit')
      assert.match(receipt.request_hash, /^[a-f0-9]{64}$/)
      assert.equal(receipt.request_hash, state.receipts[0].request_hash, 'same literal request hash across attempts')
      const request = JSON.parse(receipt.request_body)
      assert.deepEqual(request, { ...input, sourceSha256: null })
      assert.deepEqual(JSON.parse(receipt.summary), receipt.status === 'committed' ? summary : null)
      const items = JSON.parse(receipt.item_results)
      assert.equal(items?.length ?? 0, receipt.status === 'committed' ? 1 : 0, 'physical receipt itemCount')
      if (receipt.status === 'processing') assert.equal(receipt.completed_at, null)
      else timestamp(receipt.completed_at)
    }
    const items = JSON.parse(command.item_results)
    assert.equal(items?.length ?? 0, hasBusiness ? 1 : 0, 'physical command itemCount')
    if (!hasBusiness) return
    const batch = state.batches[0]
    assert.deepEqual({ ...batch, id: undefined, import_batch_id: undefined, created_at: undefined }, {
      id: undefined, title_code: 'specialized_sme', year: 2026, collected_on: '2026-10-20',
      original_filename: 'synthetic.xlsx', sha256: `synthetic-${phase}`, row_count: 300,
      import_status: 'imported', source_document_id: null, import_batch_id: undefined,
      replaced_batch_id: null, created_at: undefined,
    })
    assert.equal(batch.import_batch_id, command.id)
    assert.deepEqual(state.rows.map(row => row.source_row_no), Array.from({ length: 300 }, (_, index) => index + 3), 'complete source coordinates')
    for (const [index, row] of state.rows.entries()) {
      assert.equal(row.batch_id, batch.id)
      for (const key of ['uscc_raw', 'name_raw', 'district', 'province', 'city', 'reg_status']) assert.equal(row[key], null, key)
      assert.deepEqual(JSON.parse(row.raw_fields), raw(index), `literal raw row ${index}`)
    }
    // Retained private and redacted item details are checked against discovered IDs.
    for (const item of [items[0], ...state.receipts.filter(row => row.status === 'committed').map(row => JSON.parse(row.item_results)[0])]) {
      assert.equal(item.ok, true)
      assert.equal(item.kind, 'export_batch')
      assert.deepEqual(item.detail.rows, state.rows.map(row => row.id), 'stored receipt row IDs match physical ordered set')
    }
  }
  async function checkpoint(label, statuses, hasBusiness) {
    const state = snapshot()
    assertCollection(state, statuses, hasBusiness)
    const listed = await get('/api/platform/snapshots')
    assert.equal(listed.status, 200)
    assert.equal(listed.body.count, state.batches.length, 'public unfiltered batch count')
    assert.deepEqual(listed.body.rows.map(row => row.batch.id).sort((a, b) => a - b), state.batches.map(row => row.id), 'public unfiltered batch IDs')
    for (const item of listed.body.rows) {
      const batch = state.batches.find(row => row.id === item.batch.id)
      const camel = Object.fromEntries(Object.entries(batch).map(([key, value]) => [key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase()), value]))
      assert.deepEqual(item, { batch: camel, replacedBatchId: null, rowCount: 300, importStatus: 'imported' })
    }
    if (statuses.length) {
      // pageSize=1 exercises complete pagination even in this tiny fixture.
      const history = []
      for (let page = 1; page <= statuses.length; page++) {
        const response = await get(`${historyPath}&page=${page}&pageSize=1`)
        assert.equal(response.status, 200)
        assert.equal(response.body.total, statuses.length, 'history total stable')
        assert.equal(response.body.rows.length, 1, 'no history page gap')
        history.push(...response.body.rows)
      }
      assert.deepEqual(history, state.receipts.map(row => ({ receiptId: row.id, batchId: row.batch_id, operation: row.operation,
        status: row.status, createdAt: row.created_at, completedAt: row.completed_at, itemCount: row.status === 'committed' ? 1 : 0 })), 'public complete history matches physical ledger')
      const latest = await get(receiptPath)
      assert.equal(latest.status, 200)
      assert.equal(latest.body.receiptId, state.receipts.at(-1).id)
      assert.equal(latest.body.batchId, state.commands[0].id)
      assert.equal(latest.body.status, statuses.at(-1))
      assert.equal(latest.body.itemCount, hasBusiness ? 1 : 0)
      assert.deepEqual(latest.body.summary, hasBusiness ? summary : null)
      const items = await get(`/api/roster/import/receipts/items?receiptId=${latest.body.receiptId}`)
      assert.equal(items.status, 200)
      assert.equal(items.body.total, hasBusiness ? 1 : 0)
    }
    emitReceipt('oracle', { checkpoint: label, counts: Object.fromEntries(Object.entries(state).map(([key, rows]) => [key, rows.length])) })
    return state
  }
  async function readAllRows(ids) {
    const state = snapshot()
    assertCollection(state, phase === 'commit-returned' ? ['preflight', 'committed'] : ['preflight', 'processing', 'preflight', 'committed'], true)
    assert.equal(ids.length, 300, 'all source row IDs returned')
    assert.equal(new Set(ids).size, 300, 'source row IDs are unique')
    assert.deepEqual(ids, state.rows.map(row => row.id), 'response IDs match independently enumerated ordered set')
    for (const [index, row] of state.rows.entries()) {
      const result = await get(`/api/roster/correspondences/export-rows/${row.id}`)
      assert.equal(result.status, 200, `source row ${index}`)
      assert.equal(result.body.source.id, row.id)
      assert.equal(result.body.source.batchId, state.batches[0].id)
      for (const key of ['usccRaw', 'nameRaw', 'district', 'province', 'city', 'regStatus']) assert.equal(result.body.source[key], null, key)
      assert.equal(result.body.source.sourceRowNo, index + 3)
      assert.deepEqual(result.body.source.rawFields, raw(index))
      assert.equal(result.body.source.batch.id, state.batches[0].id)
    }
  }
  async function replayCommit() {
    const before = snapshot()
    const result = await post('commit')
    assert.deepEqual(snapshot(), before, 'every replay preserves all four tables')
    return result
  }
    await start(true)
    await checkpoint('F0', [], false)
    const preflight = await post('preflight')
    assert.equal(preflight.preflight.add, 1)
    const before = await checkpoint('Fpre', ['preflight'], false)
    assert.equal(preflight.batchId, before.commands[0].id)
    let interruptedError
    const interrupted = post('commit').catch(error => {
      if (error instanceof TypeError && ['UND_ERR_SOCKET', 'ECONNRESET'].includes(error.cause?.code)) return null
      interruptedError = error
      throw error
    })
    // Attach immediately: the request can fail while the marker is still awaited.
    void interrupted.catch(error => { interruptedError ??= error })
    for (let index = 0; index < 200 && !existsSync(marker); index++) {
      if (interruptedError) throw interruptedError
      await sleep(25)
    }
    if (interruptedError) throw interruptedError
    assert.ok(existsSync(marker), `${phase} hook reached`)
    await new Promise((resolveExit, rejectExit) => {
      const owned = child
      const finish = error => { clearTimeout(timer); owned.off('exit', onExit); error ? rejectExit(error) : resolveExit() }
      const onExit = () => finish()
      const timer = setTimeout(() => finish(new Error('SIGKILL exit deadline exceeded')), 3_000)
      owned.once('exit', onExit)
      try { assert.ok(owned.kill('SIGKILL'), 'owned SIGKILL sent') } catch (error) { finish(error) }
    })
    assert.equal(child.signalCode, 'SIGKILL')
    assert.equal(await interrupted, null, 'interrupted HTTP response has no success body')
    await stop()
    await start()
    await checkpoint('Fcrash', phase === 'commit-returned' ? ['preflight', 'committed'] : ['preflight', 'processing'], phase === 'commit-returned')
    const receipt = await get(receiptPath), history = await get(historyPath)
    assert.equal(receipt.status, 200)
    assert.equal(history.status, 200)
    assert.equal(receipt.body.batchId, preflight.batchId)
    assert.deepEqual(history.body.rows.map(row => row.status), phase === 'commit-returned' ? ['preflight', 'committed'] : ['preflight', 'processing'])
    const items = await get(`/api/roster/import/receipts/items?receiptId=${receipt.body.receiptId}`)
    assert.equal(items.status, 200)
    assert.equal(items.body.total, phase === 'commit-returned' ? 1 : 0, 'no partial item audit')
    if (phase === 'commit-returned') {
      assert.equal(receipt.body.status, 'committed')
      assert.deepEqual(receipt.body.summary, { written: 301, skipped: 0, failed: 0, evidenceRepointed: 0 })
      assert.equal((await post('preflight')).preflight.batchStatus, 'committed')
      const replay = await replayCommit()
      assert.equal(replay.batchId, preflight.batchId)
      assert.equal(replay.status, 'committed')
      await readAllRows(replay.items[0].detail.rows)
      assert.deepEqual(await replayCommit(), replay)
      assert.equal((await get(historyPath)).body.total, 2, 'lost response creates no duplicate receipt')
    } else {
      assert.equal(receipt.body.status, 'processing', 'interrupted attempt stays visibly unresolved')
      assert.equal((await get('/api/roster/correspondences/export-rows/1')).status, 404, 'no business row survived')
      const retryPlan = await post('preflight')
      assert.equal(retryPlan.batchId, preflight.batchId)
      assert.equal(retryPlan.preflight.add, 1)
      const committed = await post('commit')
      assert.equal(committed.batchId, preflight.batchId)
      assert.equal(committed.summary.written, 301)
      await readAllRows(committed.items[0].detail.rows)
      assert.deepEqual(await replayCommit(), committed)
      assert.deepEqual((await get(historyPath)).body.rows.map(row => row.status), ['preflight', 'processing', 'preflight', 'committed'])
    }
    const statuses = phase === 'commit-returned' ? ['preflight', 'committed'] : ['preflight', 'processing', 'preflight', 'committed']
    const stable = await checkpoint('Fretry', statuses, true)
    const replay = await replayCommit()
    assert.deepEqual(await checkpoint('Freplay', statuses, true), stable, 'replay leaves all four tables unchanged')
    await stop()
    await start()
    assert.deepEqual(await replayCommit(), replay, 'same receipt survives another restart')
    assert.deepEqual(await checkpoint('Fstable', statuses, true), stable, 'second restart leaves all four tables unchanged')
    await readAllRows(replay.items[0].detail.rows)
    results.push({ phase, batchId: preflight.batchId, history: (await get(historyPath)).body.rows.map(row => row.status) })
  } catch (error) { primary = error }
  finally {
    for (const controller of pending) controller.abort(new Error('Phase cleanup cancelled request'))
    if (db) try { if (db.$client.open) db.$client.close() } catch (error) { allStopped = false; errors.push(new Error('Database cleanup failed', { cause: error })) }
    if (oracle) try { oracle.close(); openOracles-- } catch (error) { errors.push(new Error('Oracle cleanup failed', { cause: error })) }
    // A failed stop has already consumed this handle's single public stop attempt.
    try { await stop() } catch (error) { errors.push(new Error('Child cleanup failed', { cause: error })) }
    cleanupReceipt('finished', { primary: Boolean(primary), cleanupErrors: errors.length, rootRetained: !allStopped || openOracles > 0 })
  }
  if (primary || errors.length) throw new AggregateError([...(primary ? [primary] : []), ...errors], `${phase} failed (primary first, cleanup retained)`)
}

try { await run() } catch (error) { primaryError = error }
finally {
  if (root && allStopped && openOracles === 0) try { rmSync(root, { recursive: true, force: true }) }
  catch (error) { cleanupErrors.push(new Error(`Private root cleanup failed; retained at ${root}`, { cause: error })) }
}
if (primaryError || cleanupErrors.length) {
  const failure = new AggregateError([...(primaryError ? [primaryError] : []), ...cleanupErrors], 'Finalization verifier failed (primary first, cleanup retained)')
  // Node's default exception inspection truncates deeply nested cleanup causes.
  // These synthetic-run diagnostics contain no request bodies or credentials.
  const describe = error => ({ name: error.name, message: error.message, code: error.code,
    ...(error.errors ? { errors: error.errors.map(describe) } : {}),
    ...(error.cause ? { cause: describe(error.cause) } : {}),
  })
  console.error(JSON.stringify({ failed: true, diagnostic: describe(failure) }))
  throw failure
}
console.log(JSON.stringify({ passed: true, phases: results, cleanup: 'complete' }))
