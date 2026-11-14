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

const { createJiti } = createRequire(import.meta.resolve('nuxt/package.json'))('jiti')
const { initializeDb } = await createJiti(import.meta.url).import('../db/client.ts')
const driver = createRequire(resolve('.output/server/index.mjs')).resolve('better-sqlite3')
const phases = ['batch-finalized', 'receipt-finalized', 'commit-returned']
const root = mkdtempSync(join(tmpdir(), 'snapshot-finalization-'))

async function verify(phase) {
  const dir = join(root, phase), dbPath = join(dir, 'roster.db'), marker = join(dir, 'paused')
  const hook = join(dir, 'fault-hook.mjs')
  initializeDb({ dbPath, create: true }).$client.close()
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
  let child, base
  async function start(interrupt = false) {
    const port = await reserveLoopbackPort()
    base = `http://127.0.0.1:${port}`
    child = fork('.output/server/index.mjs', [], { execArgv: ['--max-old-space-size=2048', ...(interrupt ? ['--import', hook] : [])], env: {
      ...process.env, HOST: '127.0.0.1', PORT: String(port), NUXT_DB_PATH: dbPath, NUXT_DB_READONLY: '0', NUXT_FILES_DIR: dir, NUXT_INCOMING_DIR: dir,
      NUXT_API_TOKEN: 'synthetic-only', NUXT_MCP_TOKEN: 'synthetic-only', MIIT_COOKIE: '', NUXT_OCR_TOKEN: '', PADDLEOCR_MCP_AISTUDIO_ACCESS_TOKEN: '',
    }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
    for (let index = 0; index < 120; index++) {
      assert.equal(child.exitCode, null, 'owned server exited before readiness')
      try {
        if ((await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1000), headers: { connection: 'close' } })).ok) return
      } catch {}
      await sleep(50)
    }
    assert.fail('built artifact did not become ready')
  }
  async function post(action) {
    const response = await fetch(`${base}/api/roster/import/${action}`, { method: 'POST', signal: AbortSignal.timeout(20_000), headers: { connection: 'close', authorization: 'Bearer synthetic-only', 'content-type': 'application/json' }, body: JSON.stringify(input) })
    assert.equal(response.status, 200, `${action} status`)
    return response.json()
  }
  async function get(path) {
    const response = await fetch(base + path, { signal: AbortSignal.timeout(20_000), headers: { connection: 'close', authorization: 'Bearer synthetic-only' } })
    return { status: response.status, body: await response.json() }
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
  try {
    await start(true)
    const preflight = await post('preflight')
    assert.equal(preflight.preflight.add, 1)
    const interrupted = post('commit').catch(() => null)
    for (let index = 0; index < 200 && !existsSync(marker); index++) await sleep(25)
    assert.ok(existsSync(marker), `${phase} hook reached`)
    const exited = new Promise(resolveExit => child.once('exit', resolveExit))
    child.kill('SIGKILL')
    await exited
    assert.equal(child.signalCode, 'SIGKILL')
    assert.equal(await interrupted, null, 'interrupted HTTP response has no success body')
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
      await stopOwnedChild(child)
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
    console.log(JSON.stringify({ phase, passed: true, batchId: preflight.batchId, history: (await get(historyPath)).body.rows.map(row => row.status) }))
  } finally { await stopOwnedChild(child) }
}

try {
  for (const phase of phases) await verify(phase)
} finally { rmSync(root, { recursive: true, force: true }) }
