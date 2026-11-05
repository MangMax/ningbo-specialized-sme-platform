import { it, expect, afterAll } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import Database from 'better-sqlite3'
import { initializeDb } from '../db/client'
import { snapshotOperation } from '../server/utils/difference-snapshot'
const dir = mkdtempSync(join(tmpdir(), 'snapshot480-'))
const db = initializeDb({ create: true, dbPath: join(dir, 'own.db') })
afterAll(() => { db.$client.close(); rmSync(dir, { recursive: true, force: true }) })
it('backs up before task writes and keeps missing archives unfinished on idempotent retry', async () => {
  const result = await snapshotOperation(db, dir, { action: 'create', clientRequestId: 'fixture' })
  const backup = result.params.backup as { path: string; sha256: string }
  expect(createHash('sha256').update(readFileSync(backup.path)).digest('hex')).toBe(backup.sha256)
  const copy = new Database(backup.path, { readonly: true })
  expect(copy.prepare('select count(*) n from job where id=?').get(result.id)).toEqual({ n: 0 })
  copy.close()
  expect((await snapshotOperation(db, dir, { action: 'create', clientRequestId: 'fixture' })).id).toBe(result.id)
})

import { setImmediate } from 'node:timers/promises'
import { getJob, createJob, finishJob } from '../server/utils/job-store'
import { newJobId } from '../lib/job'
import * as s from '../db/schema'
import type { PlatformLiveQueryResult } from '../lib/platform/live-query'
async function settled(id: string, store = db) {
  for (let i=0;i<100;i++) { const row=getJob(store,id)!; if (!['queued','running'].includes(row.state)) return row; await setImmediate() }
  throw new Error('job did not settle')
}
function archive(source: PlatformLiveQueryResult['source'], broken = false): PlatformLiveQueryResult {
  const titles = source === 'queryList' ? [null] : ['1','2','3']
  return { source, status: broken ? 'partial' : 'no_record', effectiveConditions: { uscc: '91330200123456789X', combination: 'and' }, titleScope: { mode: 'selected', rdjb: titles.filter((x): x is string => x !== null) }, queriedAt: '2026-01-01T00:00:00Z', completedAt: '2026-01-01T00:00:01Z', rows: [], pages: titles.flatMap(rdjb => (broken ? [1,2] : [1]).map(page => ({ source, rdjb, page, maxPage: broken ? 2 : 1, status: broken && page === 2 ? 'failed' as const : 'success' as const, fetchedCount: broken && page === 1 ? 50 : 0, declaredTotal: broken ? 51 : 0, error: null }))), fetchedCount: 0, declaredTotal: 0, completeness: broken ? 'partial' : 'complete', fullRange: true, unfinished: broken ? [{ source, rdjb: titles[0]!, page: 2 }] : [], error: null, limits: { maxRequests: 100, maxRows: 5000, maxDurationMs: 60000, pageSize: 50 } }
}
it('fresh tasks query all interfaces despite historical empty completion and reuse only identical clientRequestId', async () => {
  db.insert(s.title).values({code:'innovative_sme',nameZh:'创新型',level:'municipal',rank:1}).onConflictDoNothing().run()
  const e=db.insert(s.enterprise).values({ name:'fixture',nameNorm:'fixture',usccNorm:'91330200123456789X' }).returning().get()
  db.insert(s.record).values({enterpriseId:e.id,titleCode:'innovative_sme',source:'jxj'}).run()
  for (const source of ['queryList','businessList','queryBusList'] as const)
    db.insert(s.platformQuery).values({interface:source==='queryList'?'apply_list':source==='businessList'?'business_list':'recognized_list',queryKey:e.usccNorm!,queriedAt:'2026-01-01',status:'no_record',collectionEvidence:archive(source)}).run()
  const batchId=newJobId()
  createJob(db,{id:batchId,kind:'platform-query-batch',params:{},progress:{done:1,total:1}})
  finishJob(db,batchId,{state:'done',result:{items:[{itemId:'old-empty',segments:['queryList','businessList','queryBusList'].map(source=>archive(source as PlatformLiveQueryResult['source']))}]}})
  const calls:string[]=[]
  vi.mocked(runPlatformLiveQuery).mockImplementation(async raw=>{
    const q=raw as {source:PlatformLiveQueryResult['source'];rdjb?:string|string[]}
    calls.push(q.source)
    const r=archive(q.source)
    const title=q.source==='queryList'?null:Array.isArray(q.rdjb)?q.rdjb[0]!:q.rdjb!
    r.pages=r.pages.filter(p=>p.rdjb===title).map(p=>({...p,fetchedCount:1,declaredTotal:1}))
    r.status='success'
    return r
  })
  for (const clientRequestId of ['fresh-one','fresh-two']) {
    const row=await publicHttp({action:'create',clientRequestId})
    const done=await settled(row.id)
    expect(done.state).toBe('done')
    expect(done.result).toMatchObject({counts:{rows:7,requests:7,unfinished:0}})
    const before=calls.length
    expect((await publicHttp({action:'create',clientRequestId})).id).toBe(row.id)
    expect(calls).toHaveLength(before)
  }
  expect(calls).toEqual(['queryList','businessList','businessList','businessList','queryBusList','queryBusList','queryBusList', 'queryList','businessList','businessList','businessList','queryBusList','queryBusList','queryBusList'])
  vi.mocked(runPlatformLiveQuery).mockImplementation(async input=>({...archive((input as {source:PlatformLiveQueryResult['source']}).source,true),pages:[],effectiveConditions:{combination:'and'},unfinished:[],completeness:'partial'}))
})
it('keeps unmatched published enterprise coverage unknown rather than zero', async () => {
  const row=await snapshotOperation(db,dir,{action:'create',clientRequestId:'unmatched'})
  const done=await settled(row.id)
  expect(done.state).toBe('failed')
  expect(done.result).toMatchObject({counts:{enterprises:1,unfinished:7}})
  const result=done.result as {items:{enterpriseId:number;rows:number|null;reason:string|null}[]}
  expect(result.items.filter(i=>i.reason==='missing_uscc'||i.reason==='provider_failed_or_partial_pagination')).toHaveLength(7)
  expect(result.items.filter(i=>i.reason==='missing_uscc'||i.reason==='provider_failed_or_partial_pagination').every(i=>i.rows===null)).toBe(true)
})

