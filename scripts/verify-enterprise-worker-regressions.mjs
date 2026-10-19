#!/usr/bin/env node
// Compiled public protocols, isolated synthetic SQLite. No existing application DB.
// Run after pnpm build. Optional modes: large | disconnect | fatal | all (default).
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fork, execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { get } from 'node:http'
import { createHash } from 'node:crypto'
import { setTimeout as pause } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { reserveLoopbackPort, waitForHttp, stopOwnedChild } from './lib/isolated-local-services.mjs'

const root = process.cwd(), mode = process.argv[2] ?? 'all'
assert.ok(['large', 'disconnect', 'fatal', 'all'].includes(mode))
if (mode === 'all') {
  for (const lane of ['large', 'disconnect', 'fatal']) execFileSync(process.execPath, [fileURLToPath(import.meta.url), lane], { stdio: 'inherit' })
  process.exit(0)
}
const { createJiti } = createRequire(import.meta.resolve('nuxt/package.json'))('jiti')
const { useDb, schema: s } = await createJiti(import.meta.url).import('../db/client.ts')
const dir = mkdtempSync(join(tmpdir(), 'enterprise-r2-')), path = join(dir, 'synthetic.db')
const db = useDb({ dbPath: path, migrationsFolder: resolve('db/migrations') })
const id = db.insert(s.enterprise).values({ name: '合成原文企业', nameNorm: '合成原文企业' }).returning().get().id
const query = db.insert(s.platformQuery).values({ interface: 'recognized_list', queryKey: 'name:合成原文企业', queriedAt: '2026-10-19', status: 'partial' }).returning().get()
const size = 96 * 1024 * 1024
// Small fixtures for lifecycle modes; no JS allocation of large setup strings.
const rawSize = mode === 'large' || mode === 'all' ? size : 32
const relation = db.$client.prepare("insert into platform_relation(query_id,sequence_no,enterprise_id,created_at,raw_fields) values(?,1,null,'2026-10-19',json_object('original',replace(hex(zeroblob(?)),'00','x'))) returning id").get(query.id, rawSize)
db.$client.close()
const expectedHash = rawSize === size ? '9aa21bac45c5b07fafeef4a1920f240f3766ab323161abc95f2a18ca385c64cb' : createHash('sha256').update('x'.repeat(rawSize)).digest('hex')

