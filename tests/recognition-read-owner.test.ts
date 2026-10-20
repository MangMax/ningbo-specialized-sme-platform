import { getEventListeners, once } from 'node:events'
import { Worker } from 'node:worker_threads'
import { createRequire } from 'node:module'
import { channel } from 'node:diagnostics_channel'
import { mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { afterEach, expect, it, vi } from 'vitest'
import { useDb, getDbOwnerIdentity, schema } from '../db/client'
import { readRecognitions } from '../server/utils/recognition-read'
import { createReadTurns } from '../server/utils/read-turn'
import { createEnterpriseReadExecutor } from '../server/utils/enterprise-read'
import { createEnterpriseWorker } from '../server/utils/enterprise-read-worker-location'
import { captureReaderError } from '../lib/roster/offmain-read-protocol'
import { startRosterApi } from './helpers/roster-http-server'
import { createRosterImportClient } from '../lib/roster-import-client'

const cleanup: Array<() => unknown|Promise<unknown>>=[]
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close()})
async function fixture(filename='fixture.db') {
  const dir=mkdtempSync(join(tmpdir(),'recognition-m1-owner-')),path=join(dir,filename)
  cleanup.push(()=>rmSync(dir,{recursive:true,force:true}))
  const writer=useDb({dbPath:path})
  cleanup.push(()=>{if(writer.$client.open)writer.$client.close()})
  const api=await startRosterApi({db:writer,apiToken:'synthetic-m1'});cleanup.push(()=>api.close())
  const client=createRosterImportClient({baseUrl:api.baseUrl,token:'synthetic-m1'})
  const payload={announcement:{sourceDocument:{source:'jxj' as const,title:'合成 M1'},records:[{enterprise:{name:'合成M1企业'},titleCode:'specialized_sme',events:[{eventType:'award' as const,year:2021,evidence:[{sourceFile:'synthetic/m1.pdf',page:3}]}]}]}}
  expect((await client.commit({idempotencyKey:'seed',sourceIdentity:'synthetic/m1',sourceKind:'announcement',payload})).status).toBe('committed')
  const owner=useDb({dbPath:path,readOnly:true});cleanup.push(()=>{if(owner.$client.open)owner.$client.close()})
  return {dir,path,owner,writer,client,payload}
}
const decoded=(out:unknown)=>Buffer.isBuffer(out)?JSON.parse(out.toString()):out
it('managed existing disk owner is eligible, real memory and untracked handles are ineligible, and a filename containing :memory: is disk',async()=>{
  const f=await fixture('literal:memory:.db')
  expect(getDbOwnerIdentity(f.owner)).toMatchObject({dbPath:f.path,realpath:realpathSync(f.path)})
  f.writer.$client.pragma('journal_mode=DELETE')
  const client=new Database(f.writer.$client.serialize()),memory=drizzle(client,{schema});cleanup.push(()=>client.close())
  expect(client.memory).toBe(true)
  expect(getDbOwnerIdentity(memory)).toBeUndefined()
  const never={recognitions:vi.fn()}
  expect(decoded(await readRecognitions(memory as typeof f.owner,{},undefined,never))).toMatchObject({counts:{titlePairs:1},rows:[{name:'合成M1企业'}]})
  expect(never.recognitions).not.toHaveBeenCalled()
  expect(getDbOwnerIdentity({$client:f.owner.$client})).toBeUndefined()
  expect(getDbOwnerIdentity(Object.defineProperty({},'$client',{get(){throw new Error('untracked mock getter')}}))).toBeUndefined()
  // A newly created file did not have matching pre/post-open identity evidence.
  expect(getDbOwnerIdentity(f.writer)).toBeUndefined()
  const reads=createEnterpriseReadExecutor();cleanup.push(()=>reads.close())
  expect(decoded(await readRecognitions(f.owner,{},undefined,reads))).toMatchObject({counts:{titlePairs:1},rows:[{name:'合成M1企业'}]})
})
it('owner transaction and untracked fallback execute the original owner once, including FIFO 16-job and 64KiB inline overflow',async()=>{
  const f=await fixture(),never={recognitions:vi.fn()}
  f.owner.$client.exec('BEGIN')
  try {expect(decoded(await readRecognitions(f.owner,{},undefined,never))).toMatchObject({counts:{titlePairs:1}})}finally{f.owner.$client.exec('ROLLBACK')}
  expect(never.recognitions).not.toHaveBeenCalled()
  const prepare=vi.spyOn(f.writer.$client,'prepare')
  const turns=createReadTurns((n:{n:number})=>n.n)
  const held=Array.from({length:16},(_,n)=>turns.submit({n}))
  const out=readRecognitions(f.writer,{pageSize:1},undefined,never)
  // Saturation executes before the promise is awaited, as the old FIFO does.
  expect(prepare).toHaveBeenCalled();expect(decoded(await out)).toMatchObject({pageSize:1,counts:{titlePairs:1}})
  for(const job of held)job.cancel()
  prepare.mockClear()
  expect(decoded(await readRecognitions(f.writer,{title:['x'.repeat(65536)]},undefined,never))).toMatchObject({rows:[],counts:{titlePairs:0}})
  expect(prepare).toHaveBeenCalled();prepare.mockRestore()
})
it('post-ready infrastructure fallback invokes the exact original reader once and preserves its own error without another attempt',async()=>{
  const f=await fixture(),infra={recognitions:vi.fn(async()=>({type:'fallback' as const}))}
  const prepare=vi.spyOn(f.owner.$client,'prepare')
  expect(decoded(await readRecognitions(f.owner,{pageSize:1},undefined,infra))).toMatchObject({rows:[{name:'合成M1企业'}],pageSize:1})
  expect(infra.recognitions).toHaveBeenCalledTimes(1)
  const onceCalls=prepare.mock.calls.length;expect(onceCalls).toBeGreaterThan(0)
  prepare.mockClear()
  await readRecognitions(f.owner,{pageSize:1},undefined,infra)
  expect(prepare.mock.calls).toHaveLength(onceCalls)
  const original=new SyntaxError('synthetic original failure')
  prepare.mockClear()
  prepare.mockImplementation(()=>{throw original})
  await expect(readRecognitions(f.owner,{},undefined,infra)).rejects.toBe(original)
  expect(infra.recognitions).toHaveBeenCalledTimes(3)
  expect(prepare).toHaveBeenCalledTimes(1);prepare.mockRestore()
})
it('terminal reader failure and cancellation never replay on the owner, including abort immediately before fallback',async()=>{
  const f=await fixture(),prepare=vi.spyOn(f.owner.$client,'prepare'),controller=new AbortController()
  const terminal={recognitions:vi.fn(async()=>({type:'reader-error' as const,error:captureReaderError(Object.assign(new Error('locked'),{code:'SQLITE_BUSY'}))}))}
  await expect(readRecognitions(f.owner,{},undefined,terminal)).rejects.toMatchObject({message:'locked',code:'SQLITE_BUSY'})
  const racing={recognitions:vi.fn(async()=>{controller.abort();return {type:'fallback' as const}})}
  expect(await readRecognitions(f.owner,{},controller.signal,racing)).toBeUndefined()
  expect(await readRecognitions(f.owner,{},controller.signal,terminal)).toBeUndefined()
  expect(terminal.recognitions).toHaveBeenCalledTimes(1);expect(prepare).not.toHaveBeenCalled()
  expect(getEventListeners(controller.signal,'abort')).toHaveLength(0);prepare.mockRestore()
})
it('ordinary inode and symlink replacement retain the cached original owner while fresh managed opens certify the new file',async()=>{
  const f=await fixture(),other=await fixture()
  f.writer.$client.pragma('wal_checkpoint(TRUNCATE)');other.writer.$client.pragma('wal_checkpoint(TRUNCATE)')
  // Different domain truth is created through the public import API.
  expect((await other.client.commit({idempotencyKey:'second',sourceKind:'announcement',sourceIdentity:'synthetic/second',payload:{announcement:{...other.payload.announcement,records:[{...other.payload.announcement.records[0]!,enterprise:{name:'另一合成企业'}}]}}})).status).toBe('committed')
  f.writer.$client.pragma('wal_checkpoint(TRUNCATE)');other.writer.$client.pragma('wal_checkpoint(TRUNCATE)')
  // Close readonly handles before rotation; retain the original writer as the
  // old cached owner via a tracked readwrite handle on an already existing file.
  const link=join(f.dir,'link.db');symlinkSync(f.path,link)
  const linked=useDb({dbPath:link,readOnly:true});cleanup.push(()=>{if(linked.$client.open)linked.$client.close()})
  expect(getDbOwnerIdentity(linked)).toBeDefined()
  unlinkSync(link);symlinkSync(other.path,link)
  expect(getDbOwnerIdentity(linked)).toBeUndefined()
  expect(decoded(await readRecognitions(linked,{}))).toMatchObject({counts:{titlePairs:1},rows:[{name:'合成M1企业'}]})
  const moved=join(f.dir,'old.db');renameSync(f.path,moved)
  renameSync(other.path,f.path)
  expect(getDbOwnerIdentity(f.owner)).toBeUndefined()
  const fallback={recognitions:vi.fn()}
  expect(decoded(await readRecognitions(f.owner,{},undefined,fallback))).toMatchObject({counts:{titlePairs:1},rows:[{name:'合成M1企业'}]})
  expect(fallback.recognitions).not.toHaveBeenCalled()
  const fresh=join(f.dir,'fresh.db');symlinkSync(f.path,fresh)
  const reopened=useDb({dbPath:fresh,readOnly:true});cleanup.push(()=>reopened.$client.close())
  expect(getDbOwnerIdentity(reopened)).toBeDefined()
})

