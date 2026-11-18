import '../../support/compiled-enterprise-reader'
import { getEventListeners, once } from 'node:events'
import { Worker } from 'node:worker_threads'
import { createRequire } from 'node:module'
import { channel } from 'node:diagnostics_channel'
import { mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initializeDb, getDbOwnerIdentity, schema } from '../../../db/client'
import { readRecognitions } from '../../../layers/sme-roster/server/utils/recognition-read'
import { readDifferences } from '../../../server/utils/difference-read'
import { readSummary } from '../../../server/utils/comparison-summary-read'
import { createReadTurns } from '../../../layers/core/server/utils/read-turn'
import { createEnterpriseReadExecutor } from '../../../layers/sme-roster/server/utils/enterprise-read'
import { createEnterpriseWorker } from '../../../layers/sme-roster/server/utils/enterprise-read-worker-location'
import { captureReaderError } from '../../../layers/sme-roster/lib/roster/offmain-read-protocol'
import { executeNativeImport, startRosterApi } from '../imports/fixtures/import-server'
import { createRosterImportClient } from '../../../lib/roster-import-client'

const cleanup: Array<() => unknown|Promise<unknown>>=[]
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close()})
async function fixture(filename='fixture.db') {
  const dir=mkdtempSync(join(tmpdir(),'recognition-m1-owner-')),path=join(dir,filename)
  cleanup.push(()=>rmSync(dir,{recursive:true,force:true}))
  const writer=initializeDb({ create: true, dbPath:path})
  cleanup.push(()=>{if(writer.$client.open)writer.$client.close()})
  // Seed through real HTTP and native import core. Reader workers remain real;
  // setup must not retain an unrelated import worker when journal mode changes.
  const api=await startRosterApi({db:writer,apiToken:'synthetic-m1',executeImport:executeNativeImport});cleanup.push(()=>api.close())
  const client=createRosterImportClient({baseUrl:api.baseUrl,token:'synthetic-m1'})
  const payload={announcement:{sourceDocument:{source:'jxj' as const,title:'合成 M1'},records:[{enterprise:{name:'合成M1企业'},titleCode:'specialized_sme',events:[{eventType:'award' as const,year:2021,evidence:[{sourceFile:'synthetic/m1.pdf',page:3}]}]}]}}
  expect((await client.commit({idempotencyKey:'seed',sourceIdentity:'synthetic/m1',sourceKind:'announcement',payload})).status).toBe('committed')
  const owner=initializeDb({ create: true, dbPath:path,readOnly:true});cleanup.push(()=>{if(owner.$client.open)owner.$client.close()})
  return {dir,path,owner,writer,client,payload}
}
const decoded=(out:unknown)=>Buffer.isBuffer(out)?JSON.parse(out.toString()):out
describe('managed owner eligibility', () => {
let f: Awaited<ReturnType<typeof fixture>>
beforeEach(async () => { f = await fixture('literal:memory:.db') })
it('managed existing disk owner is eligible, real memory and untracked handles are ineligible, and a filename containing :memory: is disk',async()=>{
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
describe('managed owner rotation', () => {
let f: Awaited<ReturnType<typeof fixture>>, other: Awaited<ReturnType<typeof fixture>>
// Each fixture boots a real import executor. Prepare them in standard hooks,
// rather than spending the identity scenario's unchanged 5s on cold boot.
beforeEach(async () => { f = await fixture() })
beforeEach(async () => { other = await fixture() })
it('ordinary inode and symlink replacement retain the cached original owner while fresh managed opens certify the new file',async()=>{
  f.writer.$client.pragma('wal_checkpoint(TRUNCATE)');other.writer.$client.pragma('wal_checkpoint(TRUNCATE)')
  // Different domain truth is created through the public import API.
  expect((await other.client.commit({idempotencyKey:'second',sourceKind:'announcement',sourceIdentity:'synthetic/second',payload:{announcement:{...other.payload.announcement,records:[{...other.payload.announcement.records[0]!,enterprise:{name:'另一合成企业'}}]}}})).status).toBe('committed')
  f.writer.$client.pragma('wal_checkpoint(TRUNCATE)');other.writer.$client.pragma('wal_checkpoint(TRUNCATE)')
  // Close readonly handles before rotation; retain the original writer as the
  // old cached owner via a tracked readwrite handle on an already existing file.
  const link=join(f.dir,'link.db');symlinkSync(f.path,link)
  const linked=initializeDb({ create: true, dbPath:link,readOnly:true});cleanup.push(()=>{if(linked.$client.open)linked.$client.close()})
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
  const reopened=initializeDb({ create: true, dbPath:fresh,readOnly:true});cleanup.push(()=>reopened.$client.close())
  expect(getDbOwnerIdentity(reopened)).toBeDefined()
})

it.each([
  ['inode', 'recognitions'], ['symlink', 'recognitions'],
  ['inode', 'differences'], ['symlink', 'differences'],
  ['inode', 'summary'], ['symlink', 'summary'],
] as const)('child verifies %s identity for %s again after queue wait and fallback keeps the original owner',async (kind, operation)=>{
  await other.client.commit({idempotencyKey:'extra',sourceKind:'announcement',sourceIdentity:'synthetic/extra',payload:{announcement:{...other.payload.announcement,records:[{...other.payload.announcement.records[0]!,enterprise:{name:'另一企业'}}]}}})
  f.writer.$client.pragma('wal_checkpoint(TRUNCATE)');other.writer.$client.pragma('wal_checkpoint(TRUNCATE)')
  const link=join(f.dir,'queued-link.db');symlinkSync(f.path,link)
  const owner=kind==='inode'?f.owner:initializeDb({ create: true, dbPath:link,readOnly:true})
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
  const pending=operation==='recognitions'?readRecognitions(owner,{},undefined,reads):operation==='summary'
    ? readSummary(owner,{curatedPath:join(f.dir,'curated.json'),reconcilePath:join(f.dir,'reconcile.json'),page:1,pageSize:25,showCurated:false},undefined,reads)
    :readDifferences(owner,{},undefined,reads)
  await Promise.race([seen, pending.then(() => { throw new Error('Reader settled before the held readiness barrier') })])
  if(kind==='inode'){renameSync(f.path,join(f.dir,'old.db'));renameSync(other.path,f.path)}
  else {unlinkSync(link);symlinkSync(other.path,link)}
  releaseReady()
  const result=await pending
  expect(Buffer.isBuffer(result)).toBe(false)
  expect(result).toMatchObject(operation==='recognitions'?{counts:{titlePairs:1},rows:[{name:'合成M1企业'}]}:operation==='summary'
    ?{view:'summary',total:1,rows:[{name:'合成M1企业',platform:{disposition:{status:'not_queried',explanationId:null}}}]}
    :{total:1,rows:[{name:'合成M1企业',status:'not_queried',explanationId:null}]})
})
})

it('REST uses the same conservative owner identity for disk memory untracked transaction inode and symlink owners',async()=>{
  const f=await fixture()
  f.writer.$client.pragma('journal_mode=DELETE')
  const reads=createEnterpriseReadExecutor()
  cleanup.push(()=>reads.close())
  const expected={total:1,rows:[{name:'合成M1企业',status:'not_queried',explanationId:null}]}
  const child=await readDifferences(f.owner,{},undefined,reads)
  expect(Buffer.isBuffer(child)).toBe(true);expect(decoded(child)).toMatchObject(expected)
  const original=await readDifferences(f.writer,{})
  expect(Buffer.isBuffer(original)).toBe(false);expect(original).toEqual(decoded(child))
  const native=new Database(f.writer.$client.serialize()),memory=drizzle(native,{schema})
  cleanup.push(()=>native.close())
  const never={differences:vi.fn()}
  expect(await readDifferences(memory as typeof f.owner,{},undefined,never)).toEqual(original)
  const untracked=drizzle(f.owner.$client,{schema})
  expect(await readDifferences(untracked,{},undefined,never)).toEqual(original)
  f.owner.$client.exec('BEGIN')
  try {expect(await readDifferences(f.owner,{},undefined,never)).toEqual(original)}finally{f.owner.$client.exec('ROLLBACK')}
  const link=join(f.dir,'m2-link.db');symlinkSync(f.path,link)
  const linked=initializeDb({ create: true, dbPath:link,readOnly:true});cleanup.push(()=>linked.$client.close())
  unlinkSync(link);symlinkSync(join(f.dir,'absent.db'),link)
  expect(await readDifferences(linked,{},undefined,never)).toEqual(original)
  renameSync(f.path,join(f.dir,'original.db'))
  expect(await readDifferences(f.owner,{},undefined,never)).toEqual(original)
  expect(never.differences).not.toHaveBeenCalled()
})

it('REST metadata overflow and full original FIFO invoke the original once while terminal failure and abort never replay',async()=>{
  const f=await fixture(), reads=createEnterpriseReadExecutor()
  cleanup.push(()=>reads.close())
  const prepare=vi.spyOn(f.owner.$client,'prepare')
  const turns=createReadTurns((n:{n:number})=>n.n), held=Array.from({length:16},(_,n)=>turns.submit({n}))
  const pending=readDifferences(f.owner,{q:'界'.repeat(22000)},undefined,reads)
  await Promise.resolve() // private admission outcome resumes original inline FIFO fallback
  expect(prepare.mock.calls.filter(([sql])=>sql.includes('from "difference_reason" where not exists'))).toHaveLength(1)
  expect(await pending).toMatchObject({total:0,rows:[]})
  for(const job of held)job.cancel()
  prepare.mockClear()
  const terminal={differences:vi.fn(async()=>({type:'reader-error' as const,error:captureReaderError(Object.assign(new Error('locked'),{code:'SQLITE_BUSY'}))}))}
  await expect(readDifferences(f.owner,{},undefined,terminal)).rejects.toMatchObject({code:'SQLITE_BUSY'})
  const controller=new AbortController(), racing={differences:vi.fn(async()=>{controller.abort();return {type:'fallback' as const}})}
  expect(await readDifferences(f.owner,{},controller.signal,racing)).toBeUndefined()
  expect(prepare).not.toHaveBeenCalled()
  await reads.close()
  expect(await readDifferences(f.owner,{},undefined,reads)).toMatchObject({total:1})
  expect(prepare.mock.calls.filter(([sql])=>sql.includes('from "difference_reason" where not exists'))).toHaveLength(1)
  prepare.mockRestore()
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

it('summary uses the same conservative owner for disk memory untracked transaction inode and symlink paths',async()=>{
  const f=await fixture(),reads=createEnterpriseReadExecutor()
  cleanup.push(()=>reads.close())
  const options={curatedPath:join(f.dir,'curated.json'),reconcilePath:join(f.dir,'reconcile.json'),showCurated:false,page:1,pageSize:25}
  f.writer.$client.pragma('journal_mode=DELETE')
  const child=await readSummary(f.owner,options,undefined,reads)
  expect(Buffer.isBuffer(child)).toBe(true)
  expect(decoded(child)).toMatchObject({view:'summary',total:1,rows:[{name:'合成M1企业',evidenceIncluded:false,platform:{disposition:{status:'not_queried',explanationId:null}}}]})
  const original=await readSummary(f.writer,options)
  expect(Buffer.isBuffer(original)).toBe(false);expect(original).toEqual(decoded(child))
  const native=new Database(f.writer.$client.serialize()),memory=drizzle(native,{schema})
  cleanup.push(()=>native.close())
  const never={summary:vi.fn()}
  expect(await readSummary(memory as typeof f.owner,options,undefined,never)).toEqual(original)
  expect(await readSummary(drizzle(f.owner.$client,{schema}),options,undefined,never)).toEqual(original)
  const inTransaction:boolean[]=[]
  const prepare=f.owner.$client.prepare.bind(f.owner.$client)
  const spy=vi.spyOn(f.owner.$client,'prepare').mockImplementation(((sql:string)=>{inTransaction.push(f.owner.$client.inTransaction);return prepare(sql)}) as typeof prepare)
  f.owner.$client.exec('BEGIN')
  try {expect(await readSummary(f.owner,options,undefined,never)).toEqual(original)}finally{f.owner.$client.exec('ROLLBACK');spy.mockRestore()}
  expect(inTransaction.length).toBeGreaterThan(0);expect(inTransaction.every(Boolean)).toBe(true)
  const link=join(f.dir,'m3-link.db');symlinkSync(f.path,link)
  const linked=initializeDb({ create: true, dbPath:link,readOnly:true});cleanup.push(()=>linked.$client.close())
  unlinkSync(link);symlinkSync(join(f.dir,'absent.db'),link)
  expect(await readSummary(linked,options,undefined,never)).toEqual(original)
  renameSync(f.path,join(f.dir,'original.db'))
  expect(await readSummary(f.owner,options,undefined,never)).toEqual(original)
  expect(never.summary).not.toHaveBeenCalled()
})

it('summary metadata and FIFO overflow invoke one whole transactional original callback while errors and abort never replay',async()=>{
  const f=await fixture(),reads=createEnterpriseReadExecutor()
  cleanup.push(()=>reads.close())
  const options={curatedPath:join(f.dir,'curated.json'),reconcilePath:join(f.dir,'reconcile.json'),showCurated:false,page:1,pageSize:25}
  const sourceEntries:boolean[]=[],prepare=f.owner.$client.prepare.bind(f.owner.$client)
  const spy=vi.spyOn(f.owner.$client,'prepare').mockImplementation(((sql:string)=>{if(sql.includes('with differences as ('))sourceEntries.push(f.owner.$client.inTransaction);return prepare(sql)}) as typeof prepare)
  try {
    const turns=createReadTurns((n:{n:number})=>n.n),held=Array.from({length:16},(_,n)=>turns.submit({n}))
    try {
      const pending=readSummary(f.owner,{...options,q:'界'.repeat(22000)},undefined,reads)
      await Promise.resolve()
      expect(sourceEntries).toEqual([true])
      expect(await pending).toMatchObject({view:'summary',total:0,rows:[],counts:{specialized_sme:{missing_in_miit:1}}})
    } finally {for(const job of held)job.cancel()}
    sourceEntries.length=0
    const terminal={summary:vi.fn(async()=>({type:'reader-error' as const,error:captureReaderError(new SyntaxError('malformed curation'))}))}
    await expect(readSummary(f.owner,options,undefined,terminal)).rejects.toMatchObject({name:'SyntaxError',message:'malformed curation'})
    const controller=new AbortController(),racing={summary:vi.fn(async()=>{controller.abort();return {type:'fallback' as const}})}
    expect(await readSummary(f.owner,options,controller.signal,racing)).toBeUndefined()
    expect(await readSummary(f.owner,options,controller.signal,terminal)).toBeUndefined()
    expect(terminal.summary).toHaveBeenCalledTimes(1);expect(sourceEntries).toEqual([])
    await reads.close()
    expect(await readSummary(f.owner,options,undefined,reads)).toMatchObject({view:'summary',total:1})
    expect(sourceEntries).toEqual([true]);sourceEntries.length=0
    const error=new SyntaxError('original curation error')
    spy.mockImplementation(()=>{throw error})
    await expect(readSummary(f.owner,options,undefined,reads)).rejects.toBe(error)
  } finally {spy.mockRestore()}
})
