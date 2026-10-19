#!/usr/bin/env node
// Real local production HTTP/MCP, read-only BEFORE/AFTER copies from bench-sqlite-indexes.mjs.
// Never writes business rows, contacts external platforms or prints business payloads/selectors.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync, fork } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, realpathSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { setTimeout as sleep } from 'node:timers/promises'
import Database from 'better-sqlite3'
import { reserveLoopbackPort, stopOwnedChild, waitForHttp } from './lib/isolated-local-services.mjs'
const [directory] = process.argv.slice(2)
assert.ok(directory?.startsWith('/'), 'Use the absolute private benchmark output directory')
const dir = realpathSync(directory)
assert.equal(JSON.parse(readFileSync(join(dir, 'summary.json'))).allRowsAndUniqueDefinitionsPreserved, true)
const db = new Database(join(dir, 'before.sqlite'), { readonly: true, fileMustExist: true })
const query = db.prepare('select id,query_key from platform_query order by length(cast(raw_response as blob)) desc limit 1').get()
const uscc = db.prepare('select uscc_raw value from platform_relation where uscc_raw is not null order by id limit 1').get().value
const enterpriseId = db.prepare('select enterprise_id value from platform_relation where enterprise_id is not null order by id limit 1').get().value
const count = db.prepare('select count(*) n from platform_query').get().n
db.close()
const cases = [
  ['summary', { view: 'summary', pageSize: 25 }], ['deep', { view: 'summary', pageSize: 25, page: Math.max(1, Math.floor(count / 25)) }],
  ['status', { view: 'summary', status: 'failed' }], ['interface', { view: 'summary', interface: 'recognized_list' }],
  ['uscc', { view: 'summary', uscc }], ['enterprise', { view: 'summary', enterpriseId }],
  ['key', { view: 'summary', queryKey: query.query_key }], ['title', { view: 'summary', titleCode: 'specialized_sme' }],
  ['full', {}], ['exact', { queryId: query.id, pageSize: 1, includeRawResponse: true }],
  ['chunk', { queryId: query.id, field: 'rawResponse', offset: 0, length: 65536 }],
  ['missing', { queryId: 2147483647, view: 'summary' }],
]
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const temp = mkdtempSync(join(tmpdir(), 'sqlite-index-http-'))
const telemetry = join(temp, 'telemetry.mjs')
writeFileSync(telemetry, `import dc from 'node:diagnostics_channel';import {monitorEventLoopDelay} from 'node:perf_hooks';
const lag=monitorEventLoopDelay({resolution:10});lag.enable();let heap=0,rss=0;const sample=()=>{const m=process.memoryUsage();heap=Math.max(heap,m.heapUsed);rss=Math.max(rss,m.rss)};setInterval(sample,5).unref();
dc.channel('http.server.response.finish').subscribe(()=>{sample();process.send?.({heap,rss,maxRss:process.resourceUsage().maxRSS*1024,lagP95Ms:lag.percentile(95)/1e6,lagMaxMs:lag.max/1e6})});`)
const results = [], expected = new Map()
const percentile = (xs, p) => [...xs].sort((a, b) => a - b)[Math.ceil(xs.length * p) - 1]
try {
  for (const transport of ['http', 'mcp']) for (const concurrency of [1, 2, 5]) for (const phase of ['before', 'after']) {
    const port = await reserveLoopbackPort(), base = `http://127.0.0.1:${port}`, metrics = []
    const child = fork('.output/server/index.mjs', [], { execArgv: ['--max-old-space-size=2048', '--import', telemetry], env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), NUXT_DB_PATH: join(dir, `${phase}.sqlite`), NUXT_DB_READONLY: '1', NUXT_FILES_DIR: temp, NUXT_API_TOKEN: 'synthetic-only', NUXT_MCP_TOKEN: 'synthetic-only', MIIT_COOKIE: '', MIIT_COOKIE_FILE: '' }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
    child.on('message', m => metrics.push(m))
    let errors = ''; child.stderr.on('data', b => { errors = (errors + b).slice(-1000) })
    let rpcId = 0
    async function request(name, args) {
      const chunk = name === 'chunk', start = performance.now()
      const response = transport === 'http'
        ? await fetch(`${base}${chunk ? `/api/platform/queries/${query.id}/evidence` : '/api/platform/queries'}?${new URLSearchParams(Object.entries(args).filter(([k]) => !chunk || k !== 'queryId').map(([k, v]) => [k, String(v)]))}`)
        : await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name: chunk ? 'get_platform_query_evidence' : 'list_platform_queries', arguments: args } }) })
      const body = await response.text(), ms = performance.now() - start
      assert.equal(response.status, 200, `${phase}/${transport}/${name} HTTP status`)
      const envelope = JSON.parse(body.split('\n').find(s => s.startsWith('data: '))?.slice(6) ?? body)
      if (transport === 'mcp') { assert.ok(!envelope.error && !envelope.result.isError, `${phase}/${name} MCP error`) }
      const result = transport === 'http' ? envelope : JSON.parse(envelope.result.content[0].text)
      const hash = digest(result)
      if (!expected.has(name)) expected.set(name, hash)
      assert.equal(hash, expected.get(name), `${phase}/${transport}/${name} full external response semantics`)
      return { ms, responseBytes: Buffer.byteLength(body), resultSha256: hash }
    }
    try {
      await waitForHttp(`${base}/api/health`, { child })
      const cold = await request(...cases[0])
      const hot = []
      for (let round = 0; round < 20; round += concurrency) hot.push(...await Promise.all(Array.from({ length: concurrency }, () => request(...cases[0]))))
      // Full filter/error/raw semantics once per protocol/phase; avoid repeating expensive cases without new information.
      const equivalence = []
      if (concurrency === 1) for (const [name, args] of cases.slice(1)) equivalence.push({ name, ...await request(name, args) })
      await sleep(30)
      assert.ok(metrics.length, 'Missing production-process telemetry')
      results.push({ phase, transport, concurrency, coldLabel: 'fresh Node process; copied DB/OS caches already warmed by integrity/read probes', cold, hotN: hot.length, hot: { p50: percentile(hot.map(x => x.ms), .5), p95: percentile(hot.map(x => x.ms), .95), p99: percentile(hot.map(x => x.ms), .99) }, peakHeap: Math.max(...metrics.map(m => m.heap)), peakRss: Math.max(...metrics.map(m => m.rss)), osPeakRss: Math.max(...metrics.map(m => m.maxRss)), eventLoopP95Ms: Math.max(...metrics.map(m => m.lagP95Ms)), eventLoopMaxMs: Math.max(...metrics.map(m => m.lagMaxMs)), equivalence })
      console.log(JSON.stringify({ phase, transport, concurrency, coldMs: cold.ms, hotP95: results.at(-1).hot.p95 }))
    } catch (e) { throw new Error(`${phase}/${transport}/${concurrency}: ${e.message}; server=${errors}`, { cause: e }) }
    finally { await stopOwnedChild(child) }
  }
  writeFileSync(join(dir, 'http-mcp.json'), JSON.stringify({ gitHead: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), runAt: new Date().toISOString(), lane: 'local compiled Nitro HTTP and MCP tools/call, full distribution copies, no container limits', samples: results, responseHashes: Object.fromEntries(expected), allEquivalent: true }, null, 2), { mode: 0o600 })
} finally { rmSync(temp, { recursive: true, force: true }) }
