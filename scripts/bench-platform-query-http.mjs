#!/usr/bin/env node
// Production artifact, real HTTP/MCP, synthetic read-only SQLite. Does not build or contact production.
// Controlled runs require PERF_EXPECTED_ARTIFACT_MANIFEST and PERF_BENCHMARK_SOURCE_SHA.
// PERF_POSTVALIDATION=1 is a separate driver-scheduling diagnostic, never replacement acceptance.
// node scripts/bench-platform-query-http.mjs /absolute/synthetic.sqlite <http|mcp> <full|summary|interface|title|key|chunk> [concurrency=1]
import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { setTimeout as sleep } from 'node:timers/promises'
import { performanceController } from './lib/performance-controller.mjs'
import { readBenchmarkAuthority } from './lib/benchmark-authority.mjs'
import { reserveLoopbackPort, stopOwnedChild } from './lib/isolated-local-services.mjs'
const [dbPath,transport='http',mode='summary',concurrencyText='1']=process.argv.slice(2)
const concurrency=Number(concurrencyText)
assert.ok(dbPath?.startsWith('/') && ['http','mcp'].includes(transport) && ['full','summary','interface','title','key','chunk'].includes(mode) && [1,2,5].includes(concurrency))
const artifactAuthority=readBenchmarkAuthority(process.env.PERF_BENCHMARK_SOURCE_SHA)
const dir=mkdtempSync(join(tmpdir(),'platform-read-telemetry-')), telemetry=join(dir,'telemetry.mjs')
writeFileSync(telemetry, `import ${JSON.stringify(new URL('./lib/performance-preload.mjs', import.meta.url).href)};`)
const port=await reserveLoopbackPort()
const base=`http://127.0.0.1:${port}`
const server=fork('.output/server/index.mjs',[],{execArgv:['--max-old-space-size=2048','--import',telemetry],env:{...process.env,PORT:String(port),HOST:'127.0.0.1',NUXT_DB_PATH:dbPath,NUXT_DB_READONLY:'1',NUXT_FILES_DIR:dir,MIIT_COOKIE:'',MIIT_COOKIE_FILE:''},stdio:['ignore','pipe','pipe','ipc']})
const phases=performanceController(server)
let output='';for(const stream of [server.stdout,server.stderr])stream.on('data',b=>{output=(output+b).slice(-2000)})
let id=0
function validate(text) {
 const body=phases.driver.measure('decode',()=>JSON.parse(text.split('\n').find(s=>s.startsWith('data: '))?.slice(6)??text))
 const result=transport==='http'?body:phases.driver.measure('decodeMcp',()=>JSON.parse(body.result.content[0].text))
 if(mode==='chunk')assert.equal(result.byteLength,65536)
 else {assert.equal(result.rows.length,mode==='key'?1:25);if(['summary','interface','title'].includes(mode))assert.equal(result.rows[0].relationsIncluded,false)}
 return phases.driver.measure('semanticHash',()=>createHash('sha256').update(JSON.stringify(result)).digest('hex'))
}
async function request(deferValidation=false) {
 const args=mode==='chunk'?{queryId:1000,field:'collectionEvidence',offset:0,length:65536}:{page:1,pageSize:25,...(['summary','interface','title'].includes(mode)?{view:'summary'}:{}),...(mode==='interface'?{interface:'recognized_list'}:{}),...(mode==='title'?{titleCode:'specialized_sme'}:{}),...(mode==='key'?{queryKey:'synthetic:1000',pageSize:1,includeRawResponse:true}:{})}
 const start=performance.now()
 const response=transport==='http'?await fetch(`${base}${mode==='chunk'?'/api/platform/queries/1000/evidence':'/api/platform/queries'}?${new URLSearchParams(Object.entries(args).filter(([key])=>mode!=='chunk'||key!=='queryId').map(([k,v])=>[k,String(v)]))}`):await fetch(`${base}/mcp`,{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream','mcp-protocol-version':'2025-06-18'},body:JSON.stringify({jsonrpc:'2.0',id:++id,method:'tools/call',params:{name:mode==='chunk'?'get_platform_query_evidence':'list_platform_queries',arguments:args}})})
 const text=await response.text(), ms=performance.now()-start
 assert.equal(response.status,200)
 return {ms,responseBytes:Buffer.byteLength(text),...(deferValidation?{capturedBody:text}:{resultHash:validate(text)})}
}
try {
 let ready=false
 for(let i=0;i<120;i++){if(server.exitCode!==null)throw Error(output);try{ready=(await fetch(`${base}/api/health`)).ok}catch{}if(ready)break;await sleep(100)}
 assert.ok(ready,`production artifact readiness: ${output}`)
 await phases.begin('cold')
 const cold=await request(),coldPhases=await phases.end('cold')
 await phases.begin('warmup');const warmup=await request(),warmupPhases=await phases.end('warmup')
 await phases.begin('hot');const hot=[],deferredValidation=process.env.PERF_POSTVALIDATION==='1'
 for(let round=0;round<20;round+=concurrency)hot.push(...await Promise.all(Array.from({length:concurrency},()=>request(deferredValidation))))
 const hotPhases=await phases.end('hot')
 let validationPhases
 if(deferredValidation){await phases.begin('postvalidation');for(const sample of hot){sample.resultHash=validate(sample.capturedBody);delete sample.capturedBody}validationPhases=await phases.end('postvalidation')}
 assert.ok(hot.every(sample=>sample.resultHash===cold.resultHash),'public result changed between cold and hot requests')
 const sorted=hot.map(x=>x.ms).sort((a,b)=>a-b), percentile=p=>sorted[Math.ceil(p*sorted.length)-1]
 console.log(JSON.stringify({artifactAuthority,driverScheduling:deferredValidation?'postvalidation diagnostic; every full body validated after timing':'inline semantic validation; original shared quota workload',validationPhases,transport,mode,concurrency,dbPath,coldLabel:'fresh server process; OS cache not purged',cold,warmup,retainedSamples:hot,hotSamples:hot.length,hot:{p50:percentile(.5),p95:percentile(.95),p99:percentile(.99)},responseBytes:hot[0].responseBytes,coldPhases,warmupPhases,hotPhases,peakHeap:hotPhases.app.peakHeap,peakRss:hotPhases.app.peakRss,osPeakRss:hotPhases.app.osPeakRss,heapLimit:hotPhases.app.heapLimit,eventLoopP95Ms:hotPhases.app.loopP95Ms,eventLoopMaxMs:hotPhases.app.loopMaxMs}))
} finally {phases.close();await stopOwnedChild(server);rmSync(dir,{recursive:true,force:true})}
