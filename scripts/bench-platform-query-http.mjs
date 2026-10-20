#!/usr/bin/env node
// Production artifact, real HTTP/MCP, synthetic read-only SQLite. Does not build or contact production.
// node scripts/bench-platform-query-http.mjs /absolute/synthetic.sqlite <http|mcp> <full|summary|interface|title|key|chunk> [concurrency=1]
import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { setTimeout as sleep } from 'node:timers/promises'
import { reserveLoopbackPort, stopOwnedChild } from './lib/isolated-local-services.mjs'
const [dbPath,transport='http',mode='summary',concurrencyText='1']=process.argv.slice(2)
const concurrency=Number(concurrencyText)
assert.ok(dbPath?.startsWith('/') && ['http','mcp'].includes(transport) && ['full','summary','interface','title','key','chunk'].includes(mode) && [1,2,5].includes(concurrency))
const dir=mkdtempSync(join(tmpdir(),'platform-read-telemetry-')), telemetry=join(dir,'telemetry.mjs')
writeFileSync(telemetry, `import dc from 'node:diagnostics_channel';import {monitorEventLoopDelay} from 'node:perf_hooks';import {getHeapStatistics} from 'node:v8';
const lag=monitorEventLoopDelay({resolution:10});lag.enable();let heap=0,rss=0;
const sample=()=>{const m=process.memoryUsage();heap=Math.max(heap,m.heapUsed);rss=Math.max(rss,m.rss)};setInterval(sample,5).unref();
dc.channel('http.server.response.finish').subscribe(({request})=>{sample();if(request.url.startsWith('/api/platform/')||request.url==='/mcp')process.send?.({heap,rss,maxRss:process.resourceUsage().maxRSS*1024,heapLimit:getHeapStatistics().heap_size_limit,lagP95Ms:lag.percentile(95)/1e6,lagMaxMs:lag.max/1e6})});`)
const port=await reserveLoopbackPort()
const base=`http://127.0.0.1:${port}`, metrics=[]
const server=fork('.output/server/index.mjs',[],{execArgv:['--max-old-space-size=2048','--import',telemetry],env:{...process.env,PORT:String(port),HOST:'127.0.0.1',NUXT_DB_PATH:dbPath,NUXT_DB_READONLY:'1',NUXT_FILES_DIR:dir,MIIT_COOKIE:'',MIIT_COOKIE_FILE:''},stdio:['ignore','pipe','pipe','ipc']})
let output='';for(const stream of [server.stdout,server.stderr])stream.on('data',b=>{output=(output+b).slice(-2000)})
server.on('message',message=>metrics.push(message))
let id=0
async function request() {
 const args=mode==='chunk'?{queryId:1000,field:'collectionEvidence',offset:0,length:65536}:{page:1,pageSize:25,...(['summary','interface','title'].includes(mode)?{view:'summary'}:{}),...(mode==='interface'?{interface:'recognized_list'}:{}),...(mode==='title'?{titleCode:'specialized_sme'}:{}),...(mode==='key'?{queryKey:'synthetic:1000',pageSize:1,includeRawResponse:true}:{})}
 const start=performance.now()
 const response=transport==='http'?await fetch(`${base}${mode==='chunk'?'/api/platform/queries/1000/evidence':'/api/platform/queries'}?${new URLSearchParams(Object.entries(args).filter(([key])=>mode!=='chunk'||key!=='queryId').map(([k,v])=>[k,String(v)]))}`):await fetch(`${base}/mcp`,{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream','mcp-protocol-version':'2025-06-18'},body:JSON.stringify({jsonrpc:'2.0',id:++id,method:'tools/call',params:{name:mode==='chunk'?'get_platform_query_evidence':'list_platform_queries',arguments:args}})})
 const text=await response.text(), ms=performance.now()-start
 assert.equal(response.status,200)
 const body=JSON.parse(text.split('\n').find(s=>s.startsWith('data: '))?.slice(6)??text)
 const result=transport==='http'?body:JSON.parse(body.result.content[0].text)
 if(mode==='chunk')assert.equal(result.byteLength,65536)
 else {assert.equal(result.rows.length,mode==='key'?1:25);if(['summary','interface','title'].includes(mode))assert.equal(result.rows[0].relationsIncluded,false)}
 return {ms,responseBytes:Buffer.byteLength(text),resultHash:createHash('sha256').update(JSON.stringify(result)).digest('hex')}
}
try {
 let ready=false
 for(let i=0;i<120;i++){if(server.exitCode!==null)throw Error(output);try{ready=(await fetch(`${base}/api/health`)).ok}catch{}if(ready)break;await sleep(100)}
 assert.ok(ready,'production artifact readiness')
 const cold=await request(),hot=[]
 for(let round=0;round<20;round+=concurrency)hot.push(...await Promise.all(Array.from({length:concurrency},request)))
 assert.ok(hot.every(sample=>sample.resultHash===cold.resultHash),'public result changed between cold and hot requests')
 await sleep(20)
 assert.ok(metrics.length,'HTTP diagnostic telemetry missing')
 const sorted=hot.map(x=>x.ms).sort((a,b)=>a-b), percentile=p=>sorted[Math.ceil(p*sorted.length)-1]
 console.log(JSON.stringify({transport,mode,concurrency,dbPath,coldLabel:'fresh server process; OS cache not purged',cold,hotSamples:hot.length,hot:{p50:percentile(.5),p95:percentile(.95),p99:percentile(.99)},responseBytes:hot[0].responseBytes,peakHeap:Math.max(...metrics.map(x=>x.heap)),peakRss:Math.max(...metrics.map(x=>x.rss)),osPeakRss:Math.max(...metrics.map(x=>x.maxRss)),heapLimit:metrics[0].heapLimit,eventLoopP95Ms:Math.max(...metrics.map(x=>x.lagP95Ms)),eventLoopMaxMs:Math.max(...metrics.map(x=>x.lagMaxMs))}))
} finally {await stopOwnedChild(server);rmSync(dir,{recursive:true,force:true})}
