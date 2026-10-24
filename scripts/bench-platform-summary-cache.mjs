#!/usr/bin/env node
// Pass an OWN isolated, already migrated full-distribution copy. Read-only DB, loopback only.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir, cpus, totalmem } from 'node:os'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { setTimeout as sleep } from 'node:timers/promises'
import { forkOwnedChild as fork, reserveLoopbackPort, stopOwnedChild, waitForHttp } from './lib/isolated-local-services.mjs'

const [dbArg, outputArg] = process.argv.slice(2)
assert.ok(dbArg?.startsWith('/') && outputArg?.startsWith('/'), 'Absolute isolated DB and new JSON output required')
const dbPath = resolve(dbArg), temp = mkdtempSync(join(tmpdir(), 'summary-cache-bench-'))
const telemetry = join(temp, 'telemetry.mjs')
writeFileSync(telemetry, `import {channel} from 'node:diagnostics_channel';import {monitorEventLoopDelay} from 'node:perf_hooks';import {getHeapStatistics} from 'node:v8';
const lag=monitorEventLoopDelay({resolution:10});lag.enable();let heap=0,rss=0,cache=null;
function sample(){const m=process.memoryUsage();heap=Math.max(heap,m.heapUsed);rss=Math.max(rss,m.rss);return m}
setInterval(sample,5).unref();channel('ningbo.platform-summary-cache').subscribe(s=>{cache=s;sample()});
process.on('message',m=>{if(m?.op!=='metrics')return;if(m.gc)global.gc();const memory=sample();
process.send?.({op:'metrics',id:m.id,heapLimit:getHeapStatistics().heap_size_limit,heap,rss,memory,maxRss:process.resourceUsage().maxRSS*1024,loopP95:lag.percentile(95)/1e6,loopMax:lag.max/1e6,cache});
if(m.reset){heap=0;rss=0;lag.reset();sample()}});`)
const sha = value => createHash('sha256').update(value).digest('hex')
const percentile = (xs, p) => [...xs].sort((a, b) => a - b)[Math.ceil(xs.length * p) - 1]
let ipcId = 0, rpcId = 0, expected
function metrics(child, flags = {}) {
  const id = ++ipcId
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.off('message', listener); reject(Error('Missing telemetry')) }, 5000)
    const listener = m => { if (m?.op !== 'metrics' || m.id !== id) return; clearTimeout(timer); child.off('message', listener); resolve(m) }
    child.on('message', listener); child.send({ op: 'metrics', id, ...flags })
  })
}
const results = []
try {
  for (const transport of ['http', 'mcp']) for (const concurrency of [1, 2, 5]) for (const enabled of [false, true]) {
    const port = await reserveLoopbackPort(), base = `http://127.0.0.1:${port}`
    const child = fork('.output/server/index.mjs', [], {
      execArgv: ['--max-old-space-size=2048', '--expose-gc', '--import', telemetry],
      env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), NUXT_DB_PATH: dbPath, NUXT_DB_READONLY: '1', NUXT_PLATFORM_SUMMARY_CACHE: enabled ? '1' : '0', NUXT_FILES_DIR: temp, NUXT_INCOMING_DIR: temp, NUXT_API_TOKEN: '', NUXT_MCP_TOKEN: '', NUXT_OCR_TOKEN: '', NUXT_MIIT_COOKIE: '', MIIT_COOKIE: '', MIIT_COOKIE_FILE: '', PADDLEOCR_MCP_AISTUDIO_ACCESS_TOKEN: '' },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    })
    async function request(pageSize = 25) {
      const args = { view: 'summary', page: 1, pageSize }, start = performance.now()
      const response = transport === 'http'
        ? await fetch(`${base}/api/platform/queries?${new URLSearchParams(Object.entries(args).map(([k,v]) => [k,String(v)]))}`)
        : await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name: 'list_platform_queries', arguments: args } }) })
      const text = await response.text(), ms = performance.now() - start
      assert.equal(response.status, 200)
      assert.equal(response.headers.get('cache-control'), transport === 'mcp' ? 'no-store' : null)
      const envelope = JSON.parse(text.split('\n').find(s => s.startsWith('data: '))?.slice(6) ?? text)
      if (transport === 'mcp') assert.ok(!envelope.error && !envelope.result.isError)
      const result = transport === 'http' ? envelope : JSON.parse(envelope.result.content[0].text)
      assert.equal(result.rows.length, pageSize)
      const hash = sha(JSON.stringify(result))
      if (pageSize === 25) { expected ??= hash; assert.equal(hash, expected) }
      return { ms, responseBytes: Buffer.byteLength(text), hash }
    }
    try {
      await waitForHttp(`${base}/api/health`, { child })
      const startup = await metrics(child, { reset: true })
      const cold = await request(), hot = []
      for (let round = 0; round < 100; round += concurrency) hot.push(...await Promise.all(Array.from({ length: concurrency }, () => request())))
      await sleep(30)
      const interactive = await metrics(child)
      if (transport === 'http') {
        assert.equal(interactive.cache.misses, enabled ? 1 : 0)
        assert.equal(interactive.cache.hits, enabled ? 100 : 0)
      } else assert.equal(interactive.cache, null, 'MCP must never enter the REST cache')
      const row = { transport, concurrency, enabled, cold, hotN: hot.length, hot: { p50: percentile(hot.map(r=>r.ms), .5), p95: percentile(hot.map(r=>r.ms), .95), p99: percentile(hot.map(r=>r.ms), .99) }, startup, interactive }
      // One finite retention/TTL run; capacity eviction is tested separately with real SQLite.
      if (enabled && transport === 'http' && concurrency === 5) {
        await sleep(5100)
        row.expiredMiss = await request()
        assert.equal((await metrics(child)).cache.misses, 2)
        row.churn = []
        for (let cohort = 0; cohort < 4; cohort++) {
          for (let round = 0; round < 2000; round += 5) await Promise.all(Array.from({ length: 5 }, (_, n) => request(1 + (round + n) % 50)))
          const sample = await metrics(child, { gc: true })
          assert.ok(sample.cache.bytes <= 8 * 1024 * 1024 && sample.cache.entries <= 128 && sample.cache.sources <= 4)
          row.churn.push(sample)
          await sleep(1800)
        }
      }
      results.push(row)
      console.log(JSON.stringify({ transport, concurrency, enabled, cold: cold.ms, p95: row.hot.p95, interactiveLoopMax: interactive.loopMax }))
    } finally { await stopOwnedChild(child) }
  }
  writeFileSync(outputArg, JSON.stringify({ runAt: new Date().toISOString(), gitHead: execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(), gitDiffSha256: sha(execFileSync('git',['diff','HEAD'])), node: process.version, hardware: { cpu: cpus()[0].model, cores: cpus().length, memory: totalmem() }, heapMiB: 2048, containerLimited: false, osCachePurged: false, expectedResponseSha256: expected, results }, null, 2), { flag: 'wx', mode: 0o600 })
} finally { rmSync(temp, { recursive: true, force: true }) }
