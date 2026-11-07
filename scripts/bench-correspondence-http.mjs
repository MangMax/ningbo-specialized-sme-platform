#!/usr/bin/env node
/** Compiled Nitro REST/MCP #85 read benchmark. Local isolated copies only.
 * node scripts/bench-correspondence-http.mjs /absolute/scratch.db <http|mcp> <list|deep|point|event|relation|audit|candidates> [concurrency=1] [rounds=20]
 * IDs default to the synthetic benchmark fixture; override CORRESPONDENCE_BENCH_IDS with a private JSON file.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { setTimeout as sleep } from 'node:timers/promises'
import { forkOwnedChild as fork, reserveLoopbackPort, stopOwnedChild, getOwnedChildStartFailure } from './lib/isolated-local-services.mjs'
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value
const [dbPath, transport = 'http', mode = 'list', c = '1', n = '20'] = process.argv.slice(2)
const concurrency = Number(c), rounds = Number(n)
assert.ok(dbPath?.startsWith('/') && !dbPath.includes('full-snapshot') && ['http', 'mcp'].includes(transport) && [1, 2, 5].includes(concurrency) && Number.isInteger(rounds) && rounds > 0)
const ids = process.env.CORRESPONDENCE_BENCH_IDS ? JSON.parse(readFileSync(process.env.CORRESPONDENCE_BENCH_IDS, 'utf8')) : { correspondenceId: 1, eventId: 1, relationId: 1, queryId: 1 }
const root = '/api/roster/correspondences'
const modes = {
  list: { path: root, tool: 'list_record_correspondences', args: { page: 1, pageSize: 25 } },
  deep: { path: root, tool: 'list_record_correspondences', args: { page: 300, pageSize: 1 } },
  point: { path: `${root}/${ids.correspondenceId}`, tool: 'get_record_correspondence', args: { id: ids.correspondenceId } },
  event: { path: `${root}/events/${ids.eventId}`, tool: 'get_record_correspondence_source', args: { kind: 'event', id: ids.eventId } },
  relation: { path: `${root}/relations/${ids.relationId}`, tool: 'get_record_correspondence_source', args: { kind: 'relation', id: ids.relationId } },
  audit: { path: `${root}/${ids.correspondenceId}/audit`, tool: 'get_record_correspondence_audit', args: { id: ids.correspondenceId, page: 400, pageSize: 1 } },
  candidates: { path: `${root}/candidates`, tool: 'find_record_correspondence_candidates', args: { eventId: ids.eventId, queryIds: [ids.queryId], exportBatchIds: [], ruleVersion: '1', page: 1, pageSize: 50 } },
}
assert.ok(modes[mode])

let dir,server,db,receipt,startFailure,primaryError
let forkAttempted=false
const cleanupErrors=[],childErrors=[]
const onError=error=>{if(childErrors.length<32)childErrors.push(error)}
function listen(child){
 child.on('error',onError)
 for(const stream of new Set(child.stdio ?? []))stream?.on?.('error',onError)
 // Drain partial handles as well; a failed acquisition never enters measurement.
 if(startFailure)for(const stream of [child.stdout,child.stderr])stream?.resume()
}
async function readResponse(url,options={},timeoutMs=5_000){
 const controller=new AbortController()
 const timer=setTimeout(()=>controller.abort(new Error('HTTP headers/body deadline exceeded')),timeoutMs)
 try{const response=await fetch(url,{...options,signal:controller.signal});const text=await response.text();return {response,text}}
 finally{clearTimeout(timer)}
}
try {
dir = mkdtempSync(join(tmpdir(), 'correspondence-http-85-'));const telemetry = join(dir, 'telemetry.mjs')
writeFileSync(telemetry, `import dc from 'node:diagnostics_channel';import {monitorEventLoopDelay} from 'node:perf_hooks';import {getHeapStatistics} from 'node:v8';
const lag=monitorEventLoopDelay({resolution:10});lag.enable();let heap=0,rss=0,baseHeap=0,started=false;
const sample=()=>{const m=process.memoryUsage();heap=Math.max(heap,m.heapUsed);rss=Math.max(rss,m.rss);if(!baseHeap)baseHeap=m.heapUsed};setInterval(sample,5).unref();
dc.channel('http.server.request.start').subscribe(({request})=>{if(!started&&(request.url.startsWith('/api/roster/correspondences')||request.url==='/mcp')){started=true;lag.reset();baseHeap=process.memoryUsage().heapUsed;heap=baseHeap;rss=0}});
dc.channel('http.server.response.finish').subscribe(({request})=>{sample();if(request.url.startsWith('/api/roster/correspondences')||request.url==='/mcp')process.send?.({heap,rss,baseHeap,maxRss:process.resourceUsage().maxRSS*1024,heapLimit:getHeapStatistics().heap_size_limit,lagP95Ms:lag.percentile(95)/1e6,lagMaxMs:lag.max/1e6})});`)
const port = await reserveLoopbackPort(), base = `http://127.0.0.1:${port}`, metrics = []
forkAttempted=true
try { server = fork('.output/server/index.mjs', [], { execArgv: ['--max-old-space-size=2048', '--import', telemetry], env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', NUXT_DB_PATH: dbPath, NUXT_DB_READONLY: '1', NUXT_FILES_DIR: dir, NUXT_MIIT_COOKIE: '', MIIT_COOKIE: '', MIIT_COOKIE_FILE: '' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
} catch(error) {
 startFailure=getOwnedChildStartFailure(error)
 if(startFailure){
  server=startFailure.child
  try{listen(server)}catch(listenError){cleanupErrors.push(new Error('Partial child listener/drain failed',{cause:listenError}))}
 }
 throw error
}
listen(server)
let output = '', rpcId = 0
for (const stream of [server.stdout, server.stderr]) stream.on('data', b => { output = (output + b).slice(-2000) })
server.on('message', message => metrics.push(message))
async function request(which = transport) {
  const { path, tool, args } = modes[mode], start = performance.now(), post = mode === 'candidates'
  const query = Object.fromEntries(Object.entries(args).filter(([k]) => !['id', 'kind'].includes(k)))
  const response = which === 'http'
    ? await readResponse(base + path + (post ? '' : '?' + new URLSearchParams(query)), { ...(post ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(args) } : {}) })
    : await readResponse(base + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name: tool, arguments: args } }) })
  const raw = response.text, ms = performance.now() - start
  assert.equal(response.response.status, 200)
  const body = JSON.parse(raw.split('\n').find(s => s.startsWith('data: '))?.slice(6) ?? raw)
  if (which === 'mcp') assert.ok(!body.error && !body.result.isError, 'MCP tool must succeed')
  const result = which === 'http' ? body : JSON.parse(body.result.content[0].text)
  if (which === 'http') assert.equal(response.response.headers.get('cache-control'), 'no-store')
  const hash = createHash('sha256').update(JSON.stringify(canonical(result))).digest('hex')
  return { ms, responseBytes: Buffer.byteLength(raw), hash }
}
 const readyDeadline=performance.now()+12_000
 let ready=false,lastReadyError
 while(performance.now()<readyDeadline){
  if(childErrors.length)throw childErrors[0]
  if(server.exitCode!==null || server.signalCode!==null)throw Error(output)
  try{ready=(await readResponse(base+'/api/health',{},Math.min(2000,Math.max(1,readyDeadline-performance.now())))).response.ok}catch(error){lastReadyError=error}
  if(ready)break
  await sleep(Math.min(100,Math.max(0,readyDeadline-performance.now())))
 }
 assert.ok(ready,`compiled readiness: ${lastReadyError?.message ?? output}`)
  const cold = await request(), parity = await request(transport === 'http' ? 'mcp' : 'http')
  assert.equal(cold.hash, parity.hash, 'REST/MCP exact semantic parity')
  const hot = []
  for (let i = 0; i < rounds; i += concurrency) hot.push(...await Promise.all(Array.from({ length: Math.min(concurrency, rounds - i) }, () => request())))
  assert.ok(hot.every(s => s.hash === cold.hash))
  await sleep(20); assert.ok(metrics.length, 'missing server telemetry')
  const sorted = hot.map(s => s.ms).sort((a, b) => a - b), p = x => sorted[Math.ceil(x * sorted.length) - 1]
  // Historical field retained; the checkout HEAD does not certify the compiled artifact.
  receipt=({ sourceHead: null, transport, mode, concurrency, coldLabel: 'fresh compiled server process; OS cache not purged', cold, hotSamples: hot.length, hot: { p50: p(.5), p95: p(.95), p99: p(.99) }, responseBytes: hot[0].responseBytes, peakHeap: Math.max(...metrics.map(m => m.heap)), incrementalHeap: Math.max(...metrics.map(m => m.heap - m.baseHeap)), peakRss: Math.max(...metrics.map(m => m.rss)), osPeakRss: Math.max(...metrics.map(m => m.maxRss)), eventLoopP95Ms: Math.max(...metrics.map(m => m.lagP95Ms)), eventLoopMaxMs: Math.max(...metrics.map(m => m.lagMaxMs)), heapLimit: metrics[0].heapLimit, responseSha256: cold.hash })
} catch(error){primaryError=error}
finally {
 if(db)try{db.close()}catch(error){cleanupErrors.push(new Error('Initial readonly DB close failed',{cause:error}))}
 let confirmed=!forkAttempted,stopState=forkAttempted?'unknown acquisition':'not-acquired'
 if(server)try{await stopOwnedChild(server);confirmed=true;stopState='resolved'}
 catch(error){
  cleanupErrors.push(new Error('Public stop failed',{cause:error}))
  const result=error?.stopResult
  const known=result?.brand==='isolated-local-services.stop' && result.version===1
  confirmed=known && result.termination==='confirmed'
  stopState=known?JSON.stringify(result):'unknown stop receipt'
 }
 if(!confirmed){
  cleanupErrors.push(new Error(`UNCONFIRMED owned service pid=${server?.pid ?? 'unknown'}; root retained at ${dir}; start=${startFailure?.reason ?? 'unknown'}; state=${stopState}`))
  if(server){
   const releases=[...[...new Set(server.stdio ?? [])].filter(s=>typeof s?.destroy==='function').map(s=>()=>s.destroy()),()=>{if(server.connected)server.disconnect()},()=>server.unref()]
   for(const release of releases)try{release()}catch(error){cleanupErrors.push(new Error('Caller handle release failed',{cause:error}))}
  }
 }
 if(dir && confirmed)try{rmSync(dir,{recursive:true,force:true})}catch(error){cleanupErrors.push(new Error(`Private root cleanup failed; retained at ${dir}`,{cause:error}))}
 await new Promise(resolve=>setImmediate(resolve))
 for(const error of new Set([...childErrors,...(startFailure?.errors ?? [])]))cleanupErrors.push(new Error('Owned child asynchronous error',{cause:error}))
 if(startFailure?.droppedErrors)cleanupErrors.push(new Error(`Owned child droppedErrors=${startFailure.droppedErrors}`))
 if(server){server.off('error',onError);for(const stream of new Set(server.stdio ?? []))stream?.off?.('error',onError)}
}
if(primaryError || cleanupErrors.length)throw new AggregateError([...(primaryError?[primaryError]:[]),...cleanupErrors],'Benchmark failed (primary/DB/stop/root diagnostics retained)',{cause:primaryError})
console.log(JSON.stringify(receipt))
