#!/usr/bin/env node
/** Actual built Nuxt, independent fixture paths, only public operation/log APIs. */
import assert from 'node:assert/strict'
import { minimalPdf } from '../tests/helpers/minimal-pdf.ts'

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnOwnedChild as spawn, reserveLoopbackPort, waitForHttp, stopOwnedChild } from './lib/isolated-local-services.mjs'
const root=mkdtempSync(join(tmpdir(),'job184-public-'))
const marker='PRIVATE184_PUBLIC'
const results=[]
const check=(name,fn)=>{fn();results.push({name,result:'PASS'})}
const delay=ms=>new Promise(r=>setTimeout(r,ms))
let child,base,output=''
const env={...process.env,NODE_ENV:'production',HOST:'127.0.0.1',NUXT_DB_PATH:join(root,'fixture.db'),NUXT_FILES_DIR:join(root,'files'),NUXT_INCOMING_DIR:join(root,'incoming'),NUXT_CURATED_PATH:join(root,'curated.json'),NUXT_RECONCILE_PATH:join(root,'reconcile.json'),NUXT_LOG_DIR:join(root,'logs'),NUXT_API_TOKEN:'fixture-api184',NUXT_MCP_TOKEN:'fixture-mcp184',MIIT_COOKIE:'',NUXT_OCR_TOKEN:'',NUXT_DB_READONLY:'0'}
mkdirSync(env.NUXT_FILES_DIR,{recursive:true})
async function start(extra={}){
 const port=await reserveLoopbackPort();base=`http://127.0.0.1:${port}`
 child=spawn(process.execPath,['.output/server/index.mjs'],{env:{...env,...extra,PORT:String(port)},stdio:['ignore','pipe','pipe']})
 child.stdout.on('data',b=>{output+=b});child.stderr.on('data',b=>{output+=b})
 await waitForHttp(base+'/api/health',{child,timeoutMs:20000})
}
async function request(path,opts={}){const r=await fetch(base+path,{signal:AbortSignal.timeout(10000),...opts});const text=await r.text();let body;try{body=JSON.parse(text)}catch{body=text}return {status:r.status,body,headers:r.headers}}
const headers={authorization:'Bearer fixture-api184','content-type':'application/json'}
async function rows(query){const r=await request('/api/logs?'+new URLSearchParams({...query,limit:'100'}),{headers});assert.equal(r.status,200);return r.body.rows}
async function terminal(id){for(let i=0;i<100;i++){const r=await request('/api/jobs/'+id);if(['done','failed','cancelled'].includes(r.body.state))return r.body;await delay(50)}throw Error('job timeout')}
async function logged(query,op){for(let i=0;i<80;i++){const r=await rows(query);if(r.some(e=>e.operation===op))return r;await delay(50)}throw Error('log timeout '+op)}
async function mcp(name,args){const r=await request('/mcp',{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream',authorization:'Bearer fixture-mcp184'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})});if(typeof r.body==='string'){const line=r.body.split('\n').find(s=>s.startsWith('data:'));if(line)r.body=JSON.parse(line.slice(5))}return r}
async function submit(file=marker+'.pdf'){return request('/api/jobs',{method:'POST',headers,body:JSON.stringify({kind:'render-pages',params:{files:[file]}})})}
try{
 await start()
 const accepted=await submit();assert.equal(accepted.status,202)
 const done=await terminal(accepted.body.jobId)
 check('actual HTTP task preserves failed render result',()=>{assert.equal(done.state,'failed');assert.equal(done.result.files[0].file,marker+'.pdf');assert.equal(done.result.failed,1)})
 const tasks=await logged({taskId:done.id},'task.finished')
 check('actual HTTP submission drain survives response with one terminal and trusted context',()=>{assert.equal(tasks.filter(e=>e.operation==='task.finished').length,1);assert.ok(tasks.some(e=>e.operation==='task.queued'));assert.ok(tasks.some(e=>e.operation==='task.started'));assert.ok(tasks.every(e=>e.requestId===accepted.headers.get('x-request-id')));assert.ok(tasks.every(e=>e.traceId===tasks[0].traceId))})
 const completion=await logged({requestId:accepted.headers.get('x-request-id')},'http.request')
 check('evlog alone owns HTTP request completion',()=>assert.equal(completion.filter(e=>e.operation==='http.request').length,1))
 const cancelled=await request('/api/jobs/'+done.id,{method:'DELETE',headers})
 check('actual terminal cancellation remains a no-op',()=>{assert.equal(cancelled.status,200);assert.equal(cancelled.body.state,'failed');assert.equal(cancelled.body.alreadyFinished,true)})
 await delay(150)
 const afterCancel=await rows({taskId:done.id})
 check('repeated actual cancellation does not duplicate task terminal',()=>assert.equal(afterCancel.filter(e=>e.operation==='task.finished').length,1))
 writeFileSync(join(env.NUXT_FILES_DIR,'synthetic184.pdf'),minimalPdf({pages:1}))
 const success=await submit('synthetic184.pdf');assert.equal(success.status,202)
 const rendered=await terminal(success.body.jobId)
 check('actual HTTP render task succeeds with original page result',()=>{assert.equal(rendered.state,'done');assert.equal(rendered.result.files[0].pageCount,1);assert.equal(rendered.result.files[0].written,1)})
 const successLogs=await logged({taskId:rendered.id},'task.finished')
 check('actual successful task drains one correlated terminal',()=>{assert.deepEqual(successLogs.filter(e=>e.operation==='task.finished').map(e=>e.outcome),['success']);assert.ok(successLogs.every(e=>e.requestId===success.headers.get('x-request-id')))})
 for(const kind of ['http','mcp']){
  const r=kind==='http'?await request('/api/roster/enterprises?q='+marker):await mcp('list_enterprises',{q:marker})
  check('actual '+kind+' enterprise read keeps public success',()=>{assert.equal(r.status,200);if(kind==='mcp')assert.ok(!r.body.result.isError);else assert.deepEqual(r.body.rows,[])})
  const found=await logged({requestId:r.headers.get('x-request-id')},'enterprise_read.finished')
  // Wait for the independent child drain, not just the parent acknowledgement.
  let childRows=found
  for(let i=0;i<80 && childRows.filter(e=>e.operation==='enterprise_read.execute').length<2;i++){await delay(50);childRows=await rows({requestId:r.headers.get('x-request-id')})}
  check('actual '+kind+' parent and child real drains share request context',()=>{assert.equal(childRows.filter(e=>e.operation==='enterprise_read.finished').length,1);assert.deepEqual(childRows.filter(e=>e.operation==='enterprise_read.execute').map(e=>e.outcome).sort(),['started','success']);assert.equal(new Set(childRows.map(e=>e.traceId)).size,1)})
 }
 // First-open file identity is intentionally ineligible for off-main fallback.
 // Reopen the application-created fixture to exercise its established owner.
 await stopOwnedChild(child); await start()
 for(const path of ['/api/roster/current-enterprises?titleCode=specialized_sme','/api/roster/recognitions','/api/roster/differences','/api/comparison?view=summary']){
  const r=await request(path);assert.equal(r.status,200)
  const found=await logged({requestId:r.headers.get('x-request-id')},'enterprise_read.finished')
  check('actual read adapter carries known context '+path,()=>{assert.equal(found.filter(e=>e.operation==='enterprise_read.finished').length,1);assert.ok(found.every(e=>e.traceId===found[0].traceId))})
 }
 const current=await mcp('list_current_qualified_enterprises',{titleCode:'specialized_sme'})
 check('actual MCP current-qualified adapter preserves success and correlation header',()=>{assert.equal(current.status,200);assert.ok(!current.body.result.isError);assert.ok(current.headers.get('x-request-id'))})
 const currentLogs=await logged({requestId:current.headers.get('x-request-id')},'enterprise_read.finished')
 check('actual MCP current-qualified child context is explicit',()=>assert.equal(currentLogs.filter(e=>e.operation==='enterprise_read.finished').length,1))
 const all=await rows({})
 const details=await Promise.all(all.map(e=>request('/api/logs/'+e.id,{headers})))
 check('actual protected summary detail and stdout exclude synthetic private inputs',()=>{assert.ok(!JSON.stringify(all).includes(marker));assert.ok(!JSON.stringify(details).includes(marker));assert.ok(!output.includes(marker));assert.ok(!JSON.stringify(details).includes(root))})
 await stopOwnedChild(child)
 // Independent log directory is an owned fixture file: force persistence failure.
 const broken=join(root,'blocked-log-directory');writeFileSync(broken,'fixture')
 await start({NUXT_LOG_DIR:broken})
 const failedLogTask=await submit();const unchanged=await terminal(failedLogTask.body.jobId)
 check('actual log storage fault preserves task result and original submission status',()=>{assert.equal(failedLogTask.status,202);assert.equal(unchanged.state,'failed');assert.deepEqual(unchanged.result,done.result)})
 const read=await request('/api/roster/enterprises?q='+marker)
 check('actual log storage fault preserves child read success',()=>{assert.equal(read.status,200);assert.deepEqual(read.body.rows,[])})
 await delay(500)
 const policy=await request('/api/logs/policy',{headers})
 check('actual log storage fault remains observable through protected status',()=>{assert.equal(policy.status,503);assert.equal(policy.body.status.unavailable,true)})
 await stopOwnedChild(child)
 check('fault fallback contains no private input or fixture paths',()=>{assert.ok(!output.includes(marker));assert.ok(!output.includes(root))})
 const report={sourceSha:process.env.EVIDENCE_SHA??null,tree:process.env.EVIDENCE_TREE??null,root,lane:'actual built Nuxt HTTP/MCP and native child',results}
 writeFileSync(join(root,'report.json'),JSON.stringify(report,null,2));writeFileSync(join(root,'server.log'),output)
 console.log(JSON.stringify(report,null,2))
}finally{await stopOwnedChild(child);writeFileSync(join(root,'server.log'),output)}
