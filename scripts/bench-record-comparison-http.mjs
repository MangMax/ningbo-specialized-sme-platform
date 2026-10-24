#!/usr/bin/env node
// Local compiled Nitro HTTP/MCP benchmark. Only open an isolated SQLite copy.
// node scripts/bench-record-comparison-http.mjs /absolute/copy.db http|mcp sources|comparison 1|2|5 [catalogPage=1]
// PERF_QUERY_ID, PERF_PAGE_SIZE=50 and PERF_CATALOG_KIND=all reproduce the frozen #82 inputs.
import assert from 'node:assert/strict'

import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { setTimeout as sleep } from 'node:timers/promises'
import { forkOwnedChild as fork, reserveLoopbackPort, stopOwnedChild } from './lib/isolated-local-services.mjs'
const [dbPath,transport='http',mode='comparison',c='1',pageText='1']=process.argv.slice(2),concurrency=Number(c),catalogPage=Number(pageText)
assert.ok(Number.isSafeInteger(catalogPage)&&catalogPage>0&&dbPath?.startsWith('/') && !dbPath.includes('/full-snapshot/') && ['http','mcp'].includes(transport) && ['sources','comparison'].includes(mode) && [1,2,5].includes(concurrency) && (mode!=='sources'||transport==='http'))
const require=createRequire(import.meta.url),Database=require('better-sqlite3'),db=new Database(dbPath,{readonly:true})
const queryId=Number(process.env.PERF_QUERY_ID??db.prepare('select id from platform_query order by id limit 1').get().id),docId=db.prepare("select id from source_document where source='jxj' order by id limit 1").get().id,enterpriseId=db.prepare('select id from enterprise order by id limit 1').get().id
db.close()
const pageSize=Number(process.env.PERF_PAGE_SIZE??25),catalogKind=process.env.PERF_CATALOG_KIND==='all'?undefined:'query'
assert.ok(Number.isSafeInteger(queryId)&&queryId>0&&Number.isSafeInteger(pageSize)&&pageSize>0&&pageSize<=50)
const dir=mkdtempSync(join(tmpdir(),'comparison-telemetry-')),telemetry=join(dir,'telemetry.mjs')
writeFileSync(telemetry, `import dc from 'node:diagnostics_channel';import {monitorEventLoopDelay} from 'node:perf_hooks';import {getHeapStatistics} from 'node:v8';
const lag=monitorEventLoopDelay({resolution:10});lag.enable();let heap=0,rss=0,heapStart=0,workerHeap=0,combinedHeap=0,combinedHeapStart=0;
dc.channel('ningbo.enterprise-read').subscribe(metric=>{workerHeap=metric.workerHeap??workerHeap;sample()});
const sample=()=>{const m=process.memoryUsage();heap=Math.max(heap,m.heapUsed);rss=Math.max(rss,m.rss);combinedHeap=Math.max(combinedHeap,m.heapUsed+workerHeap)};setInterval(sample,5).unref();
const report=()=>({heap,rss,heapStart,workerHeap,combinedHeap,combinedHeapStart,maxRss:process.resourceUsage().maxRSS*1024,heapLimit:getHeapStatistics().heap_size_limit,lagP95Ms:lag.percentile(95)/1e6,lagMaxMs:lag.max/1e6,lagSamples:lag.count});
process.on('message',message=>{if(message==='reset'){lag.reset();heap=0;rss=0;heapStart=process.memoryUsage().heapUsed;combinedHeap=0;combinedHeapStart=heapStart+workerHeap;process.send?.('reset')}if(message==='sample'){sample();process.send?.(report())}});
dc.channel('http.server.response.finish').subscribe(({request})=>{sample();if(request.url.startsWith('/api/roster/record-comparison')||request.url==='/mcp')process.send?.({heap,rss,maxRss:process.resourceUsage().maxRSS*1024,heapLimit:getHeapStatistics().heap_size_limit,lagP95Ms:lag.percentile(95)/1e6,lagMaxMs:lag.max/1e6})});`)
const port=await reserveLoopbackPort(),base=`http://127.0.0.1:${port}`,metrics=[]
const server=fork('.output/server/index.mjs',[],{execArgv:['--max-old-space-size=2048','--import',telemetry],env:{...process.env,PORT:String(port),HOST:'127.0.0.1',NUXT_DB_PATH:dbPath,NUXT_DB_READONLY:'1',NUXT_FILES_DIR:dir,MIIT_COOKIE:'',MIIT_COOKIE_FILE:''},stdio:['ignore','pipe','pipe','ipc']})
let output='',reset=false,id=0
for(const stream of [server.stdout,server.stderr])stream.on('data',b=>{output=(output+b).slice(-2000)})
server.on('message',message=>{if(message==='reset')reset=true;else metrics.push(message)})
const input={queryIds:[queryId],exportBatchIds:[],officialSourceDocumentIds:[docId],enterpriseId,page:1,pageSize}
async function request(){
 const start=performance.now(),query=mode==='sources'?{...(catalogKind?{kind:catalogKind}:{}),page:catalogPage,pageSize}:input
 const response=transport==='http'?await fetch(`${base}/api/roster/record-comparison${mode==='sources'?'/sources':''}?${new URLSearchParams(Object.entries(query).map(([k,v])=>[k,String(v)]))}`):await fetch(`${base}/mcp`,{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream','mcp-protocol-version':'2025-06-18'},body:JSON.stringify({jsonrpc:'2.0',id:++id,method:'tools/call',params:{name:'list_record_comparison',arguments:input}})})
 const text=await response.text(),ms=performance.now()-start;assert.equal(response.status,200)
 const body=JSON.parse(text.split('\n').find(s=>s.startsWith('data: '))?.slice(6)??text),result=transport==='http'?body:JSON.parse(body.result.content[0].text)
 assert.ok(result.rows&&result.counts)
 return {ms,responseBytes:Buffer.byteLength(text),resultSha256:createHash('sha256').update(JSON.stringify(result)).digest('hex')}
}
try{
 let ready=false;for(let i=0;i<120;i++){if(server.exitCode!==null)throw Error(output);try{ready=(await fetch(`${base}/api/health`)).ok}catch{}if(ready)break;await sleep(100)}assert.ok(ready,'compiled artifact readiness')
 server.send('reset');for(let i=0;i<100&&!reset;i++)await sleep(10);assert.ok(reset)
 const cold=await request(),hot=[]
 await sleep(20);let count=metrics.length;server.send('sample');for(let i=0;i<100&&metrics.length===count;i++)await sleep(10)
 const coldMetrics=metrics.at(-1)
 reset=false;server.send('reset');for(let i=0;i<100&&!reset;i++)await sleep(10);assert.ok(reset)
 metrics.length=0
 const hotStarted=performance.now();
 for(let n=0;n<20;n+=concurrency)hot.push(...await Promise.all(Array.from({length:concurrency},request)))
 const hotWallMs=performance.now()-hotStarted;
 await sleep(30);count=metrics.length;server.send('sample');for(let i=0;i<100&&metrics.length===count;i++)await sleep(10);assert.ok(metrics.length)
 assert.ok(hot.every(x=>x.resultSha256===cold.resultSha256),'stable complete result across concurrency')
 const sorted=hot.map(x=>x.ms).sort((a,b)=>a-b),pct=p=>sorted[Math.ceil(p*sorted.length)-1]
 console.log(JSON.stringify({transport,mode,concurrency,catalogPage,node:process.version,cold:{...cold,eventLoopP95Ms:coldMetrics.lagP95Ms,eventLoopMaxMs:coldMetrics.lagMaxMs,incrementalHeap:coldMetrics.heap-coldMetrics.heapStart,combinedHeap:coldMetrics.combinedHeap,combinedIncrementalHeap:coldMetrics.combinedHeap-coldMetrics.combinedHeapStart,workerHeap:coldMetrics.workerHeap},hotSamples:hot.length,hotWallMs,throughputPerSecond:hot.length/(hotWallMs/1000),hot:{p50:pct(.5),p95:pct(.95),p99:pct(.99)},responseBytes:hot[0].responseBytes,resultSha256:cold.resultSha256,peakHeap:Math.max(...metrics.map(x=>x.heap)),incrementalHeap:Math.max(...metrics.map(x=>x.heap))-metrics.at(-1).heapStart,workerHeap:metrics.at(-1).workerHeap,combinedPeakHeap:Math.max(...metrics.filter(x=>x.combinedHeap!==undefined).map(x=>x.combinedHeap)),combinedIncrementalHeap:Math.max(...metrics.filter(x=>x.combinedHeap!==undefined).map(x=>x.combinedHeap))-metrics.at(-1).combinedHeapStart,peakRss:Math.max(...metrics.map(x=>x.rss)),osPeakRss:Math.max(...metrics.map(x=>x.maxRss)),heapLimit:metrics[0].heapLimit,eventLoopP95Ms:metrics.at(-1).lagP95Ms,eventLoopMaxMs:metrics.at(-1).lagMaxMs,eventLoopSamples:metrics.at(-1).lagSamples,containerLimited:false}))
}finally{await stopOwnedChild(server);rmSync(dir,{recursive:true,force:true})}