const childHook = join(dir, 'child-observer.mjs'), mainHook = join(dir, 'main-observer.mjs')
writeFileSync(childHook, `import{getHeapStatistics}from'node:v8';
setInterval(()=>process.send?.({type:'telemetry',...process.memoryUsage(),heapLimit:getHeapStatistics().heap_size_limit}),5).unref();
if(process.env.R2_FATAL==='1')process.once('message',()=>{const held=[];for(;;)held.push(new Array(100000).fill(1))});`)
// Delay the actual emitted entry import, never replace a reader, route or SQL.
writeFileSync(mainHook, `import cp from'node:child_process';import{syncBuiltinESMExports}from'node:module';import dc from'node:diagnostics_channel';import{pathToFileURL}from'node:url';import{getHeapStatistics}from'node:v8';
const original=cp.spawn;let launches=0,childMemory={heapUsed:0,rss:0,external:0,arrayBuffers:0};
let peakHeap=0,peakRss=0,peakExternal=0,base=0,appBase=0,appPeak=0,readIncrement=0;
const sample=()=>{const m=process.memoryUsage();appPeak=Math.max(appPeak,m.heapUsed);peakHeap=Math.max(peakHeap,m.heapUsed+childMemory.heapUsed);peakRss=Math.max(peakRss,m.rss+childMemory.rss);peakExternal=Math.max(peakExternal,m.external+childMemory.external)};
setInterval(sample,2).unref();
cp.spawn=function(exe,args,options){if(!args.some(x=>x.endsWith('enterprise-read-worker.mjs')))return original.call(this,exe,args,options);
const count=++launches,entry=args.at(-1);args=args.slice(0,-1);args.push('--import',${JSON.stringify(childHook)});
if(process.env.R2_DELAY==='1')args.push('--input-type=module','--eval','await new Promise(r=>setTimeout(r,1000));await import('+JSON.stringify(pathToFileURL(entry).href)+')');else args.push(entry);
const child=original.call(this,exe,args,{...options,env:{...process.env,R2_FATAL:process.env.R2_FAULT==='1'&&count===1?'1':'0'}});
child.on('message',m=>{if(m.type==='telemetry'){childMemory=m;sample()}if(m.type==='ready')process.send?.({kind:'ready',count,heapLimit:m.heapLimit,execArgv:m.execArgv,pid:m.pid,applicationHeapLimit:getHeapStatistics().heap_size_limit})});
child.on('exit',(code,signal)=>process.send?.({kind:'nativeExit',code,signal,count}));return child};syncBuiltinESMExports();
let starts=0,closes=0;dc.channel('http.server.request.start').subscribe(({request,response})=>{if(request.url.includes('enterprises')){process.send?.({kind:'start',starts:++starts});response.once('close',()=>process.send?.({kind:'close',closes:++closes}))}});
dc.channel('ningbo.enterprise-read').subscribe(m=>{if(m.phase==='result'){readIncrement=Math.max(readIncrement,m.heap-m.beforeHeap);peakHeap=Math.max(peakHeap,m.applicationHeap+m.heap);peakRss=Math.max(peakRss,process.memoryUsage().rss+m.rss);process.send?.({kind:'result',...m})}});
dc.channel('http.server.response.finish').subscribe(({request})=>{sample();if(request.url==='/api/health'&&!base){appBase=appPeak=process.memoryUsage().heapUsed;base=appBase+childMemory.heapUsed;peakHeap=base;peakRss=0;peakExternal=0}else process.send?.({kind:'memory',base,peakHeap,increment:peakHeap-base,conservativeComponentDelta:Math.max(0,appPeak-appBase)+readIncrement,peakRss,peakExternal})});`)

