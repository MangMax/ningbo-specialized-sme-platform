#!/usr/bin/env node
// Isolated synthetic SQLite only. Run: node --max-old-space-size=2048 scripts/bench-platform-queries.mjs <prepare|read> <db-path> [scale=1] [full|summary|key|chunk]
import { createRequire } from 'node:module'
import { performance } from 'node:perf_hooks'
import { statSync, lstatSync, mkdtempSync, linkSync, realpathSync } from 'node:fs'
import { dirname, join, resolve, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
const { createJiti } = createRequire(import.meta.resolve('nuxt/package.json'))('jiti')
const jiti = createJiti(import.meta.url)
const { useDb } = await jiti.import('../db/client.ts')
const [action, dbPath, scaleText = '1', mode = 'full'] = process.argv.slice(2)
if (!['prepare', 'read'].includes(action) || !dbPath || !dbPath.startsWith('/')) throw new Error('Use prepare|read and an absolute scratch DB path')
const scale = Number(scaleText)
if (![1, 2].includes(scale)) throw new Error('scale must be 1 or 2')
if (!['full', 'summary', 'key', 'chunk'].includes(mode)) throw new Error('mode must be full, summary, key or chunk')
// prepare never opens the caller's destination with SQLite. The exclusively
// created, mode-0700 staging directory is the only initialization authority.
// Preserve staging on every outcome: no path-based rollback can delete a
// competing/replaced file. Caller owns successful output and retained staging.
let db, stagingDir
const companions = ['', '-wal', '-shm', '-journal']
const requireAbsent = paths => {
  for (const path of paths) {
    try { lstatSync(path) } catch (error) { if (error.code === 'ENOENT') continue; throw error }
    throw new Error(`Refusing existing prepare path: ${path}`)
  }
}
try {
if (action === 'read') db = useDb({ dbPath, readOnly: action === 'read' })
if (action === 'prepare') {
  // Known application storage is never a synthetic destination, even if absent.
  const canonicalPath = path => {
    try { return join(realpathSync(dirname(path)), basename(path)) }
    catch (error) { if (error.code === 'ENOENT') return resolve(path); throw error }
  }
  const destination = canonicalPath(dbPath)
  const dataRoots = [resolve('data'), fileURLToPath(new URL('../data', import.meta.url))]
  if (dataRoots.some(root => {
    let canonicalRoot
    try { canonicalRoot = realpathSync(root) } catch (error) { if (error.code !== 'ENOENT') throw error; canonicalRoot = resolve(root) }
    return destination === canonicalRoot || destination.startsWith(canonicalRoot + '/')
  }) || (process.env.NUXT_DB_PATH && destination === canonicalPath(resolve(process.env.NUXT_DB_PATH)))) throw new Error('Refusing application database/storage path; use a new scratch destination')
  requireAbsent(companions.map(suffix => dbPath + suffix))
  stagingDir = mkdtempSync(join(dirname(dbPath), '.platform-query-prepare-'))
  console.error(`Private synthetic staging retained for caller inspection: ${stagingDir}`)
  const stagedPath = join(stagingDir, 'fixture.db')
  db = useDb({ dbPath: stagedPath })
  // Private preparation needs a standalone main file, not a second full WAL.
  db.$client.pragma('journal_mode = DELETE')
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
      const queryId = insertQ.run('recognized_list',`synthetic:${i}`,'1,2,3','2026-10-19T00:00:00Z',i%31===0?'failed':i%29===0?'partial':i%23===0?'no_record':'success',i%1000===0?big:raw,i%1000===0?bigEvidence:normalEvidence,'2026-10-19').lastInsertRowid
      for(let s=1;s<=n;s++) insertR.run(queryId,s,JSON.stringify({id:`${i}:${s}`,payload:'合成'.repeat(128)}),'合成原始文本',`synthetic:${i}`,'2026-10-19')
    }
  })()
  const checkpoint = db.$client.pragma('wal_checkpoint(TRUNCATE)')[0]
  if (checkpoint.busy) throw new Error('Synthetic checkpoint is busy; publication refused')
  db.$client.close()
  requireAbsent(['-wal', '-shm', '-journal'].map(suffix => stagedPath + suffix))
  const identity = lstatSync(stagedPath, { bigint: true })
  if (!identity.isFile()) throw new Error('Synthetic staging file identity is unknown')
  requireAbsent(companions.map(suffix => dbPath + suffix))
  // link is atomic and fails if ANY destination entry (including a dangling
  // symlink) already exists. Never rename over or unlink a destination.
  linkSync(stagedPath, dbPath)
  const published = lstatSync(dbPath, { bigint: true })
  if (!published.isFile() || published.dev !== identity.dev || published.ino !== identity.ino) throw new Error('Published file replaced; paths preserved')
  requireAbsent(['-wal', '-shm', '-journal'].map(suffix => dbPath + suffix))
  console.log(JSON.stringify({action,scale,nQueries,nRelations,dbBytes:statSync(dbPath).size,prepareMs:performance.now()-start,heapLimit:(await import('node:v8')).getHeapStatistics().heap_size_limit,retainedStaging:stagingDir,ownership:'DB and staging retained for caller'}))
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
  // Successful reads are diagnostic measurements, not qualification or SLO acceptance.
  console.log(JSON.stringify({action,status:'MEASURED_UNVALIDATED',qualified:false,runtimeQualified:false,reason:'This direct-read lane lacks independent artifact, workload and semantic expected evidence. Scale is only a CLI label; samples and percentiles are unvalidated diagnostics, not valid performance samples or SLO acceptance. Exit 0 means diagnostic execution completed, not acceptance PASS.',scale,mode,dbBytes:statSync(dbPath).size,heapLimit:(await import('node:v8')).getHeapStatistics().heap_size_limit,samples,hot:{p50:sorted[2],p95:sorted[4],p99:sorted[4]},peakHeap,peakRss,processMaxRssBytes:process.resourceUsage().maxRSS*1024}))
}
} catch (error) {
  if (stagingDir) console.error(`Prepare failed; staging and destination paths preserved (ownership must be inspected): ${stagingDir}`)
  throw error
} finally {
  if (db?.$client.open) db.$client.close()
}
