// Child process: actual evlog -> applicationLogs; never a parallel logger implementation.
import { createRequire } from 'node:module'
import { performance } from 'node:perf_hooks'
import { setTimeout as sleep } from 'node:timers/promises'
import { statSync } from 'node:fs'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { createPerformancePhases } from './performance-phases.mjs'
const { createJiti } = createRequire(import.meta.resolve('nuxt/package.json'))('jiti')
const jiti = createJiti(import.meta.url)
const { appLog, applicationLogs, initializeWorkerLogging, closeApplicationLogging } = await jiti.import('../../lib/logging/index.ts')
const { safeLogEvent } = await jiti.import('../../lib/logging/privacy.ts')
const { APPLICATION_LOG_ROUTES } = await jiti.import('../../lib/logging/route-templates.ts')
const longestRoute = [...APPLICATION_LOG_ROUTES].sort((a,b)=>b.length-a.length)[0]
const { LOG_SOURCES, LOG_DEFAULTS } = await jiti.import('../../lib/logging/contract.ts')
initializeWorkerLogging()
const svc = applicationLogs(), meter = createPerformancePhases()
const dbPath = join(process.env.NUXT_LOG_DIR, 'events.db')
const nonce = 'PRIVATE_LOGGING_PERFORMANCE_NONCE'
const small = { source: 'system', operation: 'benchmark.event', outcome: 'success', level: 'info', error: new Error(nonce), body: nonce }
const large = { ...small, source: 'mcp', operation: 'b'.repeat(96), origin: { runtime: 'node', integration: 'mcp-toolkit', capture: 'hook', execution: 'worker' },
  requestId: 'r'.repeat(128), traceId: 't'.repeat(128), taskId: 'k'.repeat(128), resourceType: 'y'.repeat(128), parentEventId: 'p'.repeat(128), batchId: 'b'.repeat(128), resourceId: 'i'.repeat(128), auditId: 'a'.repeat(128), receiptId: 'c'.repeat(128),
  fileId: Number.MAX_SAFE_INTEGER, page: Number.MAX_SAFE_INTEGER, durationMs: Number.MAX_SAFE_INTEGER, statusCode: 599, httpMethod: 'OPTIONS', httpRoute: longestRoute, errorCode: 'e'.repeat(64),
  counts: { done: Number.MAX_SAFE_INTEGER, total: Number.MAX_SAFE_INTEGER, failed: Number.MAX_SAFE_INTEGER, dropped: Number.MAX_SAFE_INTEGER },
  mcp: { transport: 'streamable-http', rpcMethod: 'notifications/initialized', tool: 't'.repeat(64), sessionMode: 'stateless', client: { name: 'codex', version: '9999.9999.9999.9999-'+'a'.repeat(24) }, protocolVersionRequested: '2025-11-25' } }