import { vi } from 'vitest'
import { createServer } from 'node:http'
import { createApp, toNodeListener, defineEventHandler, readBody, setResponseStatus } from 'h3'
const globalDb=db
let activeDb = db
vi.mock('../db', () => ({ useDb: () => activeDb }))
vi.mock('@nuxtjs/mcp-toolkit/server', () => ({ defineMcpTool: (tool: unknown) => tool }))
it('creates and reads the same snapshot through authenticated HTTP and MCP public handlers', async () => {
  vi.stubGlobal('useRuntimeConfig', () => ({ filesDir: dir, apiToken: 'fixture-token' }))
  vi.stubGlobal('defineEventHandler', defineEventHandler)
  vi.stubGlobal('readBody', readBody)
  vi.stubGlobal('setResponseStatus', setResponseStatus)
  const handler = (await import('../server/api/roster/difference-snapshots/index.post')).default
  const server=createServer(toNodeListener(createApp().use('/api/roster/difference-snapshots',handler)))
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r))
  try {
    const url=`http://127.0.0.1:${(server.address() as {port:number}).port}/api/roster/difference-snapshots`
    expect((await fetch(url,{method:'POST',body:'{}'})).status).toBe(401)
    const res=await fetch(url,{method:'POST',headers:{authorization:'Bearer fixture-token','content-type':'application/json'},body:JSON.stringify({action:'create',clientRequestId:'public'})})
    expect(res.status).toBe(202)
    const row=await res.json()
    await settled(row.id)
    const tool=(await import('../server/mcp/tools/difference_snapshot')).default as unknown as {handler:(input:unknown)=>Promise<{content:{text:string}[]}>}
    const mcp=JSON.parse((await tool.handler({action:'read',jobId:row.id})).content[0]!.text)
    expect(mcp.id).toBe(row.id)
    expect(mcp.result).toMatchObject({counts:{enterprises:1,unfinished:7},collectionPolicy:'per_enterprise_fresh_same_job_resume'})
  } finally { await new Promise<void>(r=>server.close(()=>r())); vi.unstubAllGlobals() }
})