async function run(testName, heap) {
  const port = await reserveLoopbackPort(), base = `http://127.0.0.1:${port}`, events = []
  const flags = heap === 'default' ? [] : ['--max-old-space-size=2048']
  const child = fork(resolve('.output/server/index.mjs'), [], { cwd: dir, execArgv: [...flags, '--import', mainHook],
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', NUXT_DB_PATH: path, NUXT_DB_READONLY: '1', NUXT_FILES_DIR: dir, MIIT_COOKIE: '', MIIT_COOKIE_FILE: '', R2_DELAY: testName === 'early disconnect' ? '1' : '0', R2_FAULT: testName === 'fatal allocation' ? '1' : '0' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  let output = ''
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { output = (output + data).slice(-16000) })
  child.on('message', message => events.push(message))
  async function until(predicate) {
    const deadline = performance.now() + 5000
    while (!predicate()) { assert.equal(child.exitCode, null, output); assert.ok(performance.now() < deadline, output); await pause(5) }
  }
  const detailPath = `/api/roster/enterprises/${id}`
  async function rpc(name, args) {
    const response = await fetch(base + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) })
    assert.equal(response.status, 200)
    const text = await response.text(), envelope = JSON.parse(text.split('\n').find(line => line.startsWith('data: '))?.slice(6) ?? text)
    assert.ok(!envelope.error && !envelope.result.isError, text.slice(0, 1000))
    return JSON.parse(envelope.result.content[0].text)
  }
  try {
    if (testName === 'early disconnect') {
      await until(() => output.includes('Listening'))
      const clients = Array.from({ length: 17 }, () => { const req = get(base + '/api/roster/enterprises'); req.on('error', () => {}); return req })
      try { await until(() => events.some(e => e.kind === 'start' && e.starts === 17)) } finally { clients.forEach(req => req.destroy()) }
      await until(() => events.some(e => e.kind === 'ready'))
      const readyAt = events.findIndex(e => e.kind === 'ready')
      assert.equal(events.slice(0, readyAt).filter(e => e.kind === 'close').length, 17, 'all disconnects must precede actual module readiness')
      await pause(400)
      assert.equal(events.filter(e => e.kind === 'result').length, 0, 'already disconnected requests must not execute reads')
    } else await waitForHttp(base + '/api/health', { child, timeoutMs: 20000 })
    if (testName === 'fatal allocation') {
      assert.equal((await fetch(base + detailPath)).status, 503)
      assert.ok(events.some(e => e.kind === 'nativeExit' && e.signal === 'SIGABRT'), 'actual child V8 fatal allocation')
      assert.match(output, /FATAL ERROR:.*heap/)
      assert.equal((await fetch(base + '/api/health')).status, 200)
    }
    const reads = testName === 'large raw' ? 3 : 1
    for (let round = 0; round < reads; round++) {
      const response = await fetch(base + detailPath)
      assert.equal(response.status, 200, output)
      const value = await response.json(), raw = value.platform.relations[0].rawFields.original
      assert.equal(value.platform.relations.length, 1)
      assert.equal(value.platform.relations[0].id, relation.id)
      assert.equal(value.platform.relations[0].enterpriseId, null)
      assert.equal(raw.length, rawSize)
      assert.equal(createHash('sha256').update(raw).digest('hex'), expectedHash)
      assert.equal((await fetch(base + '/api/health')).status, 200)
      assert.equal((await fetch(base + '/api/roster/enterprises')).status, 200)
    }
    if (testName !== 'large raw') {
      assert.equal((await rpc('list_enterprises', {})).counts.total, 1)
      assert.equal((await rpc('get_enterprise_detail', { enterpriseId: id })).enterprise.enterpriseId, id)
    }
    await pause(20)
    const ready = events.filter(e => e.kind === 'ready')
    assert.ok(ready.length >= 1)
    assert.ok(ready.every(e => e.heapLimit === 318767104), JSON.stringify(ready))
    if (testName === 'large raw') assert.equal(ready.length, 1, 'repeated reads must reuse the same healthy executor')
    const memories = events.filter(e => e.kind === 'memory')
    const result = { testName, heap, reads, rawBytes: rawSize, rawHash: expectedHash, cwdIndependent: true, ready,
      peakCombinedHeap: Math.max(...memories.map(e => e.peakHeap)), increment: Math.max(...memories.map(e => e.increment)), conservativeComponentDelta: Math.max(...memories.map(e => e.conservativeComponentDelta)), peakCombinedRss: Math.max(...memories.map(e => e.peakRss)), peakCombinedExternal: Math.max(...memories.map(e => e.peakExternal)), ...(testName === 'fatal allocation' ? { fatalOutput: output } : {}), events }
    if (testName === 'large raw') assert.ok(Math.max(result.increment, result.conservativeComponentDelta) <= 2 * rawSize + 64 * 1024 * 1024, `raw heap budget: ${result.increment}/${result.conservativeComponentDelta}`)
    assert.ok(result.peakCombinedHeap < 1.8 * 1024 ** 3)
    assert.ok(result.peakCombinedRss < 3 * 1024 ** 3)
    console.log(JSON.stringify(result))
  } finally { await stopOwnedChild(child) }
}
try {
  console.log(JSON.stringify({ source: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), diffSha256: createHash('sha256').update(execFileSync('git', ['diff', 'HEAD'])).digest('hex'), node: process.version, platform: process.platform, arch: process.arch }))
  for (const heap of ['default', '2048']) {
    if (mode === 'large' || mode === 'all') await run('large raw', heap)
    if (mode === 'disconnect' || mode === 'all') await run('early disconnect', heap)
    if (mode === 'fatal' || mode === 'all') await run('fatal allocation', heap)
  }
} finally { rmSync(dir, { recursive: true, force: true }) }
