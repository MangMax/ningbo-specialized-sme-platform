#!/usr/bin/env node
// Runs only a local production artifact with a synthetic temporary database; no live platform traffic.
import assert from 'node:assert/strict'

import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { setTimeout as sleep } from 'node:timers/promises'
import { spawnOwnedChild as spawn, reserveLoopbackPort, stopOwnedChild } from './lib/isolated-local-services.mjs'
const { createJiti } = createRequire(import.meta.resolve('nuxt/package.json'))('jiti')
const jiti = createJiti(import.meta.url)
const { useDb, schema } = await jiti.import('../db/client.ts')
const dir=mkdtempSync(join(tmpdir(),'verify-platform-read-')), dbPath=join(dir,'test.sqlite')
const db=useDb({dbPath})
const raw='完整原文🙂'.repeat(40)
const evidence={titleScope:{rdjb:['1','2']},pages:[{rdjb:'1',page:1,status:'success',fetchedCount:2,rawResponse:raw}],rows:[{id:'same',original:'原行一'},{id:'same',original:'原行二'}]}
const enterpriseId=db.insert(schema.enterprise).values({name:'合成企业',nameNorm:'合成企业'}).returning().get().id
const ids=[]
for (const [index,status] of ['success','failed','partial','no_record','not_queried'].entries()) {
 const id=db.insert(schema.platformQuery).values({interface:'recognized_list',queryKey:'synthetic:public',rdjb:String(index),queriedAt:'2026-10-19',status,rawResponse:raw,collectionEvidence:evidence}).returning().get().id
 ids.push(id)
 for(const sequenceNo of [2,1]) db.insert(schema.platformRelation).values({queryId:id,sequenceNo,enterpriseId:sequenceNo===1?enterpriseId:null,usccRaw:'synthetic:relation',relationKey:'same',rawFields:{id:'same',original:`原行${sequenceNo}`}}).run()
}
const largeId=db.insert(schema.platformQuery).values({interface:'apply_list',queryKey:'synthetic:large',queriedAt:'2026-10-19',status:'success',rawResponse:'原'.repeat(1_500_000)}).returning().get().id
db.$client.close()
const port=await reserveLoopbackPort()
const base=`http://127.0.0.1:${port}`
const child=spawn(process.execPath,['--max-old-space-size=2048','.output/server/index.mjs'],{env:{...process.env,PORT:String(port),HOST:'127.0.0.1',NUXT_DB_PATH:dbPath,NUXT_FILES_DIR:dir,NUXT_API_TOKEN:'synthetic-only',NUXT_MCP_TOKEN:'synthetic-only',MIIT_COOKIE:'',MIIT_COOKIE_FILE:''},stdio:['ignore','pipe','pipe']})
let output='';child.stdout.on('data',b=>{output=(output+b).slice(-2000)});child.stderr.on('data',b=>{output=(output+b).slice(-2000)})
let rpcId=0
async function rpc(method,params) {
 const r=await fetch(`${base}/mcp`,{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:++rpcId,method,params})})
 const raw=await r.text(), line=raw.split('\n').find(s=>s.startsWith('data: '))?.slice(6)??raw
 return {status:r.status,body:JSON.parse(line),headers:r.headers}
}
async function call(name,args) { const r=await rpc('tools/call',{name,arguments:args});assert.equal(r.status,200);assert.ok(!r.body.error,JSON.stringify(r.body.error));assert.ok(!r.body.result.isError,JSON.stringify(r.body.result));return JSON.parse(r.body.result.content[0].text) }
async function get(params) {const r=await fetch(`${base}/api/platform/queries?${new URLSearchParams(params)}`);assert.equal(r.status,200);return r.json()}
try {
 let ready=false
 for(let i=0;i<120;i++){if(child.exitCode!==null)throw Error(output);try{ready=(await fetch(`${base}/api/health`)).ok}catch{} if(ready)break;await sleep(100)}
 assert.ok(ready,'local artifact did not start')
 const tools=await rpc('tools/list',{})
 assert.ok(tools.body.result.tools.some(t=>t.name==='get_platform_query_evidence'))
 for(const params of [{queryKey:'synthetic:public',pageSize:'2'},{uscc:'synthetic:relation',titleCode:'specialized_sme',enterpriseId:String(enterpriseId),pageSize:'1',page:'2'},{status:'partial'},{queryId:String(ids[0]),includeRawResponse:'true'},{queryKey:'synthetic:public',view:'summary'},{queryKey:'none'}]) {
   const http=await get(params),args=Object.fromEntries(Object.entries(params).map(([k,v])=>[k,['queryId','enterpriseId','pageSize','page'].includes(k)?Number(v):k==='includeRawResponse'?v==='true':v]))
   assert.deepEqual(await call('list_platform_queries',args),http)
 }
 const full=await get({queryId:String(ids[0]),includeRawResponse:'true'})
 assert.deepEqual(full.rows[0].relations.map(r=>r.sequenceNo),[1,2]);assert.deepEqual(full.rows[0].query.collectionEvidence,evidence);assert.equal(full.rows[0].query.rawResponse,raw)
 assert.deepEqual(full.rows[0].relations.map(r=>[r.sourceRdjb,r.sourcePage]),[['1',1],['1',1]])
 assert.equal((await get({queryKey:'synthetic:public'})).total,5)
 for(const field of ['rawResponse','collectionEvidence','relations','relation']) {
   const params={field,...(field==='relation'?{relationId:String(full.rows[0].relations[0].id)}:{})}
   const response=await fetch(`${base}/api/platform/queries/${ids[0]}/evidence?${new URLSearchParams(params)}`)
   assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store')
   const http=await response.json(),args={queryId:ids[0],field,...(field==='relation'?{relationId:full.rows[0].relations[0].id}:{})}
   assert.deepEqual(await call('get_platform_query_evidence',args),http)
 }
 const parts=[];let offset=0
 for(;;){const chunk=await call('get_platform_query_evidence',{queryId:ids[0],field:'rawResponse',offset,length:7});parts.push(Buffer.from(chunk.data,'base64'));offset+=chunk.byteLength;if(!chunk.hasMore)break}
 assert.equal(Buffer.concat(parts).toString('utf8'),raw)
 assert.equal((await fetch(`${base}/api/platform/queries?queryId=${largeId}&includeRawResponse=true`)).status,413)
 assert.equal((await fetch(`${base}/api/platform/queries?queryId=${largeId}&view=summary`)).status,200)
 for(const params of [{queryId:0},{view:'garbage'}]) {const r=await rpc('tools/call',{name:'list_platform_queries',arguments:params});assert.ok(r.body.error||r.body.result?.isError)}
 const bad=await rpc('tools/call',{name:'get_platform_query_evidence',arguments:{queryId:ids[0],field:'rawResponse',length:65537}});assert.equal(bad.status,400)
 const denied=await rpc('tools/call',{name:'save_roster_batch',arguments:{}});assert.equal(denied.status,401)
 console.log(JSON.stringify({passed:true,lane:'local production artifact HTTP + real MCP tools/list/tools/call',checks:['all filters/paging and five statuses HTTP=MCP','complete default raw/relations/source pages','explicit summary','byte exact Unicode chunks','relation discovery and exact reads','413 budget','400 validation','401 write auth'],productionChanged:false}))
} finally {await stopOwnedChild(child);rmSync(dir,{recursive:true,force:true})}
