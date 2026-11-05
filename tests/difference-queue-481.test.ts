import { expect, it } from 'vitest'
import { deriveSnapshotQueue, pageSnapshotQueue } from '../server/utils/difference-queue'
const official = [
  { enterpriseId: 1, name: 'A', uscc: '91330200123456789X', titleCode: 'innovative_sme' },
  { enterpriseId: 2, name: 'alias', uscc: '91330200123456789X', titleCode: 'specialized_sme' },
]
function items(rows: Record<string,string>[] = [], complete = true) {
  return [1,2].flatMap(enterpriseId => ['queryList','businessList','queryBusList'].flatMap(source => (source === 'queryList' ? [null] : ['1','2','3']).map(rdjb => ({enterpriseId,source,rdjb,complete,segments:[{rows: source === 'queryList' ? rows : []}]}))))
}
it('uses literal official-only/platform-only/both coordinates and merges same USCC IDs', () => {
  const queue = deriveSnapshotQueue(official, items([{rdjb:'2',tyshxydm:official[0]!.uscc},{rdjb:'3',tyshxydm:official[0]!.uscc}]))
  expect(queue.rows).toEqual([
    {enterpriseId:1,titleCode:'innovative_sme',direction:'missing_in_miit',status:'not_queried',reasonCode:null},
    {enterpriseId:1,titleCode:'little_giant',direction:'extra_in_miit',status:'not_queried',reasonCode:null},
  ])
})
it('retains unfinished coverage without inventing absence or no_record', () => {
  const queue = deriveSnapshotQueue(official, items([],false))
  expect(queue.rows).toEqual([])
  expect(queue.unfinished).toEqual([1])
})
it.each(['constructor','toString','__proto__'])('keeps unsupported returned title %s unfinished rather than proving absence', rdjb => {
  expect(deriveSnapshotQueue(official, items([{rdjb,tyshxydm:official[0]!.uscc}]))).toEqual({rows:[],unfinished:[1]})
})
it('deduplicates rows and excludes both terminal states before stable count and pagination', () => {
  const rows = [{rdjb:'3',tyshxydm:official[0]!.uscc}]
  const queue = deriveSnapshotQueue(official, items([...rows,...rows]))
  expect(queue.rows).toHaveLength(3)
  expect(pageSnapshotQueue(queue,1,1).rows).toEqual([queue.rows[0]])
  expect(pageSnapshotQueue(queue,2,1).rows).toEqual([queue.rows[1]])
  queue.rows[0]!.status='confirmed_no_diff'
  queue.rows[1]!.status='confirmed_reason'
  expect(pageSnapshotQueue(queue,1,50)).toMatchObject({total:1,rows:[queue.rows[2]]})
})