it.each(['inode','symlink'])('child verifies %s identity again after queue wait and fallback keeps the original owner',async kind=>{
  const f=await fixture(),other=await fixture()
  await other.client.commit({idempotencyKey:'extra',sourceKind:'announcement',sourceIdentity:'synthetic/extra',payload:{announcement:{...other.payload.announcement,records:[{...other.payload.announcement.records[0]!,enterprise:{name:'另一企业'}}]}}})
  f.writer.$client.pragma('wal_checkpoint(TRUNCATE)');other.writer.$client.pragma('wal_checkpoint(TRUNCATE)')
  const link=join(f.dir,'queued-link.db');symlinkSync(f.path,link)
  const owner=kind==='inode'?f.owner:useDb({dbPath:link,readOnly:true})
  if(owner!==f.owner)cleanup.push(()=>owner.$client.close())
  let readySeen!:()=>void,releaseReady!:()=>void
  const seen=new Promise<void>(resolve=>{readySeen=resolve})
  const reads=createEnterpriseReadExecutor({createWorker:()=>{
    const worker=createEnterpriseWorker(),on=worker.on.bind(worker)
    worker.on=((event:string,listener:(message:any)=>void)=>on(event,(message:any)=>{
      if(event==='message'&&message.type==='ready'){releaseReady=()=>listener(message);readySeen()}
      else listener(message)
    })) as typeof worker.on
    return worker
  }})
  cleanup.push(()=>reads.close())
  const pending=readRecognitions(owner,{},undefined,reads)
  await seen
  if(kind==='inode'){renameSync(f.path,join(f.dir,'old.db'));renameSync(other.path,f.path)}
  else {unlinkSync(link);symlinkSync(other.path,link)}
  releaseReady()
  const result=await pending
  expect(Buffer.isBuffer(result)).toBe(false)
  expect(result).toMatchObject({counts:{titlePairs:1},rows:[{name:'合成M1企业'}]})
})

