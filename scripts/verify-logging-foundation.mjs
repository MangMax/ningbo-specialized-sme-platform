#!/usr/bin/env node
/** #181 actual built Nuxt seam. Uses only a fresh synthetic business DB and independent log directory. */
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, openSync, writeSync, closeSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'node:net'
import { once } from 'node:events'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
const root = mkdtempSync(join(tmpdir(), 'logging181-public-'))
const dbPath = join(root, 'synthetic.db'), logs = join(root, 'logs')
const db = new Database(dbPath); migrate(drizzle(db), { migrationsFolder: resolve('db/migrations') }); db.close()
const beforeBusiness = readFileSync(dbPath)
const privateMarker = 'PRIVATE181_PAYLOAD_MARKER'
const results = []
const checks = (name, fn) => { fn(); results.push({ name, result: 'PASS' }) }
let child, output = '', base
const delay = ms => new Promise(r => setTimeout(r, ms))
const env = { ...process.env, HOST: '127.0.0.1', NODE_ENV: 'production', NUXT_DB_PATH: dbPath, NUXT_DB_READONLY: '1', NUXT_FILES_DIR: join(root, 'files'), NUXT_INCOMING_DIR: join(root, 'incoming'), NUXT_LOG_DIR: logs, NUXT_API_TOKEN: 'fixture-api181', NUXT_MCP_TOKEN: 'fixture-mcp181', NUXT_BROWSER_LOGS_ENABLED: 'false' }
async function start(extra = {}) {
  const socket = createServer(); socket.listen(0,'127.0.0.1'); await once(socket,'listening'); const port = socket.address().port; await new Promise(r=>socket.close(r))
  base = `http://127.0.0.1:${port}`
  child = spawn(process.execPath, ['.output/server/index.mjs'], { env: { ...env, ...extra, PORT: String(port) }, stdio: ['ignore','pipe','pipe'] })
  child.stdout.on('data',b=>{output += b}); child.stderr.on('data',b=>{output += b})
  for (let i=0;i<100;i++) { if (child.exitCode !== null || child.signalCode) throw Error('built server exited'); try { if ((await fetch(base+'/api/health',{signal:AbortSignal.timeout(2000)})).status===200) return } catch {} await delay(100) }
  throw Error('built server readiness timeout')
}
async function stop(signal='SIGTERM') {
  const owned=child
  if(!owned || owned.exitCode!==null || owned.signalCode)return
  const closed=once(owned,'exit'), timeout=setTimeout(()=>owned.kill('SIGKILL'),5000)
  owned.kill(signal)
  try{await closed}finally{clearTimeout(timeout)}
}
const apiHeaders = { authorization:'Bearer fixture-api181' }
async function request(path, opts={}) { const r = await fetch(base+path,{signal:AbortSignal.timeout(10000),...opts}); const text = await r.text(); let body; try {body=JSON.parse(text)}catch{body=text} return {status:r.status,body,headers:r.headers} }
async function pollLogs(query) { for(let i=0;i<60;i++){ const r=await request('/api/logs?'+query,{headers:apiHeaders}); if(r.status===200 && r.body.rows.length) return r.body; await delay(100) } throw Error('event persistence timeout') }
async function mcp(method,params,token) {
  const r = await request('/mcp',{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream',...(token?{authorization:`Bearer ${token}`}:{})},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})})
  if(typeof r.body==='string'){ const line=r.body.split('\n').find(s=>s.startsWith('data:')); if(line) r.body=JSON.parse(line.slice(5)) }
  return r
}
function resultBody(r) { const result=r.body.result; if(result.structuredContent) return result.structuredContent; return JSON.parse(result.content[0].text) }
try {
  await start()
  const healthy = await request('/api/health?token='+privateMarker,{headers:{authorization:'Bearer '+privateMarker,cookie:privateMarker,'x-request-id':privateMarker}})
  checks('actual HTTP keeps result and generates trusted request identifier',()=>{ assert.equal(healthy.status,200); assert.match(healthy.headers.get('x-request-id'),/^[a-f0-9-]{36}$/); assert.notEqual(healthy.headers.get('x-request-id'),privateMarker) })
  for(const path of ['/api/logs','/api/logs/policy']) for(const token of [undefined,'bad','fixture-mcp181']) {
    const denied=await request(path,{headers:token?{authorization:'Bearer '+token}:{}})
    checks('REST protected read rejects '+path+' '+(token||'missing'),()=>assert.equal(denied.status,401))
  }
  const sameOrigin=await request('/api/logs',{headers:{'x-log-browser':'1','sec-fetch-site':'same-origin',referer:base+'/logs'}})
  checks('same origin alone cannot enable sensitive log reads',()=>assert.equal(sameOrigin.status,401))
  const row = (await pollLogs('requestId='+healthy.headers.get('x-request-id'))).rows[0]
  checks('real Nuxt HTTP evlog drain readback is safe and bounded',()=>{ assert.equal(row.source,'http'); assert.equal(row.statusCode,200); assert.equal(row.outcome,'success'); assert.ok(row.durationMs>=0); assert.ok(!JSON.stringify(row).includes(privateMarker)) })
  const detail = await request('/api/logs/'+row.id,{headers:apiHeaders})
  checks('protected actual detail readback',()=>{assert.equal(detail.status,200);assert.equal(detail.body.id,row.id);assert.equal(detail.headers.get('cache-control'),'no-store')})
  const refused = await request('/api/jobs/not-a-job?token='+privateMarker)
  const refusedRow = (await pollLogs('requestId='+refused.headers.get('x-request-id'))).rows
  checks('actual domain rejection keeps its response and records exactly one request event',()=>{assert.equal(refused.status,400);assert.equal(refused.body.statusCode,400);assert.equal(refused.body.error,true);assert.equal(refused.body.url,base+'/api/jobs/not-a-job?token='+privateMarker);assert.ok(!('status' in refused.body));assert.equal(refused.headers.get('x-content-type-options'),'nosniff');assert.equal(refusedRow.length,1);assert.equal(refusedRow[0].outcome,'denied');assert.equal(refusedRow[0].statusCode,400)})
  const listed = await mcp('tools/list',{},undefined)
  checks('actual MCP public operation still succeeds and hides protected tools',()=>{assert.equal(listed.status,200); assert.ok(listed.body.result.tools.length>0);assert.ok(!listed.body.result.tools.some(t=>t.name==='list_runtime_logs'))})
  const mcpRows = await pollLogs('requestId='+listed.headers.get('x-request-id'))
  checks('real MCP request event persisted through evlog',()=>assert.equal(mcpRows.rows[0].source,'mcp'))
  for(const token of [undefined,'bad','fixture-api181']){
    const denied=await mcp('tools/call',{name:'list_runtime_logs',arguments:{}},token)
    checks('MCP sensitive read rejects '+(token||'missing'),()=>assert.equal(denied.status,401))
  }
  const rpc = await mcp('tools/call',{name:'list_runtime_logs',arguments:{requestId:healthy.headers.get('x-request-id')}},'fixture-mcp181')
  checks('REST and actual MCP return the same event',()=>{assert.equal(rpc.status,200);assert.equal(resultBody(rpc).rows[0].id,row.id)})
  const policy = await request('/api/logs/policy',{headers:apiHeaders})
  checks('frozen defaults and accounting exposed',()=>{assert.equal(policy.body.retentionDays,7);assert.equal(policy.body.maxBytes,536870912);assert.equal(policy.body.status.unavailable,false);assert.ok(policy.body.storageBytes>0)})
  const changed=await request('/api/logs/policy',{method:'PATCH',headers:{...apiHeaders,'content-type':'application/json'},body:JSON.stringify({retentionDays:2,maxBytes:2097152})})
  checks('actual REST policy update',()=>assert.equal(changed.status,200))
  const mcpPolicy=await mcp('tools/call',{name:'get_runtime_log_policy',arguments:{}},'fixture-mcp181')
  checks('actual MCP observes shared policy',()=>assert.equal(resultBody(mcpPolicy).retentionDays,2))
  const unbounded=await request('/api/logs/clear',{method:'POST',headers:{...apiHeaders,'content-type':'application/json'},body:JSON.stringify({confirm:true})})
  checks('unbounded actual clear is refused',()=>assert.equal(unbounded.status,400))
  const clear=await request('/api/logs/clear',{method:'POST',headers:{...apiHeaders,'content-type':'application/json'},body:JSON.stringify({from:'2000-01-01',to:'2100-01-01',requestId:row.requestId,confirm:true})})
  checks('actual filtered clear deletes precisely one request',()=>{assert.equal(clear.status,200);assert.equal(clear.body.deleted,1)})
  const absent=await request('/api/logs/'+row.id,{headers:apiHeaders})
  checks('cleared detail is absent',()=>assert.equal(absent.status,404))
  await stop(); await start()
  const restarted=await request('/api/logs/policy',{headers:apiHeaders})
  checks('graceful shutdown and restart preserve policy and operation receipts',()=>{assert.equal(restarted.body.retentionDays,2);assert.ok(restarted.body.cleared>=1)})
  const receipt=await pollLogs('operation=logging.clear')
  checks('clear result is an independent diagnostic event',()=>assert.equal(receipt.rows[0].outcome,'success'))
  const durableId=receipt.rows[0].id
  await stop('SIGKILL'); await start()
  const durable=await request('/api/logs/'+durableId,{headers:apiHeaders})
  checks('abrupt process exit preserves previously committed events',()=>assert.equal(durable.status,200))
  await stop()
  await start({NUXT_BROWSER_LOGS_ENABLED:'true'})
  const browser=await request('/api/logs',{headers:{'x-log-browser':'1','sec-fetch-site':'same-origin',referer:base+'/logs'}})
  const cross=await request('/api/logs',{headers:{'x-log-browser':'1','sec-fetch-site':'same-origin',referer:'http://untrusted.invalid/logs'}})
  checks('explicit page capability accepts matching provenance and rejects foreign provenance',()=>{assert.equal(browser.status,200);assert.equal(cross.status,401)})
  await stop()
  chmodSync(join(logs,'events.db'),0o444)
  await start()
  const healthyReadonly=await request('/api/health')
  await delay(400)
  const readonlyStatus=await request('/api/logs/policy',{headers:apiHeaders})
  checks('real readonly SQLite drain cannot change business HTTP result',()=>{assert.equal(healthyReadonly.status,200);assert.deepEqual(healthyReadonly.body,healthy.body);assert.ok(readonlyStatus.body.status.unavailable);assert.ok(readonlyStatus.body.status.dropped>0)})
  await stop(); chmodSync(join(logs,'events.db'),0o600)
  await start({NUXT_LOG_DIR:'/dev/null/PRIVATE181_PATH'})
  const inaccessibleHealth=await request('/api/health'); assert.equal(inaccessibleHealth.status,200);assert.deepEqual(inaccessibleHealth.body,healthy.body); await delay(350)
  const unavailable=await request('/api/logs/policy',{headers:apiHeaders})
  checks('actual inaccessible drain returns protected failure accounting',()=>{assert.equal(unavailable.status,503);assert.equal(unavailable.body.status.unavailable,true);assert.ok(unavailable.body.status.dropped>0);assert.ok(!JSON.stringify(unavailable.body).includes('PRIVATE181'))})
  await stop()
  if(process.env.LOG181_FULL_MOUNT) {
    const mount=process.env.LOG181_FULL_MOUNT, fullLogs=join(mount,'logs'), filler=join(mount,'fixture-filler')
    mkdirSync(fullLogs,{recursive:true})
    await start({NUXT_LOG_DIR:fullLogs}); await pollLogs('source=http'); await stop()
    const fd=openSync(filler,'w'); let full=false
    try { const bytes=Buffer.alloc(65536); for(let i=0;i<1024;i++)writeSync(fd,bytes) } catch(e) { if(e.code!=='ENOSPC')throw e;full=true } finally{closeSync(fd)}
    checks('dedicated fixture volume reports real filesystem ENOSPC',()=>assert.equal(full,true))
    try {
      await start({NUXT_LOG_DIR:fullLogs})
      for(let i=0;i<100;i++) { const health=await request('/api/health');assert.equal(health.status,200);assert.deepEqual(health.body,healthy.body) }
      await delay(500)
      const fullStatus=await request('/api/logs/policy',{headers:apiHeaders})
      checks('real full filesystem drain does not change business result and exposes drops',()=>{assert.ok(fullStatus.body.status.unavailable);assert.ok(fullStatus.body.status.dropped>0)})
    } finally {await stop();unlinkSync(filler)}
  }
  checks('privacy marker absent from all process output',()=>assert.ok(!output.includes(privateMarker) && !output.includes('PRIVATE181_PATH')))
  checks('business SQLite bytes unchanged throughout public acceptance',()=>assert.deepEqual(readFileSync(dbPath),beforeBusiness))
  console.log(JSON.stringify({root,checks:results},null,2))
} catch(error) { console.error(error); process.exitCode=1 }
finally { await stop(); writeFileSync(join(root,'server-output.log'),output); writeFileSync(join(root,'results.json'),JSON.stringify(results,null,2)); console.log('Evidence directory: '+root) }
