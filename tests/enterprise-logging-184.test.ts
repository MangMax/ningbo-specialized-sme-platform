import { afterAll, beforeAll, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as pause } from 'node:timers/promises'
import { useDb } from '../db/client'
import { applicationLogs, closeApplicationLogging, initializeWorkerLogging } from '../lib/logging'
import { createEnterpriseReadExecutor } from '../server/utils/enterprise-read'
import { createEnterpriseReadProcess } from '../server/utils/enterprise-read-process'
const root=mkdtempSync(join(tmpdir(),'enterprise184-'))
const path=join(root,'fixture.db'), db=useDb({dbPath:path})
const previous=process.env.NUXT_LOG_DIR
beforeAll(()=>{process.env.NUXT_LOG_DIR=join(root,'logs');initializeWorkerLogging()})
afterAll(async()=>{await closeApplicationLogging();db.$client.close();if(previous===undefined) delete process.env.NUXT_LOG_DIR;else process.env.NUXT_LOG_DIR=previous;rmSync(root,{recursive:true,force:true})})
async function logs(requestId:string){await applicationLogs().flush();return (await applicationLogs().list({requestId,limit:100})).rows}
it('real enterprise child persists execution context and preserves success and read failure results', async()=>{
 const reads=createEnterpriseReadExecutor()
 try {
  expect(await reads.list(path,{q:'PRIVATE184_SEARCH'},undefined,{requestId:'read184',traceId:'trace184'})).toMatchObject({counts:{total:0},rows:[]})
  let rows=await logs('read184')
  for(let i=0;i<50 && rows.filter(r=>r.operation==='enterprise_read.execute').length<2;i++){await pause(100);rows=await logs('read184')}
  expect(rows.filter(r=>r.operation==='enterprise_read.execute').map(r=>r.outcome).sort()).toEqual(['started','success'])
  expect(rows.filter(r=>r.operation==='enterprise_read.finished')).toMatchObject([{outcome:'success',traceId:'trace184'}])
  await expect(reads.list(join(root,'PRIVATE184_MISSING'),{},undefined,{requestId:'failed184'})).rejects.toMatchObject({statusCode:503})
  expect((await logs('failed184')).filter(r=>r.operation==='enterprise_read.finished')).toMatchObject([{outcome:'failure'}])
  const details=await Promise.all(rows.map(r=>applicationLogs().detail(r.id)))
  expect(JSON.stringify(details)).not.toMatch(/PRIVATE184|fixture.db|dbPath|filter|heap|params/)
 } finally {await reads.close()}
},15000)
function scripted(source:string){return createEnterpriseReadExecutor({createWorker:()=>createEnterpriseReadProcess(new URL('file:///unused184'),source)})}
it('real child exit and malformed IPC are unknown once and never claim a successful read',async()=>{
 for(const [id,source] of [
  ['exit184',"process.send({type:'ready'});process.on('message',()=>process.exit(7))"],
  ['ipc184',"process.send({type:'ready'});process.on('message',m=>process.send({id:m.id,type:'invalid'}))"],
 ] as const){
  const reads=scripted(source)
  try{await expect(reads.list(path,{},undefined,{requestId:id})).rejects.toMatchObject({statusCode:503})}
  finally{await reads.close()}
  const rows=await logs(id)
  expect(rows.filter(r=>r.operation==='enterprise_read.finished')).toMatchObject([{outcome:'unknown'}])
  expect(rows.filter(r=>r.operation==='enterprise_read.finished')).toHaveLength(1)
  expect(rows.filter(r=>r.operation==='enterprise_read.process.exit')).toHaveLength(1)
 }
})
it('startup rejection and real child startup exit remain distinct from a read success',async()=>{
 const failed=createEnterpriseReadExecutor({createWorker:()=>{throw new Error('PRIVATE184_START')}})
 try{await expect(failed.list(path,{},undefined,{requestId:'spawn184'})).rejects.toMatchObject({code:'worker_start_failed'})}finally{await failed.close()}
 expect((await logs('spawn184')).filter(r=>r.operation==='enterprise_read.process.start').map(r=>r.outcome)).toEqual(['failure','started'])
 const exited=scripted('process.exit(3)')
 try{await expect(exited.list(path,{},undefined,{requestId:'earlyexit184'})).rejects.toMatchObject({code:'worker_exited'})}finally{await exited.close()}
 expect((await logs('earlyexit184')).find(r=>r.operation==='enterprise_read.finished')?.outcome).toBe('unknown')
})
it('real child cancellation settles once and queued reads retain FIFO after process recovery',async()=>{
 let generation=0
 const reads=createEnterpriseReadExecutor({createWorker:()=>createEnterpriseReadProcess(new URL('file:///unused184'),++generation===1
  ? "process.send({type:'ready'});process.on('message',()=>{})"
  : "process.send({type:'ready'});process.on('message',m=>{process.send({type:'chunk',id:m.id,payload:Buffer.from('{\"ok\":true}')});process.send({type:'result',id:m.id,metrics:{heap:1,rss:1}})})")})
 const controller=new AbortController()
 try{
  const a=reads.list(path,{},controller.signal,{requestId:'abort184'})
  // Wait until native child dispatch, rather than testing only queued abort.
  for(let i=0;i<50;i++){if((await logs('abort184')).some(r=>r.operation==='enterprise_read.started'))break;await pause(20)}
  const b=reads.list(path,{},undefined,{requestId:'afterabort184'})
  controller.abort()
  await expect(a).rejects.toMatchObject({name:'AbortError'})
  expect(await b).toEqual({ok:true})
 }finally{await reads.close()}
 expect((await logs('abort184')).filter(r=>r.operation==='enterprise_read.finished')).toMatchObject([{outcome:'cancelled'}])
 expect((await logs('afterabort184')).filter(r=>r.operation==='enterprise_read.finished')).toMatchObject([{outcome:'success'}])
})
it('real child readiness timeout produces one timeout terminal and retires its process',async()=>{
 const reads=scripted('setInterval(()=>{},1000)')
 try{await expect(reads.list(path,{},undefined,{requestId:'timeout184'})).rejects.toMatchObject({code:'worker_start_timeout'})}finally{await reads.close()}
 const rows=await logs('timeout184')
 expect(rows.filter(r=>r.operation==='enterprise_read.finished')).toMatchObject([{outcome:'timeout'}])
 expect(rows.filter(r=>r.operation==='enterprise_read.finished')).toHaveLength(1)
 expect(rows.filter(r=>r.operation==='enterprise_read.process.start').map(r=>r.outcome)).toEqual(['timeout','started'])
},10000)
it('late real child completion after cooperative cancellation never duplicates caller terminal',async()=>{
 const {getDbOwnerIdentity}=await import('../db/client')
 const reads=scripted(`process.send({type:'ready'});process.on('message',m=>{
  if(m.operation==='summary')setTimeout(()=>process.send({type:'result',id:m.id,metrics:{heap:1,rss:1,bytes:0}}),100);
  else {process.send({type:'chunk',id:m.id,payload:Buffer.from('{"ok":true}')});process.send({type:'result',id:m.id,metrics:{heap:1,rss:1}})}
 })`)
 const controller=new AbortController()
 try{
  const pending=reads.summary({operation:'summary',dbPath:path,owner:getDbOwnerIdentity(db)!,options:{curatedPath:join(root,'curated.json'),reconcilePath:join(root,'reconcile.json'),showCurated:false,page:1,pageSize:25}},controller.signal,{requestId:'late184'})
  for(let i=0;i<50;i++){if((await logs('late184')).some(r=>r.operation==='enterprise_read.started'))break;await pause(10)}
  controller.abort()
  expect(await pending).toEqual({type:'cancelled'})
  expect(await reads.list(path,{},undefined,{requestId:'afterlate184'})).toEqual({ok:true})
 }finally{await reads.close()}
 expect((await logs('late184')).filter(r=>r.operation==='enterprise_read.finished')).toMatchObject([{outcome:'cancelled'}])
 expect((await logs('late184')).filter(r=>r.operation==='enterprise_read.finished')).toHaveLength(1)
})