it('a real child read can wait while the original synchronous FIFO reads an independent memory owner',async()=>{
  const f=await fixture();f.writer.$client.pragma('journal_mode=DELETE')
  const native=new Database(f.writer.$client.serialize()),memory=drizzle(native,{schema})
  cleanup.push(()=>native.close())
  const reads=createEnterpriseReadExecutor();cleanup.push(()=>reads.close())
  expect(Buffer.isBuffer(await readRecognitions(f.owner,{},undefined,reads))).toBe(true)
  const lock=new Worker(`const {parentPort,workerData}=require('node:worker_threads'),D=require(workerData.driver),db=new D(workerData.path);db.exec('BEGIN EXCLUSIVE');parentPort.postMessage('locked');setTimeout(()=>{db.exec('ROLLBACK');db.close();parentPort.postMessage('released');parentPort.close()},800)`,{eval:true,execArgv:[],workerData:{driver:createRequire(import.meta.url).resolve('better-sqlite3'),path:f.path}})
  cleanup.push(()=>lock.terminate());await once(lock,'message')
  let released=false,complete=false
  lock.on('message',()=>{released=true})
  let observe:(message:any)=>void
  const dispatched=new Promise<void>(resolve=>{observe=message=>{if(message.phase==='start'){channel('ningbo.enterprise-read').unsubscribe(observe);resolve()}};channel('ningbo.enterprise-read').subscribe(observe)})
  cleanup.push(()=>channel('ningbo.enterprise-read').unsubscribe(observe))
  const pending=readRecognitions(f.owner,{},undefined,reads).then(value=>{complete=true;return value})
  await dispatched
  const original=await readRecognitions(memory as typeof f.owner,{})
  expect(original).toMatchObject({counts:{titlePairs:1},rows:[{name:'合成M1企业'}]})
  expect(complete).toBe(false);expect(released).toBe(false)
  expect(decoded(await pending)).toEqual(original)
})
