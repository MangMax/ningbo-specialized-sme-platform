#!/usr/bin/env node
// Built artifact, real HTTP/MCP, owned synthetic SQLite only; SIGKILL is never sent to a shared server.
import assert from 'node:assert/strict'

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { forkOwnedChild as fork, reserveLoopbackPort, stopOwnedChild } from './lib/isolated-local-services.mjs'

const { createJiti } = createRequire(import.meta.resolve('nuxt/package.json'))('jiti')
const { useDb } = await createJiti(import.meta.url).import('../db/client.ts')
const dir = mkdtempSync(join(tmpdir(), 'snapshot-recovery-')), dbPath = join(dir, 'roster.db')
useDb({ dbPath }).$client.close()
const marker = join(dir, 'first-chunk-written'), hook = join(dir, 'kill-boundary.mjs')
const driver = createRequire(resolve('.output/server/index.mjs')).resolve('better-sqlite3')
// Fault injection observes the actual SQLite statement boundary. The native transaction is
// still open when the parent kills this owned process; no production implementation is mocked.
writeFileSync(hook, `import {createRequire} from 'node:module';import {writeFileSync} from 'node:fs';
const Database=createRequire(import.meta.url)(${JSON.stringify(driver)});const probe=new Database(':memory:');const proto=Object.getPrototypeOf(probe.prepare('select 1'));probe.close();let armed=true;
for(const method of ['all','run']){const original=proto[method];proto[method]=function(...args){const out=original.apply(this,args);if(armed&&this.source.startsWith('insert into "platform_export_row"')){armed=false;writeFileSync(${JSON.stringify(marker)},'transaction-open');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,60000)}return out}}`)
let owned, base, rpcId = 0
async function start(interrupt = false) {
  const port = await reserveLoopbackPort()
  base = `http://127.0.0.1:${port}`
  owned = fork('.output/server/index.mjs', [], { execArgv: ['--max-old-space-size=2048', ...(interrupt ? ['--import', hook] : [])], env: {
    ...process.env, HOST: '127.0.0.1', PORT: String(port), NUXT_DB_PATH: dbPath, NUXT_DB_READONLY: '0', NUXT_FILES_DIR: dir, NUXT_INCOMING_DIR: dir,
    NUXT_API_TOKEN: 'synthetic-only', NUXT_MCP_TOKEN: 'synthetic-only', MIIT_COOKIE: '', NUXT_OCR_TOKEN: '', PADDLEOCR_MCP_AISTUDIO_ACCESS_TOKEN: '',
  }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
  let ready = false
  for (let i = 0; i < 120; i++) {
    assert.equal(owned.exitCode, null, 'owned server exited before readiness')
    try { ready = (await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1000), headers: { connection: 'close' } })).ok } catch {}
    if (ready) break
    await sleep(50)
  }
  assert.ok(ready, 'built artifact readiness')
}
const input = {
  idempotencyKey: 'synthetic:crash-recovery', sourceKind: 'platform_export', sourceIdentity: 'synthetic.xlsx',
  payload: { exportSnapshot: { titleCode: 'specialized_sme', year: 2026, collectedOn: '2026-10-19', originalFilename: 'synthetic.xlsx', sha256: 'synthetic-recovery',
    rows: Array.from({ length: 300 }, (_, i) => ({ sourceRowNo: i + 3, rawFields: { original: `  原文🙂\n${i}  ` } })),
  } },
}
async function post(action, payload = input) {
  const response = await fetch(`${base}/api/roster/import/${action}`, { method: 'POST', signal: AbortSignal.timeout(20_000), headers: { connection: 'close', authorization: 'Bearer synthetic-only', 'content-type': 'application/json' }, body: JSON.stringify(payload) })
  assert.equal(response.status, 200)
  return response.json()
}
async function rpc(name, args) {
  const response = await fetch(`${base}/mcp`, { method: 'POST', signal: AbortSignal.timeout(20_000), headers: { connection: 'close', authorization: 'Bearer synthetic-only', 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } }) })
  assert.equal(response.status, 200)
  const text = await response.text(), body = JSON.parse(text.split('\n').find(line => line.startsWith('data: '))?.slice(6) ?? text)
  assert.ok(!body.error && !body.result.isError, 'MCP call must succeed')
  return JSON.parse(body.result.content[0].text)
}
try {
  await start(true)
  const preflight = await post('preflight')
  assert.equal(preflight.preflight.add, 1)
  const interrupted = post('commit').catch(() => null)
  for (let i = 0; i < 200 && !existsSync(marker); i++) await sleep(25)
  assert.ok(existsSync(marker), 'first real insert chunk reached the open transaction')
  const exited = new Promise(resolveExit => owned.once('exit', resolveExit))
  owned.kill('SIGKILL')
  await exited
  assert.equal(owned.signalCode, 'SIGKILL')
  assert.equal(await interrupted, null, 'interrupted HTTP response must not become a success receipt')
  await start()
  assert.equal((await fetch(`${base}/api/roster/correspondences/export-rows/1`, { headers: { connection: 'close' } })).status, 404, 'no first-chunk business row survived recovery')
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
  await stopOwnedChild(owned)
  await start()
  assert.deepEqual(await post('commit'), committed, 'restart after success keeps the original idempotency receipt')
  const large = structuredClone(input)
  large.idempotencyKey = 'synthetic:mcp-size-fallback'
  large.payload.exportSnapshot.sha256 = 'synthetic-large'
  large.payload.exportSnapshot.rows.forEach((row, index) => { row.rawFields = { original: 'x'.repeat(index === 150 ? 1_200_000 : 14_753) } })
  const rejected = await fetch(`${base}/mcp`, { method: 'POST', headers: { connection: 'close', authorization: 'Bearer synthetic-only', 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name: 'preflight_roster_batch', arguments: large } }) })
  assert.equal(rejected.status, 413, 'existing SDK request capacity remains explicit')
  await rejected.text()
  assert.equal((await fetch(`${base}/api/roster/correspondences/export-rows/301`, { headers: { connection: 'close' } })).status, 404)
  const largePreflight = await post('preflight', large)
  assert.equal(largePreflight.preflight.add, 1)
  const delivered = await post('commit', large)
  assert.equal(delivered.status, 'committed')
  assert.equal(delivered.summary.written, 301, '413 does not consume the same key as a committed receipt')
  const { source } = await rpc('get_record_correspondence_source', { kind: 'export_row', id: delivered.items[0].detail.rows[150] })
  assert.deepEqual(source.rawFields, large.payload.exportSnapshot.rows[150].rawFields)
  assert.deepEqual(await post('commit', large), delivered)
  console.log(JSON.stringify({ passed: true, lane: 'built Nitro HTTP + real MCP; private synthetic SQLite', checks: ['SIGKILL inside transaction after first chunk', 'no partial business rows after restart', 'same-key preflight/commit recovery across HTTP and MCP', 'exact raw/source order at chunk boundary', 'original receipt survives second restart', 'MCP 413 followed by same-key complete HTTP delivery and original receipt replay', 'oversize single item exact MCP readback'], productionChanged: false }))
} finally {
  await stopOwnedChild(owned)
  rmSync(dir, { recursive: true, force: true })
}
