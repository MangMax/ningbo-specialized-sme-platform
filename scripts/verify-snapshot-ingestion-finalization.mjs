#!/usr/bin/env node
// Fault injection against the built Nitro server and a fresh synthetic SQLite DB.
// Only child processes started by this script receive SIGKILL.
import assert from 'node:assert/strict'

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { forkOwnedChild as fork, reserveLoopbackPort, stopOwnedChild } from './lib/isolated-local-services.mjs'

let root, useDb, driver
let allStopped = true
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
  let db, child, base, childError, primary
  const errors = []
  const pending = new Set()
  const deadline = Date.now() + 90_000
  const receipt = (state, extra = {}) => console.log(JSON.stringify({ phase, state, ...extra }))
  async function stop() {
    if (!child) return
    const owned = child
    let confirmed = false
    try {
      await stopOwnedChild(owned)
      confirmed = true
      receipt('stopped', { pid: owned.pid, exit: owned.exitCode, signal: owned.signalCode })
    } catch (error) {
      const result = error?.stopResult
      confirmed = result?.brand === 'isolated-local-services.stop' && result.version === 1 && result.termination === 'confirmed'
      receipt('stop-error', { pid: owned.pid, termination: confirmed ? 'confirmed' : 'unconfirmed', reason: result?.reason })
      throw error
    } finally {
      if (confirmed) child = undefined
      else {
        allStopped = false
        owned.stdout?.destroy(); owned.stderr?.destroy()
        if (owned.connected) owned.disconnect()
        owned.unref()
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
  async function start(interrupt = false) {
    assert.equal(child, undefined, 'old owned group must be settled before restart')
    const port = await reserveLoopbackPort()
    base = `http://127.0.0.1:${port}`
    child = fork('.output/server/index.mjs', [], { execArgv: ['--max-old-space-size=2048', ...(interrupt ? ['--import', hook] : [])], env: {
      ...process.env,
      // Import execution is a nested OS process with explicit argv. Carry the
      // same driver observer through its inherited environment as well.
      ...(interrupt ? { NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import ${JSON.stringify(hook)}` } : {}),
      HOST: '127.0.0.1', PORT: String(port), NUXT_DB_PATH: dbPath, NUXT_DB_READONLY: '0', NUXT_FILES_DIR: dir, NUXT_INCOMING_DIR: dir,
      NUXT_API_TOKEN: 'synthetic-only', NUXT_MCP_TOKEN: 'synthetic-only', MIIT_COOKIE: '', NUXT_OCR_TOKEN: '', PADDLEOCR_MCP_AISTUDIO_ACCESS_TOKEN: '',
    }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
    childError = undefined
    child.on('error', error => { childError = error })
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
  async function readAllRows(ids) {
    assert.equal(ids.length, 300, 'all source row IDs returned')
    assert.equal(new Set(ids).size, 300, 'source row IDs are unique')
    for (const [index, id] of ids.entries()) {
      const result = await get(`/api/roster/correspondences/export-rows/${id}`)
      assert.equal(result.status, 200, `source row ${index}`)
      assert.equal(result.body.source.sourceRowNo, index + 3)
      assert.deepEqual(result.body.source.rawFields, input.payload.exportSnapshot.rows[index].rawFields)
    }
  }
    await start(true)
    const preflight = await post('preflight')
    assert.equal(preflight.preflight.add, 1)
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
      const replay = await post('commit')
      assert.equal(replay.batchId, preflight.batchId)
      assert.equal(replay.status, 'committed')
      await readAllRows(replay.items[0].detail.rows)
      assert.deepEqual(await post('commit'), replay)
      assert.equal((await get(historyPath)).body.total, 2, 'lost response creates no duplicate receipt')
      await stop()
      await start()
      assert.deepEqual(await post('commit'), replay, 'same receipt survives another restart')
      assert.equal((await get(historyPath)).body.total, 2)
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
      assert.deepEqual(await post('commit'), committed)
      assert.deepEqual((await get(historyPath)).body.rows.map(row => row.status), ['preflight', 'processing', 'preflight', 'committed'])
    }
    results.push({ phase, batchId: preflight.batchId, history: (await get(historyPath)).body.rows.map(row => row.status) })
  } catch (error) { primary = error }
  finally {
    for (const controller of pending) controller.abort(new Error('Phase cleanup cancelled request'))
    if (db) try { if (db.$client.open) db.$client.close() } catch (error) { errors.push(new Error('Database cleanup failed', { cause: error })) }
    // A failed stop has already consumed this handle's single public stop attempt.
    if (child && allStopped) try { await stop() } catch (error) { errors.push(new Error('Child cleanup failed', { cause: error })) }
    receipt('finished', { primary: Boolean(primary), cleanupErrors: errors.length, rootRetained: !allStopped })
  }
  if (primary || errors.length) throw new AggregateError([...(primary ? [primary] : []), ...errors], `${phase} failed (primary first, cleanup retained)`)
}

try { await run() } catch (error) { primaryError = error }
finally {
  if (root && allStopped) try { rmSync(root, { recursive: true, force: true }) }
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