const projected = safeLogEvent(large)
assert.equal(projected.operation.length, 96); assert.equal(projected.requestId.length, 128)
assert.equal(projected.mcp.tool.length, 64); assert.equal(projected.mcp.client.version, large.mcp.client.version)
assert.equal(projected.errorCode.length, 64); assert.equal(projected.httpRoute, longestRoute)
for (const key of ['requestId','traceId','taskId','resourceType','parentEventId','batchId','resourceId','auditId','receiptId']) assert.equal(projected[key].length,128)
assert.ok(!JSON.stringify(projected).includes(nonce))
const disk = () => Object.fromEntries(['', '-journal', '-wal', '-shm'].map(s => { try { return [s || 'db', statSync(dbPath + s).size] } catch { return [s || 'db', 0] } }))
const readRows = () => { const db = new Database(dbPath, { readonly: true }); try { return db.prepare('select count(*) n from log_events').get().n } finally { db.close() } }
async function timed(label, fn) { await meter.begin(label); const value = await fn(); return { value, telemetry: await meter.end(label) } }
async function load({ rate = 1000, seconds = 5, shape = 'small', switchPolicy = false }) {
  const event = shape === 'small' ? small : large
  let emitted = 0, maxLateMs = 0, ticks = 0, policyStage = 0
  const samples = [], start = performance.now(), before = svc.status()
  let nextSample = 0
  while (performance.now() - start < seconds * 1000) {
    const elapsed = performance.now() - start
    const due = Math.floor(elapsed * rate / 1000)
    const count = Math.min(rate / 2, due - emitted) // bounded catch-up; schedule deficit reported
    for (let i = 0; i < count; i++) { appLog(event); emitted++ }
    maxLateMs = Math.max(maxLateMs, elapsed - ticks * 10); ticks = Math.floor(elapsed / 10) + 1
    if (switchPolicy && Math.floor(elapsed / (seconds * 250)) > policyStage) {
      policyStage = Math.floor(elapsed / (seconds * 250))
      const modes = ['debug', 'off', 'warn', 'debug']; const mode = modes[Math.min(3, policyStage)]
      try { await svc.setPolicy({ retentionDays: 7, maxBytes: 4294967296, collection: { sources: Object.fromEntries(LOG_SOURCES.map(s => [s, { enabled: mode !== 'off', minLevel: mode === 'warn' ? 'warn' : 'debug' }])) } }); samples.push({ policySwitchMs: elapsed, mode }) } catch (e) { samples.push({ policyError: e.code, atMs: elapsed }) }
    }
    if (elapsed >= nextSample) { samples.push({ atMs: elapsed, memory: process.memoryUsage(), cpu: process.cpuUsage(), status: svc.status(), disk: disk(), stdoutBuffered: process.stdout.writableLength }); nextSample += 1000 }
    await sleep(Math.max(0, ticks * 10 - (performance.now() - start)))
  }
  const loadMs = performance.now() - start, queuedAtEnd = svc.status(), flushStart = performance.now()
  await svc.flush()
  const after = svc.status()
  return { emitted, requested: rate * seconds, rate, seconds, shape, actualEventsPerSecond: emitted / loadMs * 1000, loadMs, maxScheduleLateMs: maxLateMs, before, queuedAtEnd, after, drainMs: performance.now() - flushStart, samples, disk: disk() }
}
async function queries(target) {
  const prepStart = performance.now()
  while (svc.status().stored < target) { if (performance.now()-prepStart>120000) throw Error('query preparation deadline'); const storedBefore=svc.status().stored; const n = Math.min(512, target - svc.status().stored); for (let i=0;i<n;i++) appLog(small); await svc.flush(); assert.ok(svc.status().stored>storedBefore,'query preparation made no progress') }
  const preparationMs = performance.now() - prepStart, rows = readRows(), first = (await svc.list({ limit: 100 })).rows[0]
  const queryResults = []
  for (let round=0;round<3;round++) for (const kind of ['list', 'detail', 'filter']) {
    queryResults.push({ kind, round, ...await timed(`query-${target}-${kind}-${round}`, async () => {
      const ms = [], start = performance.now(); let calls = 0
      while (performance.now() - start < 2000) {
        const t = performance.now()
        const result = kind === 'detail' ? await svc.detail(first.id) : await svc.list(kind === 'filter' ? { operation: 'benchmark.event', limit: 100 } : { limit: 100 })
        assert.ok(kind === 'detail' ? result.id === first.id : result.rows.length === 100)
        assert.ok(!JSON.stringify(result).includes(nonce)); ms.push(performance.now() - t); calls++
      }
      return { calls, elapsedMs: performance.now()-start, latencyMs: quantiles(ms) }
    }) })
  }
  const seen = new Set(), start = performance.now(); let cursor, pages = 0
  do { const r = await svc.list({limit:100, ...(cursor ? {cursor} : {})}); for (const row of r.rows) { assert.ok(!seen.has(row.id)); seen.add(row.id) }; cursor=r.nextCursor; pages++ } while (cursor)
  assert.equal(seen.size, target)
  return { target, rows, preparationMs, queries: queryResults, pagination: { rows: seen.size, pages, elapsedMs: performance.now()-start }, disk: disk() }
}
function quantiles(values) { values.sort((a,b)=>a-b); return Object.fromEntries([50,95,99].map(p=>['p'+p, values[Math.min(values.length-1,Math.ceil(values.length*p/100)-1)]])) }
async function action(command) {
  if (command.action === 'init') return { policy: await svc.policy(), defaults: LOG_DEFAULTS, payload: { smallBytes: Buffer.byteLength(JSON.stringify(safeLogEvent({ ...small, origin: { runtime: 'node', integration: 'application', capture: 'manual', execution: 'worker' } }))), largeBytes: Buffer.byteLength(JSON.stringify(projected)), sanitizedLarge: projected } }
  if (command.action === 'load') return timed(command.label, () => load(command))
  if (command.action === 'burst') return timed('burst', async () => { const before=svc.status(); for(let i=0;i<5000;i++) appLog(command.shape==='small'?small:large); const queued=svc.status(), start=performance.now(); await svc.flush(); return { before, queued, after:svc.status(), drainMs:performance.now()-start } })
  if (command.action === 'query') return queries(command.target)
  if (command.action === 'policy') return svc.policy()
  if (command.action === 'status') return { status:svc.status(), disk:disk(), rows:readRows() }
  if (command.action === 'graceful') { for(let i=0;i<1000;i++) appLog(small); const queued=svc.status(), t=performance.now(); await closeApplicationLogging(); return { queued, after:svc.status(), closeMs:performance.now()-t, persisted:readRows() } }
  if (command.action === 'kill-ready') { for(let i=0;i<100;i++) appLog(small); await svc.flush(); const persisted=readRows(); for(let i=0;i<1000;i++) appLog(small); return { persistedBeforeQueue: persisted, status:svc.status() } }
  if (command.action === 'retention') {
    for(let i=0;i<128;i++) appLog(small); await svc.flush()
    const db=new Database(dbPath); db.prepare("update log_events set timestamp='2000-01-01T00:00:00.000Z'").run(); db.close()
    const policy=await svc.policy(); return { policy, rows:readRows(), expiredHidden:(await svc.list({limit:100})).rows.length===0 }
  }
  if (command.action === 'close') { await closeApplicationLogging(); meter.close(); return { status:svc.status() } }
  throw Error('unknown benchmark command')
}
process.on('message', async command => {
  try { process.send?.({ id:command.id, result:await action(command) }) }
  catch(e) { process.send?.({ id:command.id, error:{ name:e.name, code:e.code ?? null, message:e.message } }) }
})
process.send?.({ ready:true })