import { appendFileSync } from 'node:fs'
it('rejects retry after backup checksum changes without changing the checkpoint', async () => {
  const row=await snapshotOperation(db,dir,{action:'create',clientRequestId:'checksum'})
  const prior=await settled(row.id)
  appendFileSync((row.params.backup as {path:string}).path, 'tamper')
  await expect(snapshotOperation(db,dir,{action:'retry',jobId:row.id})).rejects.toThrow('Backup checksum mismatch')
  expect(getJob(db,row.id)!.result).toEqual(prior.result)
})
it('does not let historical unproven pagination complete a fresh task', async () => {
  const e=db.insert(s.enterprise).values({name:'unproven',nameNorm:'unproven',usccNorm:'91330200987654321X'}).returning().get()
  db.insert(s.record).values({enterpriseId:e.id,titleCode:'innovative_sme',source:'jxj'}).run()
  const result=archive('queryList')
  result.effectiveConditions.uscc='91330200987654321X'
  for (const p of result.pages) { delete p.maxPage; p.declaredTotal=null; p.fetchedCount=50 }
  db.insert(s.platformQuery).values({interface:'apply_list',queryKey:'91330200987654321X',queriedAt:'2026-02-01',status:'success',collectionEvidence:result}).run()
  const row=await snapshotOperation(db,dir,{action:'create',clientRequestId:'unproven'})
  const completed=await settled(row.id)
  const item=(completed.result as {items:{enterpriseId:number;source:string;rows:number|null;complete:boolean;reason:string}[]}).items.find(i=>i.enterpriseId===e.id&&i.source==='queryList')
  expect(item).toMatchObject({complete:false,rows:null,reason:'provider_failed_or_partial_pagination'})
})
vi.mock('../server/utils/platform-live-query', () => ({ runPlatformLiveQuery: vi.fn(async (input: {source: PlatformLiveQueryResult['source']}) => ({...archive((input as {source:PlatformLiveQueryResult['source']}).source,true),pages:[],effectiveConditions:{combination:'and'},unfinished:[],completeness:'partial'})) }))

import { runPlatformLiveQuery } from '../server/utils/platform-live-query'
it('collects missing per-enterprise title pages and resumes only failed positions through HTTP retry and MCP read', async () => {
  const db=initializeDb({create:true,dbPath:join(dir,'collection.db')})
  activeDb=db
  db.insert(s.title).values({code:'innovative_sme',nameZh:'创新型',level:'municipal',rank:1}).onConflictDoNothing().run()
  const e=db.insert(s.enterprise).values({name:'collect',nameNorm:'collect',usccNorm:'91330200111111111X'}).returning().get()
  db.insert(s.record).values({enterpriseId:e.id,titleCode:'innovative_sme',source:'jxj'}).run()
  let failedOnce=false
  const calls:{source:string;startPage:number;rdjb:unknown}[]=[]
  vi.mocked(runPlatformLiveQuery).mockImplementation(async raw => {
    const q=raw as {source:PlatformLiveQueryResult['source'];uscc?:string;rdjb?:string|string[];startPage:number}
    if(q.uscc!=='91330200111111111X') return {...archive(q.source,true),pages:[],completeness:'partial'}
    calls.push({source:q.source,startPage:q.startPage,rdjb:q.rdjb})
    const title=q.source==='queryList'?null:Array.isArray(q.rdjb)?q.rdjb[0]!:q.rdjb!
    const broken=q.source==='businessList'&&title==='2'&&!failedOnce
    if(broken)failedOnce=true
    const r=archive(q.source,broken)
    r.effectiveConditions.uscc=q.uscc
    r.titleScope.rdjb=title?[title]:[]
    r.limits.pageSize=1
    r.fullRange=q.startPage===1
    r.pages=[1,2].filter(p=>p>=q.startPage).map(page=>({source:q.source,rdjb:title,page,maxPage:2,status:broken&&page===2?'failed':'success',fetchedCount:broken&&page===2?0:1,declaredTotal:2,error:null}))
    r.unfinished=broken?[{source:q.source,rdjb:title,page:2}]:[]
    return r
  })
  const row=await publicHttp({action:'create',clientRequestId:'collect'})
  const first=await settled(row.id,db)
  const target=(first.result as {items:{enterpriseId:number;complete:boolean;rows:number|null}[]}).items.filter(i=>i.enterpriseId===e.id)
  expect(target.filter(i=>i.complete)).toHaveLength(6)
  expect(target.filter(i=>!i.complete)[0]!.rows).toBeNull()
  expect(calls).toHaveLength(7)
  const later=db.insert(s.enterprise).values({name:'later',nameNorm:'later'}).returning().get()
  db.insert(s.record).values({enterpriseId:later.id,titleCode:'innovative_sme',source:'jxj'}).run()
  db.insert(s.platformQuery).values({interface:'business_list',queryKey:e.usccNorm!,queriedAt:'2099-01-01',status:'no_record',collectionEvidence:archive('businessList')}).run()
  await publicHttp({action:'retry',jobId:row.id})
  const done=await settled(row.id,db)
  expect(calls).toHaveLength(8)
  expect(calls.at(-1)).toEqual({source:'businessList',rdjb:'2',startPage:2})
  expect((done.result as {items:{enterpriseId:number;complete:boolean;rows:number}[]}).items.filter(i=>i.enterpriseId===e.id).every(i=>i.complete&&i.rows===2)).toBe(true)
  await publicHttp({action:'retry',jobId:row.id})
  await settled(row.id,db)
  expect(calls).toHaveLength(8)
  expect(done.state).toBe('done')
  const tool=(await import('../server/mcp/tools/difference_snapshot')).default as unknown as {handler:(v:unknown)=>Promise<{content:{text:string}[]}>}
  const read=JSON.parse((await tool.handler({action:'read',jobId:row.id})).content[0]!.text)
  expect(read.result.counts).toMatchObject({enterprises:1,unfinished:0,rows:14})
  db.$client.close(); activeDb=globalDb
})

