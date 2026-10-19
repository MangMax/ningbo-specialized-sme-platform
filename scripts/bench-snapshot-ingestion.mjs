#!/usr/bin/env node
// Local built Nitro HTTP/MCP only. The snapshot is copied as a file, never opened by SQLite.
// node scripts/bench-snapshot-ingestion.mjs <snapshot> <private-output-dir> <source-sha> [scales=1,2,5] [transports=http,mcp] [readers=1,2,5] [representative|large]
import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { constants, copyFileSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import Database from 'better-sqlite3'
import { createRequire } from 'node:module'
import { resolve, join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { setTimeout as sleep } from 'node:timers/promises'
import { reserveLoopbackPort, stopOwnedChild } from './lib/isolated-local-services.mjs'

const [sourceArg, outputArg, sha, scaleArg = '1,2,5', transportArg = 'http,mcp', readerArg = '1,2,5', inputMode = 'representative'] = process.argv.slice(2)
assert.ok(sourceArg && outputArg && /^[a-f0-9]{7,40}$/.test(sha ?? ''))
assert.ok(['representative', 'large'].includes(inputMode))
const source = resolve(sourceArg), output = resolve(outputArg)
assert.ok(output.startsWith('/tmp/'), 'private output must be under /tmp')
assert.ok(!existsSync(output), 'use a new output directory; never overwrite evidence')
assert.ok(!existsSync(`${source}-wal`) || statSync(`${source}-wal`).size === 0, 'snapshot must have no pending WAL')
mkdirSync(output, { recursive: true })
const scales = scaleArg.split(',').map(Number), transports = transportArg.split(','), readersList = readerArg.split(',').map(Number)
assert.ok(scales.every(x => [1, 2, 5].includes(x)) && transports.every(x => ['http', 'mcp'].includes(x)) && readersList.every(x => [1, 2, 5].includes(x)))
const sourceStat = statSync(source)
const { createJiti } = createRequire(import.meta.resolve('nuxt/package.json'))('jiti')
const jiti = createJiti(import.meta.url)
const { useDb } = await jiti.import('../db/client.ts')
const telemetry = join(output, 'telemetry.mjs')
writeFileSync(telemetry, `import dc from 'node:diagnostics_channel';import {monitorEventLoopDelay,performance} from 'node:perf_hooks';import {getHeapStatistics} from 'node:v8';import {createRequire} from 'node:module';
const lag=monitorEventLoopDelay({resolution:10});lag.enable();let peakHeap=0,peakRss=0,sqlMs=0,sqlRows=0,sqlTextBytes=0,parseMs=0,stringifyMs=0,baseHeap=0;
const sampleHeap=()=>{peakHeap=Math.max(peakHeap,getHeapStatistics().used_heap_size)};const sample=()=>{sampleHeap();peakRss=Math.max(peakRss,process.memoryUsage.rss())};
const req=createRequire(import.meta.url);const Database=req(${JSON.stringify(createRequire(resolve('.output/server/index.mjs')).resolve('better-sqlite3'))});const probe=new Database(':memory:');const proto=Object.getPrototypeOf(probe.prepare('select 1'));probe.close();
for(const key of ['all','get','run']){const original=proto[key];proto[key]=function(...args){const t=performance.now();try{const out=original.apply(this,args);if(key!=='run'){const rows=key==='all'?out:out?[out]:[];sqlRows+=rows.length;for(const row of rows)for(const value of Object.values(row))if(typeof value==='string')sqlTextBytes+=Buffer.byteLength(value)}return out}finally{sqlMs+=performance.now()-t;sampleHeap()}}}
const parse=JSON.parse,stringify=JSON.stringify;JSON.parse=function(...a){const t=performance.now();try{return parse.apply(this,a)}finally{parseMs+=performance.now()-t;sampleHeap()}};JSON.stringify=function(...a){const t=performance.now();try{return stringify.apply(this,a)}finally{stringifyMs+=performance.now()-t;sampleHeap()}};
setInterval(sample,5).unref();process.on('message',m=>{if(m==='reset'){peakHeap=peakRss=sqlMs=sqlRows=sqlTextBytes=parseMs=stringifyMs=0;baseHeap=getHeapStatistics().used_heap_size;lag.reset();process.send?.({reset:true})}if(m==='metrics'){sample();process.send?.({baseHeap,peakHeap,heapDelta:peakHeap-baseHeap,peakRss,osPeakRss:process.resourceUsage().maxRSS*1024,sqlMs,sqlRows,sqlTextBytes,parseMs,stringifyMs,loopP95Ms:lag.percentile(95)/1e6,loopMaxMs:lag.max/1e6})}});
dc.channel('http.server.response.finish').subscribe(sample);`)

const size = path => existsSync(path) ? statSync(path).size : 0
const quantiles = values => { const sorted = [...values].sort((a,b) => a-b); return Object.fromEntries([['p50',.5],['p95',.95],['p99',.99]].map(([k,p]) => [k,sorted[Math.ceil(sorted.length*p)-1]])) }
const rawForBytes = n => ({ original: 'x'.repeat(Math.max(0, n - 15)) })
const results = []
for (const scale of scales) {
  const template = join(output, `template-${scale}.sqlite`)
  copyFileSync(source, template, constants.COPYFILE_FICLONE)
  const seed = useDb({ dbPath: template }), sqlite = seed.$client
  // Remove saved credentials only on this owned copy, without selecting their values.
  sqlite.exec('DELETE FROM service_credential')
  const lengths = sqlite.prepare('select length(cast(raw_fields as blob)) as n from platform_export_row').all().map(r => r.n ?? 1000)
  const addBatch = sqlite.prepare('INSERT INTO platform_export_batch(title_code,year,collected_on,original_filename,sha256,row_count,import_status,created_at) VALUES(?,?,?,?,?,?,?,?)')
  const addRow = sqlite.prepare('INSERT INTO platform_export_row(batch_id,source_row_no,raw_fields,created_at) VALUES(?,?,?,?)')
  sqlite.transaction(() => {
    if (scale > 1) {
      const id = Number(addBatch.run('innovative_sme',2093,'2026-10-19','synthetic-scale.xlsx','synthetic-scale',lengths.length*(scale-1),'imported','2026-10-19').lastInsertRowid)
      for (let i = 0; i < lengths.length*(scale-1); i++) addRow.run(id,i+3,JSON.stringify(rawForBytes(lengths[i%lengths.length])),'2026-10-19')
    }
    const id = Number(addBatch.run('specialized_sme',2094,'2026-10-19','synthetic.xlsx','synthetic-benchmark',150,'imported','2026-10-19').lastInsertRowid)
    for (let i=0;i<150;i++) addRow.run(id,i+3,JSON.stringify(rawForBytes(lengths[i%lengths.length])),'2026-10-19')
  })()
  const counts = { exportRows: sqlite.prepare('select count(*) n from platform_export_row').get().n, exportRawBytes: sqlite.prepare('select sum(length(cast(raw_fields as blob))) n from platform_export_row').get().n }
  sqlite.pragma('wal_checkpoint(TRUNCATE)');sqlite.close()
  for (const transport of transports) for (const readers of readersList) {
    const name=`${scale}x-${transport}-r${readers}`, dbPath=template
    // Reuse this owned copy, reset only our fixture writes between fresh processes.
    // This avoids making eighteen full private copies. Freelist/page layout may differ;
    // the same logical input and DB/WAL size are recorded for every scenario.
    const reset=new Database(dbPath)
    reset.transaction(()=>{
      reset.prepare("DELETE FROM platform_export_row WHERE batch_id=(SELECT id FROM platform_export_batch WHERE sha256='synthetic-benchmark' AND year=2094) AND source_row_no>=10000").run()
      reset.prepare("DELETE FROM import_batch WHERE idempotency_key LIKE 'synthetic:bench:%'").run()
    })()
    reset.pragma('wal_checkpoint(TRUNCATE)');reset.close()
    const beforeBytes=size(dbPath),port=await reserveLoopbackPort(),base=`http://127.0.0.1:${port}`
    const server=fork('.output/server/index.mjs',[],{execArgv:['--max-old-space-size=2048','--import',telemetry],env:{...process.env,PORT:String(port),HOST:'127.0.0.1',NUXT_DB_PATH:dbPath,NUXT_DB_READONLY:'0',NUXT_FILES_DIR:output,NUXT_INCOMING_DIR:output,NUXT_API_TOKEN:'synthetic-only',NUXT_MCP_TOKEN:'synthetic-only',MIIT_COOKIE:'',MIIT_COOKIE_FILE:'',NUXT_OCR_TOKEN:'',PADDLEOCR_MCP_AISTUDIO_ACCESS_TOKEN:''},stdio:['ignore','pipe','pipe','ipc']})
    let outputTail='';for(const stream of [server.stdout,server.stderr])stream.on('data',b=>{outputTail=(outputTail+b).slice(-1000)})
    let phase='readiness'
    server.on('exit',(code,signal)=>writeFileSync(join(output,`${name}-exit.json`),JSON.stringify({phase,code,signal,heapOom:outputTail.includes('heap out of memory')})))
    const message=command=>new Promise((res,rej)=>{const timeout=setTimeout(()=>{server.off('message',on);rej(Error('telemetry timeout'))},5000);const on=m=>{clearTimeout(timeout);server.off('message',on);res(m)};server.on('message',on);server.send(command)})
    let rpcId=0
    const rpc=async(method,params)=>{
      const response=await fetch(`${base}/mcp`,{method:'POST',signal:AbortSignal.timeout(30_000),headers:{connection:'close','content-type':'application/json',accept:'application/json, text/event-stream',authorization:'Bearer synthetic-only'},body:JSON.stringify({jsonrpc:'2.0',id:++rpcId,method,params})})
      const text=await response.text();assert.equal(response.status,200);const envelope=JSON.parse(text.split('\n').find(s=>s.startsWith('data: '))?.slice(6)??text)
      assert.ok(!envelope.error && !envelope.result?.isError,'MCP call failed')
      return {body:method==='tools/call'?JSON.parse(envelope.result.content[0].text):envelope.result,bytes:Buffer.byteLength(text)}
    }
    const invoke=async(action,input)=>{
      const start=performance.now();let result
      if(transport==='mcp')result=await rpc('tools/call',{name:action==='preflight'?'preflight_roster_batch':'save_roster_batch',arguments:input})
      else {const response=await fetch(`${base}/api/roster/import/${action}`,{method:'POST',signal:AbortSignal.timeout(30_000),headers:{connection:'close','content-type':'application/json',authorization:'Bearer synthetic-only'},body:JSON.stringify(input)});const text=await response.text();assert.equal(response.status,200);result={body:JSON.parse(text),bytes:Buffer.byteLength(text)}}
      return {...result,ms:performance.now()-start}
    }
    const read=async()=>{
      const start=performance.now(),response=await fetch(`${base}/api/platform/queries?view=summary&pageSize=25`,{headers:{connection:'close'},signal:AbortSignal.timeout(30_000)}),text=await response.text()
      assert.equal(response.status,200);assert.equal(JSON.parse(text).rows.length,25)
      return {ms:performance.now()-start,bytes:Buffer.byteLength(text)}
    }
    const round=async index=>{
      const input={idempotencyKey:`synthetic:bench:${index}`,sourceKind:'platform_export',sourceIdentity:'synthetic.xlsx',payload:{exportSnapshot:{titleCode:'specialized_sme',year:2094,collectedOn:'2026-10-19',originalFilename:'synthetic.xlsx',sha256:'synthetic-benchmark',rows:Array.from({length:300},(_,i)=>({sourceRowNo:i<150?i+3:10000+index*150+i,rawFields:rawForBytes(inputMode==='large'?(i===150?1_200_000:14753):lengths[i%lengths.length])}))}}}
      const inputBytes=Buffer.byteLength(JSON.stringify(input))
      phase=`round-${index}-preflight`
      const [preflight,preReads]=await Promise.all([invoke('preflight',input),Promise.all(Array.from({length:readers},read))])
      assert.equal(preflight.body.preflight.update,1);assert.deepEqual(preflight.body.preflight.conflicts,[])
      phase=`round-${index}-commit`
      const [commit,commitReads]=await Promise.all([invoke('commit',input),Promise.all(Array.from({length:readers},read))])
      assert.equal(commit.body.status,'committed');assert.equal(commit.body.summary.written,150);assert.equal(commit.body.items[0].detail.skipped,150)
      const ids=commit.body.items[0].detail.rows;assert.equal(ids.length,150)
      phase=`round-${index}-readback`
      const response=await fetch(`${base}/api/roster/correspondences/export-rows/${ids[0]}`,{headers:{connection:'close'},signal:AbortSignal.timeout(30_000)});assert.equal(response.status,200)
      const sourceRow=(await response.json()).source
      assert.equal(sourceRow.sourceRowNo,input.payload.exportSnapshot.rows[150].sourceRowNo);assert.deepEqual(sourceRow.rawFields,input.payload.exportSnapshot.rows[150].rawFields)
      if(index===0){const mcpSource=await rpc('tools/call',{name:'get_record_correspondence_source',arguments:{kind:'export_row',id:ids[0]}});assert.deepEqual(mcpSource.body.source,sourceRow)}
      phase=`round-${index}-replay`
      const repeated=await invoke('commit',input);assert.deepEqual(repeated.body,commit.body)
      return {preflightMs:preflight.ms,commitMs:commit.ms,inputBytes,preflightBytes:preflight.bytes,commitBytes:commit.bytes,reads:[...preReads,...commitReads]}
    }
    try {
      let ready=false
      for(let i=0;i<120;i++){if(server.exitCode!==null)throw Error('local artifact exited before readiness');try{ready=(await fetch(`${base}/api/health`,{headers:{connection:'close'},signal:AbortSignal.timeout(2000)})).ok}catch{}if(ready)break;await sleep(100)}
      assert.ok(ready,'local artifact readiness')
      phase='catalog'
      const catalog=await rpc('tools/list',{});for(const tool of ['preflight_roster_batch','save_roster_batch','get_record_correspondence_source'])assert.ok(catalog.body.tools.some(t=>t.name===tool))
      await message('reset');const cold=await round(0);const coldMetrics=await message('metrics')
      assert.ok(coldMetrics.sqlRows>0,'SQL telemetry must use the built artifact driver')
      writeFileSync(join(output,`${name}-cold.json`),JSON.stringify({sha,scale,transport,readers,cold,coldMetrics},null,2))
      await round(1);await message('reset')
      const hot=[];for(let i=2;i<22;i++)hot.push(await round(i))
      await sleep(20);const metrics=await message('metrics')
      const item={sha,scale,transport,readers,inputMode,writers:1,samples:20,coldLabel:'fresh server process; OS cache not purged; authenticated tools/list before first business request',counts,cold,coldMetrics,hot:{preflight:quantiles(hot.map(x=>x.preflightMs)),commit:quantiles(hot.map(x=>x.commitMs)),read:quantiles(hot.flatMap(x=>x.reads.map(r=>r.ms)))},inputBytes:hot[0].inputBytes,responseBytes:{preflight:hot[0].preflightBytes,commit:hot[0].commitBytes,read:hot[0].reads[0].bytes},metrics,dbBytesBefore:beforeBytes,dbBytesAfter:size(dbPath),walBytes:size(`${dbPath}-wal`),semantics:'300 input;150 existing+150 new; exact raw/sourceRowNo readback; same-key receipt identical'}
      writeFileSync(join(output,`${name}.json`),JSON.stringify(item,null,2));results.push(item)
      writeFileSync(join(output,'partial-results.json'),JSON.stringify({sha,completedAll:false,results},null,2))
      console.log(JSON.stringify({sha,scale,transport,readers,hot:item.hot,heapDelta:metrics.heapDelta,loopMaxMs:metrics.loopMaxMs}))
    } catch(error) {
      writeFileSync(join(output,`${name}-failure.json`),JSON.stringify({phase,childExitCode:server.exitCode,childSignal:server.signalCode,error:String(error).slice(0,300)}))
      throw error
    } finally {await stopOwnedChild(server)}
  }
  for(const path of [template,`${template}-wal`,`${template}-shm`])rmSync(path,{force:true})
}
const end=statSync(source);assert.equal(end.size,sourceStat.size);assert.equal(end.mtimeMs,sourceStat.mtimeMs)
writeFileSync(join(output,'results.json'),JSON.stringify({sha,node:process.version,heapLimitMiB:2048,containerLimited:false,scaleScope:'only unrelated export rows scale; other full-snapshot tables remain 1x',sourceUnmodified:true,results},null,2))
