import { it, expect, vi, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { createApp, toNodeListener, defineEventHandler, readBody } from 'h3'
import { initializeDb } from '../db/client'
import { createJob, finishJob } from '../server/utils/job-store'
import { newJobId } from '../lib/job'
const dir=mkdtempSync(join(tmpdir(),'judgment482-'))
const db=initializeDb({create:true,dbPath:join(dir,'test.db')})
vi.mock('../db',()=>({useDb:()=>db}))
vi.mock('@nuxtjs/mcp-toolkit/server',()=>({defineMcpTool:(x:unknown)=>x}))
afterAll(()=>{db.$client.close();rmSync(dir,{recursive:true,force:true});vi.unstubAllGlobals()})
const coordinate={enterpriseId:1,titleCode:'innovative_sme',direction:'missing_in_miit'}
function task() { const id=newJobId();createJob(db,{id,kind:'difference-snapshot',params:{},progress:{done:1,total:1}});finishJob(db,id,{state:'done',result:{scope:[{enterpriseId:1,recordIds:[]}],items:[],queue:{rows:[{...coordinate,status:'not_queried',reasonCode:null}],unfinished:[]}}});return id }
const pending={status:'not_queried',reasonCode:null,measureCode:null,notes:'',searchedScope:'',gaps:'',evidence:[]}
it('HTTP writes terminal no difference and MCP reads identical current values and operation log',async()=>{
 vi.stubGlobal('defineEventHandler',defineEventHandler);vi.stubGlobal('readBody',readBody);vi.stubGlobal('useRuntimeConfig',()=>({apiToken:'fixture'}))
 const handler=(await import('../server/api/roster/difference-judgments.post')).default
 const tool=(await import('../server/mcp/tools/snapshot_difference_judgment')).default as unknown as {handler:(x:unknown)=>Promise<{content:{text:string}[]}>}
 const server=createServer(toNodeListener(createApp().use('/judgment',handler)));await new Promise<void>(r=>server.listen(0,'127.0.0.1',r))
 try {
 const jobId=task(), current={...pending,status:'confirmed_no_diff',notes:'历史一致'}
 const payload={action:'write',jobId,...coordinate,expected:pending,current,actor:'fixture agent'}
 const url=`http://127.0.0.1:${(server.address() as {port:number}).port}/judgment`
 expect((await fetch(url,{method:'POST',body:JSON.stringify(payload)})).status).toBe(401)
 const response=await fetch(url,{method:'POST',headers:{authorization:'Bearer fixture','content-type':'application/json'},body:JSON.stringify(payload)})
 expect(response.status).toBe(200)
 const result=await response.json()
 expect(result.current).toEqual(current);expect(result.operations).toHaveLength(1)
 expect(result.operations[0]).toMatchObject({actor:'fixture agent',before:pending,after:current})
 expect(JSON.parse((await tool.handler({input:{action:'read',jobId,...coordinate}})).content[0]!.text)).toEqual(result)
 } finally {await new Promise<void>(r=>server.close(()=>r()))}
})

import { readSnapshotQueue } from '../server/utils/difference-queue'
import { snapshotOperation } from '../server/utils/difference-snapshot'
import { getJob } from '../server/utils/job-store'
import { setImmediate } from 'node:timers/promises'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import * as s from '../db/schema'
it('public HTTP/MCP covers seven reasons, overwrite, unresolved, atomic CAS, noop, retry and independent new task',async()=>{
 const handler=(await import('../server/api/roster/difference-judgments.post')).default
 const tool=(await import('../server/mcp/tools/snapshot_difference_judgment')).default as unknown as {handler:(x:unknown)=>Promise<{content:{text:string}[]}>}
 const server=createServer(toNodeListener(createApp().use('/judgment',handler)));await new Promise<void>(r=>server.listen(0,'127.0.0.1',r))
 const jobId=task()
 const post=async(input:unknown)=>fetch(`http://127.0.0.1:${(server.address() as {port:number}).port}/judgment`,{method:'POST',headers:{authorization:'Bearer fixture','content-type':'application/json'},body:JSON.stringify(input)})
 const read={action:'read',jobId,...coordinate}
 let current: Record<string,unknown>=structuredClone(pending),count=0
 try {
 for(const reasonCode of ['moved_out','deregistered','renamed','platform_stale','pending_review','moved_in','other']) {
 const next={...pending,status:'confirmed_reason',reasonCode,measureCode:'manual_review',notes:`independent synthetic evidence: ${reasonCode}`,evidence:[{kind:'external',url:'https://example.org/source',note:'synthetic source'}]}
 const input={action:'write',jobId,...coordinate,expected:current,current:next,actor:'agent via human instruction'}
 const response=await post(input);expect(response.status).toBe(200);const actual=await response.json()
 expect(actual.current).toEqual(next);expect(actual.operations).toHaveLength(++count)
 expect(actual.operations.at(-1)).toMatchObject({before:current,after:next});expect(actual.operations.at(-1).recordedAt).toMatch(/^\d{4}-/)
 expect(actual).not.toHaveProperty('previous_id');expect(actual).not.toHaveProperty('lifecycle_action')
 expect(readSnapshotQueue(db,{jobId})).toMatchObject({total:0,rows:[]})
 expect(JSON.parse((await tool.handler({input:read})).content[0]!.text)).toEqual(actual)
 current=next
 }
 const noop=await post({action:'write',jobId,...coordinate,expected:current,current,actor:'agent'})
 expect((await noop.json()).operations).toHaveLength(count)
 const unresolved={...pending,status:'needs_review',notes:'human fallback',searchedScope:'all three interfaces and published source',gaps:'migration endpoint unknown'}
 const competing=await Promise.all(['one','two'].map(notes=>post({action:'write',jobId,...coordinate,expected:current,current:{...unresolved,notes},actor:'agent'})))
 expect(competing.map(r=>r.status).sort()).toEqual([200,409])
 const after=JSON.parse((await tool.handler({input:read})).content[0]!.text)
 expect(after.operations).toHaveLength(count+1);expect(after.current.status).toBe('needs_review')
 expect(readSnapshotQueue(db,{jobId})).toMatchObject({total:1})
 for(const bad of [{...unresolved,gaps:''},{...unresolved,evidence:[{kind:'platform',itemId:'foreign',segment:0,row:0}]},{...unresolved,evidence:[{kind:'official',evidenceId:999}]},{...unresolved,evidence:[{kind:'external',url:'file:///secret',note:'bad'}]}]) {
 expect((await post({action:'write',jobId,...coordinate,expected:after.current,current:bad,actor:'agent'})).status).toBe(400)
 }
 expect((await post({action:'write',jobId,...coordinate,expected:after.current,current:unresolved,actor:' '})).status).toBe(400)
 // Terminal write through MCP, not only HTTP.
 const terminal={...pending,status:'confirmed_no_diff',notes:'consistent historical rows'}
 const terminalRead=JSON.parse((await tool.handler({input:{action:'write',jobId,...coordinate,expected:after.current,current:terminal,actor:'agent'}})).content[0]!.text)
 expect((await (await post(read)).json())).toEqual(terminalRead)
 // Real same-job retry of a fully collected synthetic snapshot regenerates the candidate.
 const receipt=getJob(db,jobId)!.result as Record<string,unknown>
 receipt.official=[{enterpriseId:1,name:'synthetic',uscc:null,titleCode:'innovative_sme'}]
 receipt.items=['queryList','businessList','queryBusList'].flatMap(source=>(source==='queryList'?[null]:['1','2','3']).map(rdjb=>({enterpriseId:1,source,rdjb,complete:true,rows:0,archives:[],segments:[]})))
 receipt.attempt=0;receipt.counts={enterprises:1,requests:0,rows:0,unfinished:0}
 const path=join(dir,'retry-backup.db');await db.$client.backup(path)
 db.$client.prepare('update job set result=?,params=? where id=?').run(JSON.stringify(receipt),JSON.stringify({backup:{path,sha256:createHash('sha256').update(readFileSync(path)).digest('hex')}}),jobId)
 await snapshotOperation(db,dir,{action:'retry',jobId})
 let resumed=getJob(db,jobId)!
 for(let i=0;i<200&&['queued','running'].includes(resumed.state);i++){await setImmediate();resumed=getJob(db,jobId)!}
 expect(resumed.state).toBe('done')
 expect(readSnapshotQueue(db,{jobId})).toMatchObject({total:0})
 const stable=await (await post(read)).json();expect(stable.current).toEqual(terminal);expect(stable.operations).toEqual(terminalRead.operations)
 const independent=task();expect(readSnapshotQueue(db,{jobId:independent})).toMatchObject({total:1})
 expect((await (await post({...read,jobId:independent})).json()).current).toEqual(pending)
 } finally {await new Promise<void>(r=>server.close(()=>r()))}
})

it('agent detail returns all task platform rows and frozen official events and page sources',async()=>{
 const enterprise=db.insert(s.enterprise).values({name:'official synthetic',nameNorm:'official synthetic',usccNorm:'91330200123456789X'}).returning().get()
 const record=db.insert(s.record).values({enterpriseId:enterprise.id,titleCode:'innovative_sme',source:'jxj'}).returning().get()
 const event=db.insert(s.recordEvent).values({recordId:record.id,eventType:'award',year:2024}).returning().get()
 const source=db.insert(s.recordEvidence).values({recordEventId:event.id,sourceFile:'synthetic.pdf',attachment:'list',listNo:7,page:3}).returning().get()
 const jobId=task(),path=join(dir,'official-backup.db');await db.$client.backup(path)
 const rows=[{qymc:'old name',rdjb:'1',szsmc:'上海市'},{qymc:'new name',rdjb:'1',szsmc:'宁波市'}]
 const platformHistory=[{enterpriseId:enterprise.id,itemId:'history',source:'queryBusList',segments:[{rows}],complete:true}]
 const result={scope:[{enterpriseId:enterprise.id,recordIds:[record.id]}],items:platformHistory,queue:{rows:[{...coordinate,enterpriseId:enterprise.id,status:'not_queried',reasonCode:null}],unfinished:[]}}
 db.$client.prepare('update job set params=?,result=? where id=?').run(JSON.stringify({backup:{path,sha256:createHash('sha256').update(readFileSync(path)).digest('hex')}}),JSON.stringify(result),jobId)
 // Later source edits must not silently change task evidence.
 db.$client.prepare('update record_evidence set page=99 where id=?').run(source.id)
 const tool=(await import('../server/mcp/tools/snapshot_difference_judgment')).default as unknown as {handler:(x:unknown)=>Promise<{content:{text:string}[]}>}
 const input={action:'read',jobId,...coordinate,enterpriseId:enterprise.id}
 const detail=JSON.parse((await tool.handler({input})).content[0]!.text)
 expect(detail.platformHistory).toEqual(platformHistory)
 expect(detail.officialSources).toEqual([expect.objectContaining({event_id:event.id,year:2024,source_file:'synthetic.pdf',evidence_id:source.id,attachment:'list',list_no:7,page:3})])
 expect(detail.skillReference).toBe('.agents/skills/roster-ingestion-pipeline/references/difference-investigation.md')
 const current={...pending,status:'confirmed_reason',reasonCode:'moved_in',measureCode:'record_moved_in',notes:'migration synthetic evidence',evidence:[{kind:'official',evidenceId:source.id},{kind:'platform',itemId:'history',segment:0,row:1}]}
 const written=JSON.parse((await tool.handler({input:{...input,action:'write',expected:pending,current,actor:'agent'}})).content[0]!.text)
 expect(written.current).toEqual(current)
})