import { vi, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { createApp, toNodeListener, defineEventHandler, getQuery, getRouterParam, setHeader, readBody, setResponseStatus } from 'h3'
import { initializeDb } from '../db/client'
import { createJob, finishJob } from '../server/utils/job-store'
import { newJobId } from '../lib/job'
const dir=mkdtempSync(join(tmpdir(),'queue481-'))
const db=initializeDb({create:true,dbPath:join(dir,'fixture.db')})
vi.mock('../db',()=>({useDb:()=>db}))
vi.mock('@nuxtjs/mcp-toolkit/server',()=>({defineMcpTool:(x:unknown)=>x}))
afterAll(()=>{db.$client.close();rmSync(dir,{recursive:true,force:true});vi.unstubAllGlobals()})
it('HTTP and MCP read the same persisted queue with authentication, paging, terminal exclusion and explicit unfinished',async()=>{
  const queue=deriveSnapshotQueue(official,items())
  queue.rows[0]!.status='confirmed_reason'
  queue.unfinished=[9]
  const id=newJobId()
  createJob(db,{id,kind:'difference-snapshot',params:{},progress:{done:7,total:7}})
  finishJob(db,id,{state:'done',result:{queue}})
  vi.stubGlobal('defineEventHandler',defineEventHandler)
  vi.stubGlobal('getQuery',getQuery)
  let selectedId=id
  vi.stubGlobal('getRouterParam',()=>selectedId)
  vi.stubGlobal('setHeader',setHeader)
  vi.stubGlobal('useRuntimeConfig',()=>({apiToken:'fixture'}))
  const handler=(await import('../server/api/roster/difference-snapshots/[id]/queue.get')).default
  const server=createServer(toNodeListener(createApp().use('/queue',handler)))
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r))
  try {
    const url=`http://127.0.0.1:${(server.address() as {port:number}).port}/queue?page=1&pageSize=1`
    expect((await fetch(url)).status).toBe(401)
    const response=await fetch(url,{headers:{authorization:'Bearer fixture'}})
    expect(response.status).toBe(200)
    const http=await response.json()
    const tool=(await import('../server/mcp/tools/list_snapshot_difference_queue')).default as unknown as {handler:(x:unknown)=>Promise<{content:{text:string}[]}>}
    const mcp=JSON.parse((await tool.handler({jobId:id,page:1,pageSize:1})).content[0]!.text)
    expect(http).toEqual(mcp)
    expect(http).toMatchObject({jobId:id,total:1,unfinished:[9],rows:[{enterpriseId:1,titleCode:'specialized_sme',direction:'missing_in_miit',status:'not_queried'}]})
    const scenarios=[
      {rows:[],complete:true,expected:[['innovative_sme','missing_in_miit'],['specialized_sme','missing_in_miit']],unfinished:[]},
      {rows:[{rdjb:'1',tyshxydm:official[0]!.uscc},{rdjb:'2',tyshxydm:official[0]!.uscc}],complete:true,expected:[],unfinished:[]},
      {rows:[{rdjb:'2',tyshxydm:official[0]!.uscc},{rdjb:'3',tyshxydm:official[0]!.uscc},{rdjb:'3',tyshxydm:official[0]!.uscc}],complete:true,expected:[['innovative_sme','missing_in_miit'],['little_giant','extra_in_miit']],unfinished:[]},
      {rows:[],complete:false,expected:[],unfinished:[1]},
    ]
    for(const scenario of scenarios) {
      selectedId=newJobId()
      createJob(db,{id:selectedId,kind:'difference-snapshot',params:{},progress:{done:0,total:7}})
      finishJob(db,selectedId,{state:'done',result:{queue:deriveSnapshotQueue(official,items(scenario.rows,scenario.complete))}})
      const response=await fetch(url.replace('pageSize=1','pageSize=50'),{headers:{authorization:'Bearer fixture'}})
      expect(response.status).toBe(200)
      const actual=await response.json()
      expect(actual.rows.map((r:{titleCode:string;direction:string})=>[r.titleCode,r.direction])).toEqual(scenario.expected)
      expect(actual.total).toBe(scenario.expected.length)
      expect(actual.unfinished).toEqual(scenario.unfinished)
      expect(JSON.parse((await tool.handler({jobId:selectedId,page:1,pageSize:50})).content[0]!.text)).toEqual(actual)
    }
  } finally {await new Promise<void>(r=>server.close(()=>r()))}
})

import { setImmediate } from 'node:timers/promises'
import { getJob, setJobResult } from '../server/utils/job-store'
import * as s from '../db/schema'
import { getComparison } from '../lib/comparison'