async function publicHttp(body: unknown) {
  vi.stubGlobal('useRuntimeConfig',()=>({filesDir:dir,apiToken:'fixture-token'}))
  vi.stubGlobal('defineEventHandler',defineEventHandler)
  vi.stubGlobal('readBody',readBody)
  vi.stubGlobal('setResponseStatus',setResponseStatus)
  const handler=(await import('../server/api/roster/difference-snapshots/index.post')).default
  const server=createServer(toNodeListener(createApp().use('/snapshot',handler)))
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r))
  try {
    const res=await fetch(`http://127.0.0.1:${(server.address() as {port:number}).port}/snapshot`,{method:'POST',headers:{authorization:'Bearer fixture-token','content-type':'application/json'},body:JSON.stringify(body)})
    expect(res.status).toBe(202)
    return await res.json()
  } finally { await new Promise<void>(r=>server.close(()=>r())) }
}
it('runs real provider pagination against fixture transport and exposes raw rows through the public snapshot', async () => {
  const db=initializeDb({create:true,dbPath:join(dir,'provider.db')}); activeDb=db
  const e=db.insert(s.enterprise).values({name:'fixture provider',nameNorm:'fixtureprovider',usccNorm:'91330200222222222X'}).returning().get()
  db.insert(s.record).values({enterpriseId:e.id,titleCode:'innovative_sme',source:'jxj'}).run()
  const actual=await vi.importActual<typeof import('../server/utils/platform-live-query')>('../server/utils/platform-live-query')
  const calls:{source:string;page:number}[]=[]
  vi.mocked(runPlatformLiveQuery).mockImplementation((input,ctx)=>actual.runPlatformLiveQuery(input,{...ctx,cookie:'fixture-cookie',transport:{fetchImpl:async (url,init)=>{
    const source=String(url).includes('queryBusList')?'queryBusList':String(url).includes('businessList')?'businessList':'queryList'
    const body=new URLSearchParams(String(init?.body)),page=Number(body.get('pageNum'))
    calls.push({source,page})
    const grid=source==='queryBusList'?'businessGrid':source==='businessList'?'businessListGrid':'applyGrid'
    return {ok:true,status:200,text:async()=>JSON.stringify({zrarData:{grid:{[grid]:{page,pageSize:50,maxCount:51,maxPage:2,pageSet:Array.from({length:page===1?50:1},(_,i)=>({id:`${source}-${page}-${i}`,qymc:'fixture provider',tyshxydm:'91330200222222222X'}))}}}})}
  }}}))
  try {
    const row=await publicHttp({action:'create',clientRequestId:'real-provider-fixture'})
    const done=await settled(row.id,db)
    expect(done.state).toBe('done')
    expect(calls).toHaveLength(14)
    expect(calls.filter(c=>c.page===2)).toHaveLength(7)
    expect(done.result).toMatchObject({counts:{enterprises:1,unfinished:0,rows:357,requests:14}})
    const result=done.result as {items:{segments:PlatformLiveQueryResult[]}[]}
    expect(result.items.every(i=>i.segments[0]!.rawData!.rows.length===51)).toBe(true)
  } finally {db.$client.close();activeDb=globalDb}
})

