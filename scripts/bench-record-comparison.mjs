#!/usr/bin/env node
// Local isolated SQLite copy only; no raw values/credentials are logged.
// node --expose-gc --max-old-space-size=2048 scripts/bench-record-comparison.mjs /absolute/copy.db sources|comparison [rounds=20]
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
const { createJiti } = createRequire(import.meta.resolve('nuxt/package.json'))('jiti')
const jiti = createJiti(import.meta.url)
const { useDb } = await jiti.import('../db/client.ts')
const { getRecordComparison, listRecordComparisonSources } = await jiti.import(process.env.PERF_SOURCE_ROOT ? process.env.PERF_SOURCE_ROOT + '/server/utils/record-comparison.ts' : '../server/utils/record-comparison.ts')
const [path, mode='comparison', roundsText='20']=process.argv.slice(2)
if(!path?.startsWith('/') || !['sources','comparison'].includes(mode) || path.includes('/full-snapshot/')) throw Error('Use an isolated copy and sources|comparison')
const db=useDb({dbPath:path,readOnly:true}), rounds=Number(roundsText)
const q=db.$client.prepare('select id from platform_query order by id limit 1').get().id
const d=db.$client.prepare("select id from source_document where source='jxj' order by id limit 1").get().id
const e=db.$client.prepare('select id from enterprise order by id limit 1').get().id
const input={queryIds:[q],exportBatchIds:[],officialSourceDocumentIds:[d],enterpriseId:e,page:1,pageSize:25}
let sqlBytes=0,sqlRows=0,sqlCalls=0,sqlMs=0,peakHeap=0,peakRss=0
const sample=()=>{const m=process.memoryUsage();peakHeap=Math.max(peakHeap,m.heapUsed);peakRss=Math.max(peakRss,m.rss)}
const observe=value=>{if(Array.isArray(value)){for(const item of value)observe(item)}else if(value&&typeof value==='object'){for(const item of Object.values(value))observe(item)}else sqlBytes+=typeof value==='string'?Buffer.byteLength(value):typeof value==='number'?8:0}
const prepare=db.$client.prepare.bind(db.$client)
db.$client.prepare=(...args)=>{const statement=prepare(...args);for(const method of ['all','get','iterate']){const run=statement[method].bind(statement);statement[method]=(...args)=>{const start=performance.now(),result=run(...args);if(method==='iterate'){sqlCalls++;return (function*(){while(true){const start=performance.now(),next=result.next();sqlMs+=performance.now()-start;if(next.done)break;sqlRows++;observe(next.value);sample();yield next.value}})()}sqlMs+=performance.now()-start;sqlCalls++;sqlRows+=Array.isArray(result)?result.length:result?1:0;observe(result);sample();return result}}return statement}
const samples=[]
for(let i=0;i<=rounds;i++){
 global.gc?.(); sqlBytes=0;sqlRows=0;sqlCalls=0;sqlMs=0;peakHeap=0;peakRss=0
 const heapStart=process.memoryUsage().heapUsed,start=performance.now()
 const result=mode==='sources'?listRecordComparisonSources(db,{kind:'query',page:1,pageSize:25}):getRecordComparison(db,input)
 const serializeStart=performance.now(),body=JSON.stringify(result),serializationMs=performance.now()-serializeStart
 sample();samples.push({phase:i?'hot':'cold-process',ms:performance.now()-start,sqlMs,serializationMs,sqlBytes,sqlRows,sqlCalls,responseBytes:Buffer.byteLength(body),sha256:createHash('sha256').update(body).digest('hex'),heapStart,peakHeap,incrementalHeap:peakHeap-heapStart,peakRss})
}
const hot=samples.slice(1).map(x=>x.ms).sort((a,b)=>a-b),pct=p=>hot[Math.ceil(hot.length*p)-1]
console.log(JSON.stringify({mode,node:process.version,head:(await import('node:child_process')).execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),dirty:(await import('node:child_process')).execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim()!=='',input:mode==='comparison'?input:{kind:'query',page:1,pageSize:25},samples,hot:{p50:pct(.5),p95:pct(.95),p99:pct(.99)},maxRss:process.resourceUsage().maxRSS*1024,containerLimited:false}))
db.$client.close()