vi.mock('../server/utils/platform-live-query',async importOriginal=>{
  const actual=await importOriginal<typeof import('../server/utils/platform-live-query')>()
  return {runPlatformLiveQuery:(input:unknown,ctx:Parameters<typeof actual.runPlatformLiveQuery>[1])=>actual.runPlatformLiveQuery(input,{...ctx,cookie:'fixture',transport:{fetchImpl:async(url,init)=>{
    const source=String(url).includes('queryBusList')?'queryBusList':String(url).includes('businessList')?'businessList':'queryList'
    const params=new URLSearchParams(String(init?.body))
    const rows=source==='queryBusList'&&params.get('rdjb')==='2'?[{id:'historical',rdjb:'2',qymc:'frozen',tyshxydm:'91330200123456789X'}]:[]
    const grid=source==='queryBusList'?'businessGrid':source==='businessList'?'businessListGrid':'applyGrid'
    return {ok:true,status:200,text:async()=>JSON.stringify({zrarData:{grid:{[grid]:{page:1,pageSize:50,maxPage:1,maxCount:rows.length,pageSet:rows}}}})}
  }}})}
})
it('fresh collection persists literal candidates and approved export-shadow deltas from the same isolated input',async()=>{
  for(const [code,rank] of [['innovative_sme',1],['specialized_sme',2],['little_giant',3]] as const) db.insert(s.title).values({code,nameZh:code,rank,level:'municipal'}).onConflictDoNothing().run()
  const enterprise=db.insert(s.enterprise).values({name:'frozen',nameNorm:'frozen',usccNorm:'91330200123456789X'}).returning().get()
  for(const source of ['jxj','miit'] as const) db.insert(s.record).values({enterpriseId:enterprise.id,titleCode:'innovative_sme',source}).run()
  // Independent legacy reader: the export says both sides have innovative_sme.
  expect(getComparison(db).rows).toEqual([])
  vi.stubGlobal('readBody',readBody)
  vi.stubGlobal('setResponseStatus',setResponseStatus)
  vi.stubGlobal('useRuntimeConfig',()=>({apiToken:'fixture',filesDir:dir}))
  const createHandler=(await import('../server/api/roster/difference-snapshots/index.post')).default
  const server=createServer(toNodeListener(createApp().use('/snapshot',createHandler)))
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r))
  let task:{id:string}
  try {
    const response=await fetch(`http://127.0.0.1:${(server.address() as {port:number}).port}/snapshot`,{method:'POST',headers:{authorization:'Bearer fixture','content-type':'application/json'},body:JSON.stringify({action:'create',clientRequestId:'fresh-shadow'})})
    expect(response.status).toBe(202)
    task=await response.json()
  } finally {await new Promise<void>(r=>server.close(()=>r()))}
  // Later official rows cannot alter the selected task's frozen input.
  db.insert(s.record).values({enterpriseId:enterprise.id,titleCode:'specialized_sme',source:'jxj'}).run()
  let completed=getJob(db,task.id)!
  for(let i=0;i<200&&['queued','running'].includes(completed.state);i++){await setImmediate();completed=getJob(db,task.id)!}
  expect(completed.state).toBe('done')
  const result=completed.result as {queue:{rows:unknown[];unfinished:number[]}}
  // Approved per-row deltas: export innovation -> absent now; historical specialized -> present now.
  expect(result.queue).toEqual({unfinished:[],rows:[
    {enterpriseId:enterprise.id,titleCode:'innovative_sme',direction:'missing_in_miit',status:'not_queried',reasonCode:null},
    {enterpriseId:enterprise.id,titleCode:'specialized_sme',direction:'extra_in_miit',status:'not_queried',reasonCode:null},
  ]})
  const legacy=structuredClone(completed.result) as Record<string,unknown>
  delete legacy.official;delete legacy.queue
  db.$client.prepare('update job set result=? where id=?').run(JSON.stringify(legacy),task.id)
  expect(getJob(db,task.id)!.result).not.toHaveProperty('official')
  expect(getJob(db,task.id)!.result).not.toHaveProperty('queue')
  const retryTool=(await import('../server/mcp/tools/difference_snapshot')).default as unknown as {handler:(x:unknown)=>Promise<unknown>}
  await retryTool.handler({action:'retry',jobId:task.id})
  let resumed=getJob(db,task.id)!
  for(let i=0;i<200&&['queued','running'].includes(resumed.state);i++){await setImmediate();resumed=getJob(db,task.id)!}
  expect(resumed.state).toBe('done')
  expect((resumed.result as {queue:unknown}).queue).toEqual(result.queue)
  expect((resumed.result as {items:unknown}).items).toEqual(legacy.items)
})