it.each(['short-tail','retained-total'] as const)('real provider public snapshot handles %s across retry without erasing attempts', async mode => {
  const db=initializeDb({create:true,dbPath:join(dir,mode+'.db')}); activeDb=db
  const e=db.insert(s.enterprise).values({name:'fixture provider',nameNorm:'fixtureprovider',usccNorm:'91330200222222222X'}).returning().get()
  db.insert(s.record).values({enterpriseId:e.id,titleCode:'innovative_sme',source:'jxj'}).run()
  const actual=await vi.importActual<typeof import('../server/utils/platform-live-query')>('../server/utils/platform-live-query')
  const calls:number[]=[]
  let retry=false
  vi.mocked(runPlatformLiveQuery).mockImplementation((input,ctx)=>actual.runPlatformLiveQuery(input,{...ctx,cookie:'fixture-cookie',transport:{fetchImpl:async (url,init)=>{
    const source=String(url).includes('queryBusList')?'queryBusList':String(url).includes('businessList')?'businessList':'queryList'
    const page=Number(new URLSearchParams(String(init?.body)).get('pageNum'))
    if(source==='queryList')calls.push(page)
    if(source==='queryList'&&mode==='retained-total'&&page===3&&!retry) return {ok:false,status:503,text:async()=>''}
    const grid=source==='queryBusList'?'businessGrid':source==='businessList'?'businessListGrid':'applyGrid'
    const count=source!=='queryList'?0:page===1?50:page===2?(mode==='short-tail'?10:50):0
    return {ok:true,status:200,text:async()=>JSON.stringify({zrarData:{grid:{[grid]:{page,pageSize:50,...(source!=='queryList'?{maxCount:0,maxPage:1}:mode==='retained-total'?{maxPage:3,...(page===1?{maxCount:101}:{})}:{}),pageSet:Array.from({length:count},(_,i)=>({id:page+'-'+i,qymc:'fixture provider'}))}}}})}
  }}}))
  try {
    const row=await publicHttp({action:'create',clientRequestId:mode})
    const first=await settled(row.id,db)
    expect(first.state).toBe(mode==='short-tail'?'done':'failed')
    retry=true
    await publicHttp({action:'retry',jobId:row.id})
    const done=await settled(row.id,db)
    const tool=(await import('../server/mcp/tools/difference_snapshot')).default as unknown as {handler:(v:unknown)=>Promise<{content:{text:string}[]}>}
    const read=JSON.parse((await tool.handler({action:'read',jobId:row.id})).content[0]!.text)
    expect(read.result).toEqual(done.result)
    const item=read.result.items.find((i:{source:string})=>i.source==='queryList')
    if(mode==='short-tail') {
      expect(calls).toEqual([1,2,3])
      expect(item).toMatchObject({complete:true,rows:60})
      expect(item.segments[0].pages.map((p:{declaredTotal:number|null})=>p.declaredTotal)).toEqual([null,null,null])
    } else {
      expect(calls).toEqual([1,2,3,3])
      expect(done.state).toBe('failed')
      expect(item).toMatchObject({complete:false,rows:null})
      expect(item.segments[0].pages.map((p:{status:string})=>p.status)).toEqual(['success','success','failed'])
      expect(item.segments[0].pages[0].declaredTotal).toBe(101)
      expect(item.segments[0].pages[1].declaredTotal).toBeNull()
      expect(item.segments[1].unfinished).toContainEqual({source:'queryList',rdjb:null,page:3})
    }
  } finally {db.$client.close();activeDb=globalDb}
})
