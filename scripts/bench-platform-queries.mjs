#!/usr/bin/env node
// Isolated synthetic SQLite only. Run: node --max-old-space-size=2048 scripts/bench-platform-queries.mjs <prepare|read> <db-path> [scale=1] [full|summary|key|chunk]
import { createRequire } from 'node:module'
import { performance } from 'node:perf_hooks'
import { statSync } from 'node:fs'
const { createJiti } = createRequire(import.meta.resolve('nuxt/package.json'))('jiti')
const jiti = createJiti(import.meta.url)
const { useDb } = await jiti.import('../db/client.ts')
const [action, dbPath, scaleText = '1', mode = 'full'] = process.argv.slice(2)
if (!['prepare', 'read'].includes(action) || !dbPath || !dbPath.startsWith('/')) throw new Error('Use prepare|read and an absolute scratch DB path')
const scale = Number(scaleText)
if (![1, 2].includes(scale)) throw new Error('scale must be 1 or 2')
if (!['full', 'summary', 'key', 'chunk'].includes(mode)) throw new Error('mode must be full, summary, key or chunk')
const db = useDb({ dbPath, readOnly: action === 'read' })
if (action === 'prepare') {
  if (db.$client.prepare('select count(*) n from platform_query').get().n) throw new Error('Use an empty synthetic DB')
  const insertQ = db.$client.prepare('insert into platform_query(interface,query_key,rdjb,queried_at,status,raw_response,collection_evidence,created_at) values(?,?,?,?,?,?,?,?)')
  const insertR = db.$client.prepare('insert into platform_relation(query_id,sequence_no,raw_fields,source_text,uscc_raw,created_at) values(?,?,?,?,?,?)')
  const raw = '<html>合成归档🙂'.repeat(512) + '</html>'
  const big = '<html>合成大页🙂'.repeat(32768) + '</html>'
  const evidence = (body, n) => JSON.stringify({source:'queryBusList',status:'success',titleScope:{rdjb:['1','2','3']},pages:[{rdjb:'1',page:1,status:'success',fetchedCount:n,rawResponse:body}], rows:[{payload:body}],fetchedCount:n})
  const normalEvidence = evidence(raw, 2), bigEvidence = evidence(big, 2)
  const nQueries=39303*scale, nRelations=58310*scale
  const start=performance.now()
  db.$client.transaction(() => {
    for(let i=1;i<=nQueries;i++) {
      const n = i<=nRelations-nQueries ? 2 : 1
      insertQ.run('recognized_list',`synthetic:${i}`,'1,2,3','2026-10-19T00:00:00Z',i%31===0?'failed':i%29===0?'partial':i%23===0?'no_record':'success',i%1000===0?big:raw,i%1000===0?bigEvidence:normalEvidence,'2026-10-19')
      for(let s=1;s<=n;s++) insertR.run(i,s,JSON.stringify({id:`${i}:${s}`,payload:'合成'.repeat(128)}),'合成原始文本',`synthetic:${i}`,'2026-10-19')
    }
  })()
  db.$client.pragma('wal_checkpoint(TRUNCATE)')
  console.log(JSON.stringify({action,scale,nQueries,nRelations,dbBytes:statSync(dbPath).size,prepareMs:performance.now()-start,heapLimit:(await import('node:v8')).getHeapStatistics().heap_size_limit}))
} else {
  const { listPlatformQueries } = await jiti.import('../lib/platform/read.ts')
  const { readPlatformQueryEvidence } = await jiti.import('../lib/platform/evidence-read.ts')
  const samples=[]
  let bytes=0, peakHeap=0, peakRss=0, sqlReturnedBytes=0, sqlMs=0
  const observe = rows => {
    const values = Array.isArray(rows) ? rows : rows ? Object.values(rows) : []
    for (const value of values) {
      if (Array.isArray(value) || (value && typeof value === 'object' && !Buffer.isBuffer(value))) observe(value)
      else sqlReturnedBytes += typeof value === 'string' ? Buffer.byteLength(value) : Buffer.isBuffer(value) ? value.length : typeof value === 'number' ? 8 : 0
    }
    const m=process.memoryUsage();peakHeap=Math.max(peakHeap,m.heapUsed);peakRss=Math.max(peakRss,m.rss)
  }
  const prepare=db.$client.prepare.bind(db.$client)
  db.$client.prepare=(...args)=>{
    const statement=prepare(...args)
    for(const method of ['get','all']) {
      const run=statement[method].bind(statement)
      statement[method]=(...args)=>{const start=performance.now();const result=run(...args);sqlMs+=performance.now()-start;observe(result);return result}
    }
    return statement
  }
  for(let i=0;i<6;i++) {
    global.gc?.()
    sqlReturnedBytes=0;sqlMs=0
    const before=process.resourceUsage(), start=performance.now()
    const result=mode==='chunk'?readPlatformQueryEvidence(db,{queryId:1000,field:'collectionEvidence',offset:0,length:65536}):listPlatformQueries(db,{page:1,pageSize:25,...(mode==='summary'?{view:'summary'}:{}),...(mode==='key'?{queryKey:'synthetic:1000',pageSize:1,includeRawResponse:true}:{})})
    const serialized=JSON.stringify(result)
    const elapsed=performance.now()-start, memory=process.memoryUsage()
    peakHeap=Math.max(peakHeap,memory.heapUsed);peakRss=Math.max(peakRss,memory.rss);bytes=Buffer.byteLength(serialized)
    samples.push({kind:i?'hot':'cold-process',ms:elapsed,sqlMs,sqlReturnedBytes,responseBytes:bytes,heapUsed:memory.heapUsed,rss:memory.rss,fsRead:process.resourceUsage().fsRead-before.fsRead})
  }
  const sorted=samples.slice(1).map(x=>x.ms).sort((a,b)=>a-b)
  console.log(JSON.stringify({action,scale,mode,dbBytes:statSync(dbPath).size,heapLimit:(await import('node:v8')).getHeapStatistics().heap_size_limit,samples,hot:{p50:sorted[2],p95:sorted[4],p99:sorted[4]},peakHeap,peakRss,processMaxRssBytes:process.resourceUsage().maxRSS*1024}))
}
db.$client.close()
