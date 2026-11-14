#!/usr/bin/env node
/** Actual built Nuxt HTTP + real SDK MCP, isolated synthetic business/log storage. */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import assert from 'node:assert/strict'
import { spawnOwnedChild as spawn, reserveLoopbackPort, stopOwnedChild } from './lib/isolated-local-services.mjs'
import { minimalPdf } from '../tests/helpers/minimal-pdf.ts'
const require = createRequire(import.meta.resolve('@nuxtjs/mcp-toolkit'))
const { Client } = require('@modelcontextprotocol/sdk/client/index.js')
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js')
const root = mkdtempSync(join(tmpdir(), 'maintenance183-')), results = []
const api = 'fixture183-api', mcp = 'fixture183-mcp', marker = 'PRIVATE183_SENSITIVE_NONCE'

const { createJiti } = createRequire(import.meta.resolve('nuxt/package.json'))('jiti')
const { initializeDb } = await createJiti(import.meta.url).import('../db/client.ts')
initializeDb({ dbPath: join(root,'business.db'), create: true }).$client.close()
let child, base, output = '', clients = []
const callResponses = []
const delay = ms => new Promise(r => setTimeout(r, ms))
function check(name, run) { run(); results.push({ name, result: 'PASS' }); console.log('PASS '+name) }
async function start(extra = {}) {
  base = 'http://127.0.0.1:'+await reserveLoopbackPort()
  child = spawn(process.execPath, ['.output/server/index.mjs'], { stdio:['ignore','pipe','pipe'], env:{...process.env, HOST:'127.0.0.1', PORT:new URL(base).port, NODE_ENV:'production', NUXT_DB_PATH:join(root,'business.db'), NUXT_DB_READONLY:'0', NUXT_FILES_DIR:join(root,'files'), NUXT_INCOMING_DIR:join(root,'incoming'), NUXT_CURATED_PATH:join(root,'curated.json'), NUXT_RECONCILE_PATH:join(root,'reconcile.json'), NUXT_LOG_DIR:join(root,'logs'), NUXT_API_TOKEN:api, NUXT_MCP_TOKEN:mcp, NUXT_OCR_TOKEN:'', NUXT_MIIT_COOKIE:'', MIIT_COOKIE:'', MIIT_COOKIE_FILE:'', PADDLEOCR_MCP_AISTUDIO_ACCESS_TOKEN:'', ...extra} })
  child.stdout.on('data', b => {output += b}); child.stderr.on('data', b => {output += b})
  for(let i=0;i<150;i++){ if(child.exitCode!==null)throw Error('server exited');try{if((await fetch(base+(extra.NUXT_DB_PATH ? '/api/logs/policy' : '/api/health'),{headers:{authorization:'Bearer '+api}})).ok)return}catch{}await delay(100) }
  throw Error('readiness timeout')
}
async function request(path, options={}) {
  const r=await fetch(base+path,{signal:AbortSignal.timeout(15000),...options}); const text=await r.text(); let body;try{body=JSON.parse(text)}catch{body=text}
  return {status:r.status,body,headers:r.headers}
}
async function sdk(token=mcp) {
  const c=new Client({name:'maintenance183-verifier',version:'1.0.0'})
  await c.connect(new StreamableHTTPClientTransport(new URL(base+'/mcp'),{requestInit:{headers:token?{authorization:'Bearer '+token}:{}},fetch:async (url,init)=>{
    const response=await fetch(url,init)
    if(typeof init?.body==='string') {
      const rpc=JSON.parse(init.body)
      if(rpc.method==='tools/call')callResponses.push({name:rpc.params.name,status:response.status,requestId:response.headers.get('x-request-id')})
    }
    return response
  }}))
  clients.push(c);return c
}
async function logDetails(operation, minimum=1, requestId) {
  for(let i=0;i<70;i++){
    const query=new URLSearchParams({operation,...(requestId?{requestId}:{})})
    const r=await request('/api/logs?'+query,{headers:{authorization:'Bearer '+api}})
    if(r.status===200 && r.body.rows.length>=minimum)return Promise.all(r.body.rows.map(async row=>(await request('/api/logs/'+row.id,{headers:{authorization:'Bearer '+api}})).body))
    await delay(100)
  }
  throw Error('semantic event persistence timeout: '+operation)
}
const write = (path,body,method='POST',token=api) => request(path,{method,headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},body:JSON.stringify(body)})
const bodyOf = result => { assert.ok(!result.isError,JSON.stringify(result)); return result.structuredContent ?? JSON.parse(result.content[0].text) }
async function stop() { for(const c of clients)await c.close().catch(()=>{});clients=[];await stopOwnedChild(child) }
try {
  await start()
  const c=await sdk()
  const result=await c.callTool({name:'list_record_correspondences',arguments:{}})
  check('MCP success keeps original result',()=>assert.ok(!result.isError))
  const events=await logDetails('mcp.tool.list_record_correspondences')
  check('actual SDK MCP success drains one semantic event distinct from transport',()=>{assert.equal(events.length,1);assert.equal(events[0].outcome,'success');assert.ok(events[0].requestId);assert.ok(events[0].durationMs>=0)})
  const failure=await c.callTool({name:'get_record_correspondence',arguments:{id:999999}})
  check('HTTP200 MCP isError keeps original not_found code',()=>{assert.equal(failure.isError,true);assert.equal(JSON.parse(failure.content[0].text).error.code,'not_found');assert.equal(callResponses.find(r=>r.name==='get_record_correspondence').status,200)})
  const failures=await logDetails('mcp.tool.get_record_correspondence')
  check('HTTP200 MCP isError is semantic failure with no invented audit',()=>{assert.equal(failures[0].outcome,'failure');assert.equal(failures[0].errorCode,'not_found');assert.ok(!('auditId' in failures[0]));assert.ok(!('receiptId' in failures[0]))})
  const requestEvents=await request('/api/logs?requestId='+events[0].requestId,{headers:{authorization:'Bearer '+api}})
  check('exactly one evlog request completion accompanies one MCP semantic outcome',()=>{assert.equal(requestEvents.body.rows.length,2);assert.equal(requestEvents.body.rows.filter(r=>r.operation==='mcp.request').length,1)})
  const publicClient=await sdk(null), wrongClient=await sdk(marker)
  const publicTools=(await publicClient.listTools()).tools.map(t=>t.name)
  check('public discovery keeps writes and protected log tools hidden',()=>{assert.ok(publicTools.includes('get_enterprise_profile'));assert.ok(!publicTools.includes('patch_enterprise_profile'));assert.ok(!publicTools.includes('list_runtime_logs'))})
  for(const client of [publicClient,wrongClient,await sdk(api)]) {
    await assert.rejects(()=>client.callTool({name:'list_runtime_logs',arguments:{}}),e=>e.code===401)
  }
  const protectedRead=bodyOf(await c.callTool({name:'list_runtime_logs',arguments:{operation:'mcp.tool.list_record_correspondences'}}))
  check('foundation protected MCP log-read authorization and shared query contract remain intact',()=>assert.equal(protectedRead.rows[0].id,events[0].id))
  for(const client of [publicClient,wrongClient,await sdk(api)]) {
    await assert.rejects(()=>client.callTool({name:'patch_enterprise_profile',arguments:{enterpriseId:1,request:{private:marker}}}),e=>e.code===401)
  }
  const denied=await logDetails('mcp.tool.patch_enterprise_profile',3)
  check('missing wrong and REST-only MCP credentials are denied and redacted',()=>{assert.equal(denied.length,3);for(const e of denied){assert.equal(e.outcome,'denied');assert.equal(e.statusCode,401);assert.equal(e.errorCode,'unauthorized');assert.ok(!JSON.stringify(e).includes(marker))}})
  const batchDenied=await write('/mcp',[{jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'patch_enterprise_profile',arguments:{private:marker}}}],'POST',marker)
  const batchEvents=await logDetails('mcp.tool.batch',1,batchDenied.headers.get('x-request-id'))
  check('RPC batch authorization rejection uses a fixed semantic identifier',()=>{assert.equal(batchDenied.status,401);assert.equal(batchEvents[0].outcome,'denied');assert.equal(batchEvents[0].errorCode,'unauthorized');assert.ok(!JSON.stringify(batchEvents).includes(marker))})
  // SDK schema rejection before the handler and an existing strict middleware rejection.
  await c.callTool({name:'get_record_correspondence',arguments:{id:marker}}).then(r=>assert.equal(r.isError,true),e=>assert.ok([-32602,-32601,400].includes(e.code)))
  await c.callTool({name:'get_official_event',arguments:{eventId:1,[marker]:marker}}).then(r=>assert.equal(r.isError,true),e=>assert.ok([-32602,-32601,400].includes(e.code)))
  await c.callTool({name:marker,arguments:{text:marker}}).then(r=>assert.equal(r.isError,true),e=>assert.ok([-32602,-32601,400].includes(e.code)))
  const invalid=await logDetails('mcp.tool.get_record_correspondence',2)
  check('SDK argument rejection is failure without echoing sensitive validation data',()=>{assert.ok(invalid.some(e=>e.errorCode==='invalid_request'));assert.ok(!JSON.stringify(invalid).includes(marker))})
  const strict=await logDetails('mcp.tool.get_official_event')
  check('strict pre-dispatch rejection is recorded exactly once',()=>{assert.equal(strict.length,1);assert.equal(strict[0].outcome,'failure');assert.equal(strict[0].statusCode,400)})
  const unknown=await logDetails('mcp.tool.unknown')
  check('unknown tool names use a fixed operation identifier',()=>{assert.equal(unknown[0].outcome,'failure');assert.ok(!JSON.stringify(unknown).includes(marker))})
  // Public import seeds one official event; all business mutations go through application APIs.
  const sourceFile='jxj/announcement/2024/1/synthetic183.pdf'
  mkdirSync(join(root,'files/jxj/announcement/2024/1'),{recursive:true})
  writeFileSync(join(root,'files',sourceFile),minimalPdf({pages:1}))
  const registered=await write('/api/files/register',{relPath:sourceFile,source:'jxj',kind:'announcement',year:'2024',batch:'1'})
  assert.equal(registered.status,201)
  const imported=await write('/api/roster/import/commit',{idempotencyKey:'fixture183-import',sourceKind:'announcement',sourceIdentity:sourceFile,sourceSha256:registered.body.sha256,payload:{announcement:{sourceDocument:{source:'jxj',title:marker},records:[{enterprise:{name:marker,city:'宁波市',district:'海曙区'},titleCode:'specialized_sme',events:[{eventType:'award',year:2024,evidence:[{sourceFile,listNo:1,page:1}]}]}]}}})
  assert.equal(imported.body.status,'committed',JSON.stringify(imported.body))
  const id=imported.body.items.find(item=>item.kind==='record_event').detail.enterpriseId, path='/api/roster/enterprises/'+id
  const before=(await request(path+'/profile')).body
  const command={expectedVersion:before.version,changes:{city:null},idempotencyKey:'fixture183-profile',actor:{type:'agent',id:'fixture183'},basis:marker}
  const changed=await write(path,command,'PATCH')
  assert.equal(changed.status,200)
  const replayed=bodyOf(await c.callTool({name:'patch_enterprise_profile',arguments:{enterpriseId:id,request:command}}))
  const httpEvents=await logDetails('maintenance.enterprise_profile.patch'), mcpEvents=await logDetails('mcp.tool.patch_enterprise_profile',4)
  check('HTTP write and SDK replay keep identical authoritative receipt and one audit',()=>{assert.deepEqual(replayed,changed.body);assert.ok(changed.body.auditId>0)})
  const history=(await request(path+'/profile-history')).body
  check('runtime events reference only the returned real audit ID',()=>{assert.equal(history.total,1);assert.equal(history.rows[0].id,changed.body.auditId);assert.equal(httpEvents[0].auditId,changed.body.auditId);assert.equal(mcpEvents.find(e=>e.outcome==='success').auditId,changed.body.auditId);assert.ok(!('receiptId' in httpEvents[0]))})
  const bad=await write(path,{...command,idempotencyKey:'fixture183-stale',changes:{city:'changed'}},'PATCH')
  check('HTTP stale version rejection keeps original domain code',()=>{assert.equal(bad.status,409);assert.equal(bad.body.error.code,'version_conflict')})
  const rejection=(await logDetails('maintenance.enterprise_profile.patch',2)).find(e=>e.outcome==='failure')
  check('rejected transaction has no fabricated audit or receipt association',()=>{assert.equal(rejection.errorCode,'version_conflict');assert.ok(!('auditId'in rejection));assert.ok(!('receiptId'in rejection))})
  const httpDenied=await write(path,command,'PATCH',marker)
  assert.equal(httpDenied.status,401)
  const spoof=await write(path,{...command,auditId:999999,receiptId:marker,[marker]:marker},'PATCH')
  const spoofEvents=await logDetails('maintenance.enterprise_profile.patch',1,spoof.headers.get('x-request-id'))
  check('rejected client audit and receipt IDs never become log correlations',()=>{assert.equal(spoof.status,400);assert.equal(spoofEvents[0].outcome,'failure');assert.equal(spoofEvents[0].errorCode,'invalid_request');assert.ok(!('auditId'in spoofEvents[0]));assert.ok(!('receiptId'in spoofEvents[0]));assert.ok(!JSON.stringify(spoofEvents).includes(marker))})
  const detail=(await request(path)).body, eventId=detail.events[0].id
  const event=(await request('/api/roster/events/'+eventId)).body
  const evidenceId=event.evidence[0].id
  const evidence=(await request('/api/roster/evidence/'+evidenceId)).body
  const scope={enterpriseId:id,titleCode:'specialized_sme',direction:'missing_in_miit'}
  const scopeQuery=new URLSearchParams(scope).toString()
  const current=(await request('/api/roster/decision-lifecycle/current?'+scopeQuery)).body
  const proofList=(await request('/api/roster/comparison-scope-proofs')).body
  assert.deepEqual(bodyOf(await c.callTool({name:'get_official_event',arguments:{eventId}})),event)
  assert.deepEqual(bodyOf(await c.callTool({name:'get_roster_evidence',arguments:{id:evidenceId}})),evidence)
  assert.deepEqual(bodyOf(await c.callTool({name:'get_current_difference_decision',arguments:scope})),current)
  assert.deepEqual(bodyOf(await c.callTool({name:'list_comparison_scope_proofs',arguments:{}})),proofList)
  check('event evidence decision and proof HTTP reads agree with real SDK results',()=>{assert.ok(event.event.id>0);assert.ok(evidence.evidenceId>0)})
  for(const operation of ['maintenance.event.get','maintenance.evidence.get','maintenance.decision.current','maintenance.proof.list']) {
    const e=await logDetails(operation)
    assert.equal(e[0].outcome,'success');assert.ok(!('auditId' in e[0]));assert.ok(!('receiptId' in e[0]))
  }
  check('all maintenance read adapters emit semantic success without inventing audits',()=>assert.equal(current.current,null))
  // A decision version ID is a resource, never relabeled as a business audit/receipt ID.
  const decisionCommand={...scope,action:'replace',expectedCurrentId:null,idempotencyKey:'fixture183-decision',actor:{type:'agent',id:'fixture183'},basis:marker,ruleVersion:'fixture183',effectiveAt:'2026-10-22T00:00:00Z',decision:{status:'needs_review',measureCode:'manual_review',verificationStatus:'pending'}}
  const decision=await write('/api/roster/decision-lifecycle/commands',decisionCommand)
  assert.equal(decision.status,200,JSON.stringify(decision.body))
  const decisionReplay=bodyOf(await c.callTool({name:'save_difference_decision',arguments:decisionCommand}))
  const decisionEvents=await logDetails('maintenance.decision.commands')
  check('decision HTTP commit and MCP replay retain stable version identity',()=>{assert.deepEqual(decisionReplay,decision.body);assert.equal(decisionEvents[0].resourceId,decision.body.versionId);assert.equal(decisionEvents[0].resourceType,'difference_decision_version');assert.ok(!('auditId'in decisionEvents[0]))})
  const renamed=await write(path,{...command,expectedVersion:changed.body.version,changes:{name:'fixture183-renamed'},previousName:{name:marker,sameSubject:true},idempotencyKey:'fixture183-rename'},'PATCH')
  assert.equal(renamed.status,200,JSON.stringify(renamed.body))
  const aliasId=renamed.body.retainedAlias.id, aliasPath=path+'/aliases/'+aliasId
  const alias=(await request(aliasPath)).body
  const aliasCommand={action:'withdraw',expectedVersion:alias.version,actor:'fixture183',basis:marker,idempotencyKey:'fixture183-alias'}
  const aliasChange=await write(aliasPath,aliasCommand,'PATCH')
  assert.equal(aliasChange.status,200)
  const aliasReplay=bodyOf(await c.callTool({name:'maintain_enterprise_alias',arguments:{enterpriseId:id,aliasId,...aliasCommand}}))
  const aliasEvents=await logDetails('maintenance.alias.patch')
  const aliasHistory=(await request(aliasPath+'/history')).body
  const aliasList=(await request(path+'/aliases')).body
  check('alias maintenance preserves MCP replay and separate append-only history',()=>{assert.deepEqual(aliasReplay.alias,aliasChange.body.alias);assert.equal(aliasHistory.total,1);assert.equal(aliasList.rows[0].verificationStatus,'withdrawn');assert.equal(aliasEvents[0].resourceId,aliasId);assert.ok(!('auditId'in aliasEvents[0]))})
  for(const [url,op] of [['/api/roster/events/999999','maintenance.event.get'],['/api/roster/evidence/999999','maintenance.evidence.get'],['/api/roster/comparison-scope-proofs/999999','maintenance.proof.get']]) {
    const rejected=await request(url);assert.equal(rejected.status,404)
    const es=await logDetails(op,op==='maintenance.proof.get'?1:2)
    assert.ok(es.some(e=>e.outcome==='failure' && e.errorCode==='not_found'))
  }
  check('event evidence and proof HTTP domain rejections stay failures',()=>assert.equal(aliasEvents[0].outcome,'success'))
  const all=await request('/api/logs?limit=100',{headers:{authorization:'Bearer '+api}})
  const details=await Promise.all(all.body.rows.map(async row=>(await request('/api/logs/'+row.id,{headers:{authorization:'Bearer '+api}})).body))
  check('public summaries and details exclude input text source paths and synthetic tokens',()=>{for(const secret of [marker,sourceFile,api,mcp])assert.ok(!JSON.stringify({all:all.body,details}).includes(secret))})
  check('protected log tools emit no recursive semantic events',()=>assert.ok(!all.body.rows.some(row=>row.operation==='mcp.tool.list_runtime_logs')))
  await stop()
  // Unavailable log directory, same persisted fixture, no test-only injection into business code.
  await start({NUXT_LOG_DIR:'/dev/null/PRIVATE183_SENSITIVE_NONCE'})
  const faultClient=await sdk(), faultReplay=bodyOf(await faultClient.callTool({name:'patch_enterprise_profile',arguments:{enterpriseId:id,request:command}}))
  const faultCommand={...command,expectedVersion:renamed.body.version,idempotencyKey:'fixture183-fault',changes:{district:'鄞州区'}}
  const faultWrite=await write(path,faultCommand,'PATCH')
  check('real drain failure preserves HTTP commit and exact MCP replay receipt',()=>{assert.deepEqual(faultReplay,changed.body);assert.equal(faultWrite.status,200);assert.ok(faultWrite.body.auditId>changed.body.auditId)})
  const faultHistory=(await request(path+'/profile-history')).body
  assert.equal(faultHistory.total,3)
  await delay(400)
  const faultStatus=await request('/api/logs/policy',{headers:{authorization:'Bearer '+api}})
  check('failed logging exposes unavailable and drop accounting independently of business audits',()=>{assert.equal(faultStatus.status,503);assert.equal(faultStatus.body.status.unavailable,true);assert.ok(faultStatus.body.status.dropped>0)})
  await stop()
  // Force genuine domain DB initialization failure; log storage is healthy and independent.
  await start({NUXT_DB_PATH:'/dev/null/PRIVATE183_SENSITIVE_NONCE'})
  const initClient=await sdk()
  const initFailure=await initClient.callTool({name:'get_enterprise_profile',arguments:{enterpriseId:1}})
  check('real domain initialization exception is sanitized at MCP boundary',()=>{assert.equal(initFailure.isError,true);assert.equal(JSON.parse(initFailure.content[0].text).error.code,'internal_error');assert.ok(!JSON.stringify(initFailure).includes(marker))})
  const initEvents=await logDetails('mcp.tool.get_enterprise_profile')
  check('domain initialization failure drains a semantic failure with no guessed IDs',()=>{assert.equal(initEvents[0].outcome,'failure');assert.ok(!('auditId'in initEvents[0]));assert.ok(!JSON.stringify(initEvents).includes(marker))})
  const initHttp=await request('/api/roster/enterprises/1/profile')
  const initHttpEvents=await logDetails('maintenance.enterprise_profile.get',1,initHttp.headers.get('x-request-id'))
  check('actual HTTP initialization failure retains native 500 and sanitized semantic event',()=>{assert.equal(initHttp.status,500);assert.equal(initHttpEvents[0].outcome,'failure');assert.equal(initHttpEvents[0].statusCode,500);assert.ok(!JSON.stringify({body:initHttp.body,events:initHttpEvents}).includes(marker))})
  await stop()
  check('privacy nonce never appears in captured stdout stderr or persisted log-store bytes',()=>{assert.ok(!output.includes(marker));assert.ok(!readFileSync(join(root,'logs/events.db')).includes(Buffer.from(marker)))})
  console.log(JSON.stringify({root,results},null,2))
} catch(error) {console.error(error);process.exitCode=1}
finally {await stop();writeFileSync(join(root,'server-output.log'),output);writeFileSync(join(root,'results.json'),JSON.stringify({sha:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),dirty:execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim(),results},null,2));console.log('Evidence directory: '+root)}
