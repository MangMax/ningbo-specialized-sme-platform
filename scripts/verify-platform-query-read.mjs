#!/usr/bin/env node
// Runs only a local production artifact with a synthetic temporary database; no live platform traffic.
import assert from 'node:assert/strict'

import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { setTimeout as sleep } from 'node:timers/promises'
import { spawnOwnedChild as spawn, reserveLoopbackPort, stopOwnedChild, getOwnedChildStartFailure } from './lib/isolated-local-services.mjs'
// Every acquired handle belongs to this invocation; failures clean the private root.
let dir, db, child, childError, receipt
let attempted = false
let dbClosed = true
let primaryError
const cleanupErrors=[]
try {
const { createJiti } = createRequire(import.meta.resolve('nuxt/package.json'))('jiti')
const jiti = createJiti(import.meta.url)
const { useDb, schema } = await jiti.import('../db/client.ts')
dir=mkdtempSync(join(tmpdir(),'verify-platform-read-'))
const dbPath=join(dir,'test.sqlite')
db=useDb({dbPath})
const raw='完整原文🙂'.repeat(40)
const evidence={titleScope:{rdjb:['1','2']},pages:[{rdjb:'1',page:1,status:'success',fetchedCount:2,rawResponse:raw}],rows:[{id:'same',original:'原行一'},{id:'same',original:'原行二'}]}
const enterpriseId=db.insert(schema.enterprise).values({name:'合成企业',nameNorm:'合成企业'}).returning().get().id
const ids=[], relationIds=[]
for (const [index,status] of ['success','failed','partial','no_record','not_queried'].entries()) {
 const id=db.insert(schema.platformQuery).values({interface:'recognized_list',queryKey:'synthetic:public',rdjb:String(index),queriedAt:'2026-10-19',status,rawResponse:raw,collectionEvidence:evidence}).returning().get().id
 ids.push(id)
 const relations={}
 for(const sequenceNo of [2,1]) relations[sequenceNo]=db.insert(schema.platformRelation).values({queryId:id,sequenceNo,enterpriseId:sequenceNo===1?enterpriseId:null,usccRaw:'synthetic:relation',relationKey:'same',rawFields:{id:'same',original:`原行${sequenceNo}`}}).returning().get().id
 relationIds.push(relations)
}
const largeId=db.insert(schema.platformQuery).values({interface:'apply_list',queryKey:'synthetic:large',queriedAt:'2026-10-19',status:'success',rawResponse:'原'.repeat(1_500_000)}).returning().get().id
const otherEnterpriseId=db.insert(schema.enterprise).values({name:'反例企业',nameNorm:'反例企业'}).returning().get().id
const otherId=db.insert(schema.platformQuery).values({interface:'business_list',queryKey:'synthetic:other',titleCode:'little_giant',rdjb:'3',queriedAt:'2026-10-20',status:'failed',rawResponse:'反例原文',collectionEvidence:{titleScope:{rdjb:['3']}}}).returning().get().id
const otherRelationId=db.insert(schema.platformRelation).values({queryId:otherId,sequenceNo:1,enterpriseId:otherEnterpriseId,usccRaw:'synthetic:other-uscc',relationKey:'other',rawFields:{id:'other',original:'反例行'}}).returning().get().id
db.$client.close()
const port=await reserveLoopbackPort()
const base=`http://127.0.0.1:${port}`
attempted=true
try {
child=spawn(process.execPath,['--max-old-space-size=2048','.output/server/index.mjs'],{env:{...process.env,PORT:String(port),HOST:'127.0.0.1',NUXT_DB_PATH:dbPath,NUXT_FILES_DIR:dir,NUXT_API_TOKEN:'synthetic-only',NUXT_MCP_TOKEN:'synthetic-only',MIIT_COOKIE:'',MIIT_COOKIE_FILE:''},stdio:['ignore','pipe','pipe']})
} catch(error) {
 child=getOwnedChildStartFailure(error)?.child
 if(child)try{registerChild()}catch(registrationError){cleanupErrors.push(new Error('Partial child registration failed',{cause:registrationError}))}
 throw error
}
registerChild()
function registerChild() {
 child.on('error',error=>{childError=error})
 for(const stream of new Set(child.stdio??[])) {
   stream?.on?.('error',error=>{childError??=error})
   stream?.resume?.()
 }
}
// One deadline covers both headers and complete body consumption. Abort also
// releases bodies on status-only assertions and parse/transport failures.
async function request(url,options={},timeoutMs=2_000) {
 const controller=new AbortController()
 const timer=setTimeout(()=>controller.abort(new Error('Local request deadline exceeded')),timeoutMs)
 try {
   const response=await fetch(url,{...options,signal:controller.signal})
   const text=await response.text()
   return {status:response.status,ok:response.ok,headers:response.headers,
     text:async()=>text,json:async()=>JSON.parse(text)}
 } finally {clearTimeout(timer);controller.abort()}
}
let rpcId=0
async function rpc(method,params) {
 const r=await request(`${base}/mcp`,{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:++rpcId,method,params})})
 const raw=await r.text(), line=raw.split('\n').find(s=>s.startsWith('data: '))?.slice(6)??raw
 return {status:r.status,body:JSON.parse(line),headers:r.headers}
}
async function call(name,args) { const r=await rpc('tools/call',{name,arguments:args});assert.equal(r.status,200);assert.ok(!r.body.error,JSON.stringify(r.body.error));assert.ok(!r.body.result.isError,JSON.stringify(r.body.result));return JSON.parse(r.body.result.content[0].text) }
async function get(params) {const r=await request(`${base}/api/platform/queries?${new URLSearchParams(params)}`);assert.equal(r.status,200);return r.json()}
let ready=false
 const startupDeadline=Date.now()+12_000
 for(let i=0;i<120 && Date.now()<startupDeadline;i++){
   if(childError)throw childError
   if(child.exitCode!==null || child.signalCode!==null)throw Error('Local artifact exited before readiness')
   try{ready=(await request(`${base}/api/health`,{},Math.min(2_000,Math.max(1,startupDeadline-Date.now())))).ok}catch{}
   if(ready)break
   await sleep(100)
 }
 if(childError)throw childError
 assert.ok(ready,'local artifact did not start')
 const tools=await rpc('tools/list',{})
 assert.ok(tools.body.result.tools.some(t=>t.name==='get_platform_query_evidence'))
 // Expected identities, order and counts come from the inserted literals, never a reader.
 const fiveCounts={success:1,failed:1,partial:1,no_record:1,not_queried:1}
 const fiveIds=[ids[4],ids[3],ids[2],ids[1],ids[0]]
 const fiveStates=['not_queried','no_record','partial','failed','success']
 const scenarios=[
   {name:'key-page-one',params:{queryKey:'synthetic:public',pageSize:2},ids:[ids[4],ids[3]],states:['not_queried','no_record'],total:5,counts:fiveCounts,page:1,pageSize:2},
   {name:'combined-page-two',params:{uscc:'synthetic:relation',titleCode:'specialized_sme',enterpriseId,pageSize:1,page:2},ids:[ids[3]],states:['no_record'],total:5,counts:fiveCounts,page:2,pageSize:1},
   {name:'partial-status',params:{status:'partial'},ids:[ids[2]],states:['partial'],total:1,counts:{partial:1}},
   {name:'failed-status',params:{status:'failed'},ids:[otherId,ids[1]],states:['failed','failed'],total:2,counts:{failed:2}},
   {name:'success-status',params:{status:'success'},ids:[largeId,ids[0]],states:['success','success'],total:2,counts:{success:2}},
   {name:'no-record-status',params:{status:'no_record'},ids:[ids[3]],states:['no_record'],total:1,counts:{no_record:1}},
   {name:'not-queried-status',params:{status:'not_queried'},ids:[ids[4]],states:['not_queried'],total:1,counts:{not_queried:1}},
   {name:'exact-query-raw',params:{queryId:ids[0],includeRawResponse:true},ids:[ids[0]],states:['success'],total:1,counts:{success:1}},
   {name:'enterprise-filter',params:{enterpriseId},ids:fiveIds,states:fiveStates,total:5,counts:fiveCounts},
   {name:'uscc-filter',params:{uscc:'synthetic:relation'},ids:fiveIds,states:fiveStates,total:5,counts:fiveCounts},
   {name:'title-filter',params:{titleCode:'specialized_sme'},ids:fiveIds,states:fiveStates,total:5,counts:fiveCounts},
   {name:'interface-filter',params:{interface:'recognized_list'},ids:fiveIds,states:fiveStates,total:5,counts:fiveCounts},
   {name:'counterexample',params:{enterpriseId:otherEnterpriseId,uscc:'synthetic:other-uscc',titleCode:'little_giant',interface:'business_list'},ids:[otherId],states:['failed'],total:1,counts:{failed:1}},
   {name:'summary-all',params:{view:'summary'},ids:[otherId,largeId,...fiveIds],states:['failed','success',...fiveStates],total:7,counts:{success:2,failed:2,partial:1,no_record:1,not_queried:1}},
   {name:'summary-key',params:{queryKey:'synthetic:public',view:'summary'},ids:fiveIds,states:fiveStates,total:5,counts:fiveCounts},
   {name:'empty-key',params:{queryKey:'none'},ids:[],states:[],total:0,counts:{}},
   {name:'empty-intersection',params:{enterpriseId,titleCode:'little_giant'},ids:[],states:[],total:0,counts:{}},
   {name:'past-last-page',params:{queryKey:'synthetic:public',page:4,pageSize:2},ids:[],states:[],total:5,counts:fiveCounts,page:4,pageSize:2},
 ]
 function assertList(result,scenario,protocol) {
   const label=`${scenario.name} ${protocol}`
   assert.deepEqual(result.rows.map(r=>r.query.id),scenario.ids,`${label} IDs`)
   assert.deepEqual(result.rows.map(r=>r.query.status),scenario.states,`${label} states`)
   assert.equal(result.total,scenario.total,`${label} total`)
   assert.deepEqual(result.counts,scenario.counts,`${label} counts`)
   assert.equal(result.page,scenario.page??1,`${label} page`)
   assert.equal(result.pageSize,scenario.pageSize??25,`${label} pageSize`)
   for(const row of result.rows) {
     const isOther=row.query.id===otherId, isLarge=row.query.id===largeId
     assert.equal(row.query.relationCount,isOther?1:isLarge?0:2,`${label} complete relationCount`)
     assert.equal(row.query.queriedAt,isOther?'2026-10-20':'2026-10-19',`${label} queriedAt`)
     if(scenario.params.view==='summary') {
       assert.equal(row.relationsIncluded,false,`${label} summary marker`)
       assert.deepEqual(row.relations,[],`${label} summary relations`)
       assert.equal(Object.hasOwn(row.query,'rawResponse'),false,`${label} omit rawResponse`)
       assert.equal(Object.hasOwn(row.query,'collectionEvidence'),false,`${label} omit collectionEvidence`)
     } else if(!isLarge && !isOther) {
       const index=ids.indexOf(row.query.id)
       assert.deepEqual(row.relations.map(r=>[r.id,r.queryId,r.sequenceNo,r.enterpriseId,r.relationKey,r.rawFields,r.sourceRdjb,r.sourcePage]),[
         [relationIds[index][1],ids[index],1,enterpriseId,'same',{id:'same',original:'原行1'},'1',1],
         [relationIds[index][2],ids[index],2,null,'same',{id:'same',original:'原行2'},'1',1],
       ],`${label} duplicate relations and source pages`)
       assert.deepEqual(row.query.collectionEvidence,evidence,`${label} collectionEvidence`)
       if(scenario.params.includeRawResponse) assert.equal(row.query.rawResponse,raw,`${label} rawResponse`)
     }
   }
 }
 for(const scenario of scenarios) {
   const http=await get(scenario.params), mcp=await call('list_platform_queries',scenario.params)
   assertList(http,scenario,'HTTP');assertList(mcp,scenario,'MCP')
   assert.deepEqual(mcp,http,`${scenario.name} parity`)
 }
 const evidenceScenarios=[
   {name:'raw-bytes',queryId:ids[0],field:'rawResponse',bytes:Buffer.from(raw)},
   {name:'collection-bytes',queryId:ids[0],field:'collectionEvidence',bytes:Buffer.from(JSON.stringify(evidence))},
   {name:'relation-discovery',queryId:ids[0],field:'relations',expected:{queryId:ids[0],field:'relations',total:2,page:1,pageSize:100,rows:[{id:relationIds[0][1],sequenceNo:1},{id:relationIds[0][2],sequenceNo:2}]}},
   {name:'relation-page-two',queryId:ids[0],field:'relations',page:2,pageSize:1,expected:{queryId:ids[0],field:'relations',total:2,page:2,pageSize:1,rows:[{id:relationIds[0][2],sequenceNo:2}]}},
   {name:'relation-owned',queryId:ids[0],field:'relation',relationId:relationIds[0][1],relation:{id:relationIds[0][1],queryId:ids[0],sequenceNo:1,enterpriseId,relationKey:'same',usccRaw:'synthetic:relation',rawFields:{id:'same',original:'原行1'}}},
   {name:'relation-unmatched',queryId:ids[0],field:'relation',relationId:relationIds[0][2],relation:{id:relationIds[0][2],queryId:ids[0],sequenceNo:2,enterpriseId:null,relationKey:'same',usccRaw:'synthetic:relation',rawFields:{id:'same',original:'原行2'}}},
   {name:'relation-other-owner',queryId:otherId,field:'relation',relationId:otherRelationId,relation:{id:otherRelationId,queryId:otherId,sequenceNo:1,enterpriseId:otherEnterpriseId,relationKey:'other',usccRaw:'synthetic:other-uscc',rawFields:{id:'other',original:'反例行'}}},
 ]
 function assertEvidence(result,scenario,protocol) {
   const label=`${scenario.name} ${protocol}`
   if(scenario.expected) {assert.deepEqual(result,scenario.expected,label);return}
   assert.equal(result.queryId,scenario.queryId,`${label} queryId`)
   assert.equal(result.field,scenario.field,`${label} field`)
   assert.equal(result.encoding,'base64',`${label} encoding`)
   assert.equal(result.offset,0,`${label} offset`)
   assert.equal(result.isNull,false,`${label} isNull`)
   assert.equal(result.hasMore,false,`${label} complete`)
   const bytes=Buffer.from(result.data,'base64')
   assert.equal(result.byteLength,bytes.length,`${label} byteLength`)
   assert.equal(result.totalBytes,bytes.length,`${label} totalBytes`)
   if(scenario.bytes) assert.deepEqual(bytes,scenario.bytes,`${label} literal bytes`)
   if(scenario.relation) {
     assert.equal(result.relationId,scenario.relationId,`${label} relationId`)
     const relation=JSON.parse(bytes.toString('utf8'))
     for(const [key,value] of Object.entries(scenario.relation)) assert.deepEqual(relation[key],value,`${label} ${key}`)
   }
 }
 for(const scenario of evidenceScenarios) {
   const {name,expected,bytes,relation,queryId,...params}=scenario
   const response=await request(`${base}/api/platform/queries/${queryId}/evidence?${new URLSearchParams(params)}`)
   assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store')
   const http=await response.json(), mcp=await call('get_platform_query_evidence',{queryId,...params})
   assertEvidence(http,scenario,'HTTP');assertEvidence(mcp,scenario,'MCP')
   assert.deepEqual(mcp,http,`${name} parity`)
 }
 const parts=[];let offset=0
 const expectedBytes=Buffer.from(raw,'utf8')
 // At least one byte must advance each iteration; the literal bounds requests
 // independently of the remote hasMore/totalBytes claims.
 for(let step=0;step<expectedBytes.length && offset<expectedBytes.length;step++) {
   const chunk=await call('get_platform_query_evidence',{queryId:ids[0],field:'rawResponse',offset,length:7})
   assert.equal(chunk.queryId,ids[0],'chunk queryId')
   assert.equal(chunk.field,'rawResponse','chunk field')
   assert.equal(chunk.encoding,'base64','chunk encoding')
   assert.equal(chunk.isNull,false,'chunk isNull')
   assert.equal(chunk.offset,offset,'chunk offset')
   assert.equal(chunk.totalBytes,expectedBytes.length,'chunk totalBytes')
   const bytes=Buffer.from(chunk.data,'base64')
   assert.ok(Number.isInteger(chunk.byteLength) && chunk.byteLength>0 && chunk.byteLength<=7,'chunk positive bounded byteLength')
   assert.equal(chunk.byteLength,bytes.length,'chunk decoded byteLength')
   const next=offset+bytes.length
   assert.ok(next<=expectedBytes.length,'chunk literal byte budget')
   assert.deepEqual(bytes,expectedBytes.subarray(offset,next),'chunk literal bytes')
   assert.equal(chunk.hasMore,next<expectedBytes.length,'chunk terminal hasMore')
   parts.push(bytes);offset=next
 }
 assert.equal(offset,expectedBytes.length,'chunk complete literal byte count')
 assert.equal(Buffer.concat(parts).toString('utf8'),raw)
 assert.equal((await request(`${base}/api/platform/queries?queryId=${largeId}&includeRawResponse=true`)).status,413)
 assert.equal((await request(`${base}/api/platform/queries?queryId=${largeId}&view=summary`)).status,200)
 for(const params of [{queryId:0},{view:'garbage'}]) {const r=await rpc('tools/call',{name:'list_platform_queries',arguments:params});assert.ok(r.body.error||r.body.result?.isError)}
 const bad=await rpc('tools/call',{name:'get_platform_query_evidence',arguments:{queryId:ids[0],field:'rawResponse',length:65537}});assert.equal(bad.status,400)
 const denied=await rpc('tools/call',{name:'save_roster_batch',arguments:{}});assert.equal(denied.status,401)
 receipt={passed:true,lane:'local production artifact HTTP + real MCP tools/list/tools/call',checks:['literal filter/paging IDs, counts and five states independently HTTP and MCP before parity','complete default raw/relations/source pages','explicit summary','byte exact Unicode chunks','relation discovery and exact reads','413 budget','400 validation','401 write auth'],productionChanged:false}
} catch(error) {primaryError=error}
finally {
 // Attempt every cleanup independently, retaining both primary and cleanup errors.
 if(db)try{if(db.$client.open)db.$client.close()}catch(error){dbClosed=false;cleanupErrors.push(new Error('Database cleanup failed',{cause:error}))}
 let childStopped=!attempted
 let stopState='not-acquired'
 if(child) {
   try{await stopOwnedChild(child);childStopped=true;stopState='resolved'}
   catch(error){
     cleanupErrors.push(new Error('Child cleanup failed',{cause:error}))
     const result=error?.stopResult
     // Only this helper's versioned terminal receipt can authorize root deletion.
     const known=result?.brand==='isolated-local-services.stop' && result.version===1
     childStopped=known && result.termination==='confirmed'
     stopState=known?`${result.termination}/${result.reason} (group=${result.groupId}, members=${JSON.stringify(result.finalMembers)}, observedAt=${result.observedAt})`:'unknown stop receipt'
   }
 }
 // Never remove a live service's private files after failed termination.
 if(!childStopped) {
   cleanupErrors.push(new Error(`Owned service termination unconfirmed (pid=${child?.pid??'unknown'}, state=${stopState}); private root retained at ${dir}`))
   for(const action of [
     ...[...new Set(child?.stdio??[])].filter(Boolean).map(stream=>()=>stream.destroy?.()),
     ()=>{if(child?.connected)child.disconnect()},()=>child?.unref(),
   ])try{action()}catch(error){cleanupErrors.push(new Error('Local handle release failed',{cause:error}))}
 }
 if(dir && childStopped && dbClosed)try{rmSync(dir,{recursive:true,force:true})}catch(error){cleanupErrors.push(new Error(`Private root cleanup failed; retained at ${dir}`,{cause:error}))}
}
if(primaryError || cleanupErrors.length)throw new AggregateError([
 ...(primaryError?[primaryError]:[]),...cleanupErrors,
],'Local verifier failed (primary and cleanup diagnostics retained)')
console.log(JSON.stringify(receipt))
