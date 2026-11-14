#!/usr/bin/env node
// Local isolated copies only. No production URL or writes; default 2048MiB heap.
// node --max-old-space-size=2048 --expose-gc scripts/bench-enterprise-read.mjs <driver|http|mcp> /absolute/copy.sqlite <list|deep|search|detail> [concurrency=1] [hotSamples=20]
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { createHash } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { forkOwnedChild as fork, reserveLoopbackPort, stopOwnedChild } from './lib/isolated-local-services.mjs'
const [lane, dbPath, mode = 'list', concurrencyText = '1', countText = '20'] = process.argv.slice(2)
const concurrency = Number(concurrencyText), count = Number(countText)
assert.ok(['driver', 'http', 'mcp'].includes(lane) && dbPath?.startsWith('/') && ['list', 'deep', 'search', 'detail'].includes(mode) && [1, 2, 5].includes(concurrency))
const { createJiti } = createRequire(import.meta.resolve('nuxt/package.json'))('jiti')
// JSON object key order is not response semantics. Preserve array order while
// normalizing object keys before comparing HTTP/MCP results across versions.
const canonical = value => value && typeof value === 'object' ? Array.isArray(value)
  ? value.map(canonical) : Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value
const jiti = createJiti(import.meta.url)
const { useApplicationDb } = await jiti.import('../db/client.ts')
const db = useApplicationDb({ dbPath, readOnly: true })
const fixed = db.$client.prepare('select id, name from enterprise order by id limit 1').get()
const input = { page: mode === 'deep' ? 100 : 1, pageSize: 25, ...(mode === 'search' ? { q: fixed.name } : {}) }
const metrics = [], samples = []
let hotElapsedMs = 0
let sqlBytes = 0, sqlRows = 0, sqlQueries = 0, sqlMs = 0, peakHeap = 0, peakRss = 0
const memory = () => { const m = process.memoryUsage(); peakHeap = Math.max(peakHeap, m.heapUsed); peakRss = Math.max(peakRss, m.rss) }
const observe = row => {
  sqlRows++
  const visit = value => { if (value && typeof value === 'object') for (const v of Object.values(value)) visit(v); else sqlBytes += typeof value === 'string' ? Buffer.byteLength(value) : typeof value === 'number' ? 8 : 0 }
  visit(row); if (sqlRows % 256 === 0) memory()
}
if (lane === 'driver') {
  const prepare = db.$client.prepare.bind(db.$client)
  db.$client.prepare = (...args) => {
    const statement = prepare(...args)
    for (const method of ['get', 'all']) {
      const run = statement[method].bind(statement)
      statement[method] = (...params) => { sqlQueries++; const start = performance.now(); const out = run(...params); sqlMs += performance.now() - start; if (method === 'all') for (const row of out) observe(row); else if (out) observe(out); return out }
    }
    const iterate = statement.iterate.bind(statement)
    statement.iterate = function* (...params) { sqlQueries++; const iterator = iterate(...params); for (;;) { const start = performance.now(), next = iterator.next(); sqlMs += performance.now() - start; if (next.done) break; observe(next.value); yield next.value } }
    return statement
  }
  const { listRosterEnterprises, getRosterEnterpriseDetail } = await jiti.import('../lib/roster/enterprise-roster.ts')
  for (let i = 0; i <= count; i++) {
    global.gc?.(); sqlBytes = sqlRows = sqlMs = sqlQueries = peakHeap = peakRss = 0
    const before = process.memoryUsage().heapUsed, start = performance.now()
    const result = mode === 'detail' ? getRosterEnterpriseDetail(db, fixed.id) : listRosterEnterprises(db, input)
    const serializationStart = performance.now(), serialized = JSON.stringify(result), serializationMs = performance.now() - serializationStart
    memory()
    samples.push({ ms: performance.now() - start, sqlMs, serializationMs, sqlBytes, sqlRows, sqlQueries, responseBytes: Buffer.byteLength(serialized), peakHeap, incrementalHeap: peakHeap - before, peakRss })
  }
} else {
  const dir = mkdtempSync(join(tmpdir(), 'enterprise-read-telemetry-')), telemetry = join(dir, 'telemetry.mjs')
  writeFileSync(telemetry, `import dc from 'node:diagnostics_channel';import {monitorEventLoopDelay} from 'node:perf_hooks';
const lag=monitorEventLoopDelay({resolution:10});lag.enable();let heap=0,rss=0,workerHeap=0,workerRss=0,workerMaxRss=0,workerExternal=0,workerHeapLimit=0,combinedHeap=0,baseline=0,startup=null,appBase=0,appPeak=0,workerBase=Infinity,readPeak=0,workerReadyBase=0,workerRetainedGrowth=0,readIncrement=0;
const sample=()=>{const m=process.memoryUsage();heap=Math.max(heap,m.heapUsed);rss=Math.max(rss,m.rss+workerRss);combinedHeap=Math.max(combinedHeap,m.heapUsed+workerHeap);appPeak=Math.max(appPeak,m.heapUsed);return m};
setInterval(sample,5).unref();
dc.channel('ningbo.enterprise-read').subscribe(s=>{workerHeap=s.workerHeap;workerRss=s.workerRss??workerRss;workerMaxRss=Math.max(workerMaxRss,s.maxRss??0);workerExternal=s.external??workerExternal;workerHeapLimit=s.heapLimit??workerHeapLimit;sample();if(s.phase==='ready')process.send?.({kind:'ready',...s});if(s.phase==='result'){workerBase=Math.min(workerBase,s.beforeHeap);readPeak=Math.max(readPeak,s.heap);readIncrement=Math.max(readIncrement,s.heap-s.beforeHeap);workerRetainedGrowth=Math.max(workerRetainedGrowth,s.beforeHeap-workerReadyBase);process.send?.({kind:'worker',...s,combinedHeap:s.applicationHeap+s.workerHeap})}});
dc.channel('http.server.response.finish').subscribe(({request})=>{const m=sample();if(request.url==='/api/health'){startup={lagP95Ms:lag.percentile(95)/1e6,lagMaxMs:lag.max/1e6,heap,rss,workerHeap,combinedHeap};appBase=m.heapUsed;appPeak=appBase;workerReadyBase=workerHeap;baseline=m.heapUsed+workerHeap;combinedHeap=baseline;lag.reset();process.send?.({kind:'baseline',baseline,startup});return}
if(request.url.startsWith('/api/roster/enterprises')||request.url==='/mcp')process.send?.({kind:'response',heap,rss,workerHeap,combinedHeap,incrementalCombinedHeap:combinedHeap-baseline,conservativeComponentDelta:Math.max(0,appPeak-appBase)+Math.max(0,readIncrement)+Math.max(0,workerRetainedGrowth),appBase,appPeak,workerBase,readPeak,workerReadyBase,readIncrement,workerRetainedGrowth,external:m.external+workerExternal,arrayBuffers:m.arrayBuffers,workerHeapLimit,maxRss:process.resourceUsage().maxRSS*1024+workerMaxRss,lagP95Ms:lag.percentile(95)/1e6,lagMaxMs:lag.max/1e6})});`)

  const port = await reserveLoopbackPort(), base = `http://127.0.0.1:${port}`
  const server = fork(process.env.ENTERPRISE_BENCH_SERVER_ENTRY ?? '.output/server/index.mjs', [], { execArgv: [...(process.env.ENTERPRISE_BENCH_HEAP === 'default' ? [] : ['--max-old-space-size=2048']), '--import', telemetry], env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', NUXT_DB_PATH: dbPath, NUXT_DB_READONLY: '1', NUXT_FILES_DIR: dir, MIIT_COOKIE: '', MIIT_COOKIE_FILE: '' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  let output = '', rpcId = 0
  for (const stream of [server.stdout, server.stderr]) stream.on('data', data => { output = (output + data).slice(-2000) })
  server.on('message', message => metrics.push(message))
  async function request() {
    const start = performance.now()
    const response = lane === 'http' ? await fetch(`${base}/api/roster/enterprises${mode === 'detail' ? `/${fixed.id}` : `?${new URLSearchParams(input)}`}`) : await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name: mode === 'detail' ? 'get_enterprise_detail' : 'list_enterprises', arguments: mode === 'detail' ? { enterpriseId: fixed.id } : input } }) })
    const text = await response.text(), ms = performance.now() - start
    assert.equal(response.status, 200)
    const body = JSON.parse(text.split('\n').find(line => line.startsWith('data: '))?.slice(6) ?? text)
    const result = lane === 'http' ? body : JSON.parse(body.result.content[0].text)
    if (mode === 'detail') assert.equal(result.enterprise.enterpriseId, fixed.id)
    else assert.ok(result.rows.length > 0 && result.rows.length <= 25)
    return { ms, responseBytes: Buffer.byteLength(text), resultSha256: createHash('sha256').update(JSON.stringify(canonical(result))).digest('hex') }
  }
  try {
    let ready = false
    for (let i = 0; i < 200; i++) { if (server.exitCode !== null) throw Error(output); try { ready = (await fetch(`${base}/api/health`)).ok } catch {} if (ready) break; await sleep(100) }
    assert.ok(ready, 'local artifact readiness')
    samples.push(await request())
    const hotStart = performance.now()
    for (let i = 0; i < count; i += concurrency) samples.push(...await Promise.all(Array.from({ length: Math.min(concurrency, count - i) }, request)))
    hotElapsedMs = performance.now() - hotStart
    await sleep(20)
  } finally { await stopOwnedChild(server); rmSync(dir, { recursive: true, force: true }) }
}
const sorted = samples.slice(1).map(x => x.ms).sort((a, b) => a - b), percentile = p => sorted[Math.ceil(sorted.length * p) - 1]
console.log(JSON.stringify({ gitHead: execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(), gitDiffSha256: createHash('sha256').update(execFileSync('git',['diff','HEAD'])).digest('hex'), lane, mode, concurrency, input: mode === 'detail' ? { enterpriseId: fixed.id } : mode === 'search' ? { ...input, q: undefined, qSha256: createHash('sha256').update(input.q).digest('hex') } : input, coldLabel: 'fresh process; OS cache not purged', cold: samples[0], hotSamples: sorted.length, hotElapsedMs, throughputPerSecond: hotElapsedMs ? sorted.length*1000/hotElapsedMs : null, hot: { p50: percentile(.5), p95: percentile(.95), p99: percentile(.99) }, samples, metrics, heapOldSpaceMiB: process.env.ENTERPRISE_BENCH_HEAP === 'default' ? 'default' : 2048, separateNativeProcess: true, containerLimited: false }))
db.$client.close()
