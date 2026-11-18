import Database from 'better-sqlite3'
import { once } from 'node:events'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { serialize } from 'node:v8'
import { afterEach, expect, it, vi } from 'vitest'
import { initializeDb, useApplicationDb } from '../../../db/client'
import { RETIRED_PLATFORM_TABLES } from '../../../db/schema-phase'
import * as s from '../../../db/schema'
import { commitRosterImport } from '../../../server/utils/roster-import'
import { createEnterpriseReadExecutor } from '../../../server/utils/enterprise-read'
import { createImportExecutionWorker } from '../../../server/utils/import-execution-worker-location'
import { listTargetBusinessProcesses } from '../../../server/utils/platform-business-processes-target'
import { runPlatformReconcile } from '../../../server/utils/platform-reconcile'
import { whenIdle } from '../../../layers/core/server/utils/job-runner'
import type { RosterImportRequest } from '../../../lib/roster-import-client'

const cleanup:Array<()=>void|Promise<unknown>>=[]
afterEach(async()=>{await whenIdle();for(const close of cleanup.splice(0).reverse())await close()})
function fixture() {
  const dir=mkdtempSync(join(tmpdir(),'final-native-')),path=join(dir,'native.sqlite')
  cleanup.push(()=>rmSync(dir,{recursive:true,force:true}))
  const db=initializeDb({dbPath:path,create:true})
  cleanup.push(()=>{if(db.$client.open)db.$client.close()})
  return {db,path}
}
function expectNative(db:Database.Database) {
  expect(db.pragma('foreign_key_check')).toEqual([])
  expect(db.pragma('user_version',{simple:true})).toBe(71613)
  for(const name of RETIRED_PLATFORM_TABLES)expect(db.prepare('select name from sqlite_schema where type=? and name=?').get('table',name)).toBeUndefined()
}
function sourceRequest(key:string):RosterImportRequest {
  return {idempotencyKey:key,sourceKind:'platform_archive',sourceIdentity:'native-runtime-source',payload:{platformQueries:[{interface:'business_list',queryKey:'name:Native',rdjb:'2',queriedAt:'2026-11-14T00:00:00Z',status:'success',rawResponse:'native original response',relations:[{sequenceNo:1,relationKey:'native-business',rawFields:{id:'native-business',rdjb:'2',qymc:'Native'}}]}]}}
}

it('initializes a native database imports replays and restarts without historical migrations',()=>{
  const {db,path}=fixture()
  expect(db.$client.prepare('select count(*) n from platform_migration_run').get()).toEqual({n:0})
  const request=sourceRequest('native-first')
  const first=commitRosterImport(db,request,[],{deferCandidateTasks:true})
  expect(first.status,JSON.stringify(first)).toBe('committed')
  const archives=db.$client.prepare('select * from platform_archive_value order by id').all()
  expect(commitRosterImport(db,request,[],{deferCandidateTasks:true})).toEqual(first)
  const replay=commitRosterImport(db,sourceRequest('native-source-replay'),[],{deferCandidateTasks:true})
  expect(replay.status,JSON.stringify(replay)).toBe('committed')
  expect(replay.summary.written).toBe(0)
  expect(db.$client.prepare('select count(*) n from platform_collection').get()).toEqual({n:1})
  expect(db.$client.prepare('select * from platform_archive_value order by id').all()).toEqual(archives)
  expect(listTargetBusinessProcesses({},db).rows).toHaveLength(1)
  expectNative(db.$client)
  db.$client.close()
  const restarted=initializeDb({dbPath:path})
  cleanup.push(()=>{restarted.$client.close()})
  expect(useApplicationDb({dbPath:path})).toBe(restarted)
  expect(listTargetBusinessProcesses({},restarted).rows).toHaveLength(1)
  expectNative(restarted.$client)
  restarted.$client.exec('CREATE TABLE platform_query(id INTEGER PRIMARY KEY)')
  // Offline schema mutation requires closing the admitted runtime connection.
  restarted.$client.close()
  expect(()=>useApplicationDb({dbPath:path})).toThrow('dependency remains')
})

it('refuses non-native databases at application and actual source worker entries',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'non-native-refusal-')),path=join(dir,'schema0.sqlite')
  cleanup.push(()=>rmSync(dir,{recursive:true,force:true}))
  const old=new Database(path)
  cleanup.push(()=>{old.close()})
  old.exec('CREATE TABLE __drizzle_migrations(id INTEGER PRIMARY KEY,hash TEXT,created_at INTEGER)')
  expect(()=>useApplicationDb({dbPath:path})).toThrow('Unsupported final platform runtime schema')
  const worker=createImportExecutionWorker();cleanup.push(()=>worker.terminate())
  expect((await once(worker,'message'))[0]).toMatchObject({type:'ready'})
  const stat=statSync(path),response=once(worker,'message')
  worker.postMessage({id:1,dbPath:path,readonly:true,identity:{dev:stat.dev,ino:stat.ino,schemaVersion:old.pragma('schema_version',{simple:true}),migration:undefined},action:'preflight',payload:serialize(sourceRequest('refuse')),pageCountErrors:[]})
  expect((await response)[0]).toMatchObject({type:'failure',error:{message:'Unsupported final platform runtime schema'}})
},30000)

it('serves native source read workers and commits an import through the actual source worker',async()=>{
  const {db,path}=fixture()
  db.insert(s.enterprise).values({name:'Native current',nameNorm:'Native current',usccNorm:'91330200712345678C'}).run()
  const entity=db.select().from(s.enterprise).get()!
  const record=db.insert(s.record).values({enterpriseId:entity.id,titleCode:'little_giant',source:'jxj',nameRaw:entity.name}).returning().get()
  db.insert(s.recordEvent).values({recordId:record.id,eventType:'award',year:2025,batchSeq:1}).run()
  const reads=createEnterpriseReadExecutor();cleanup.push(()=>reads.close())
  expect((await reads.list(path,{pageSize:5})).rows).toHaveLength(1)
  const current=await reads.currentQualifiedJson(path,{titleCode:'little_giant',pageSize:5})
  expect(current.found).toBe(true)
  const currentBody=JSON.parse(current.body.toString())
  expect(currentBody).toMatchObject({total:1,rows:[{enterpriseId:entity.id}]})
  const currentTitle=currentBody.rows[0].qualificationAssessment.titles.find((title:{titleCode:string})=>title.titleCode==='little_giant')
  expect(currentTitle).toMatchObject({titleCode:'little_giant',effectiveQualification:{status:'effective'},evidence:[{eventType:'award',year:2025,batchSeq:1}]})
  expect(currentTitle.versions.facts).toMatch(/^[a-f0-9]{64}$/)
  const stat=statSync(path),identity={dev:stat.dev,ino:stat.ino,schemaVersion:db.$client.pragma('schema_version',{simple:true}),migration:db.$client.prepare('SELECT hash,created_at FROM __drizzle_migrations ORDER BY created_at DESC LIMIT 1').get()}
  const worker=createImportExecutionWorker();cleanup.push(()=>worker.terminate())
  expect((await once(worker,'message'))[0]).toMatchObject({type:'ready'})
  for(const [index,action] of ['preflight','commit'] .entries()){
    const response=once(worker,'message')
    worker.postMessage({id:index+1,dbPath:path,readonly:false,identity,action,payload:serialize(sourceRequest('native-worker')),pageCountErrors:[]})
    expect((await response)[0]).toMatchObject({type:'result',id:index+1,result:{status:action==='preflight'?'preflight':'committed'}})
  }
  expect(listTargetBusinessProcesses({},db).rows).toHaveLength(1)
  db.$client.prepare('UPDATE record_event SET year=1999 WHERE record_id=?').run(record.id)
  const fresh=await reads.currentQualifiedJson(path,{titleCode:'little_giant',pageSize:5})
  expect(fresh.found).toBe(true)
  const freshBody=JSON.parse(fresh.body.toString())
  // Original little-giant awards do not expire by age; the worker must still
  // reread the changed fact and expose a new content version, not a stale row.
  expect(freshBody).toMatchObject({total:1})
  expect(freshBody.rows.map((row:{enterpriseId:number})=>row.enterpriseId)).toEqual([entity.id])
  const freshTitle=freshBody.rows[0].qualificationAssessment.titles.find((title:{titleCode:string})=>title.titleCode==='little_giant')
  expect(freshTitle).toMatchObject({titleCode:'little_giant',effectiveQualification:{status:'effective'},evidence:[{eventType:'award',year:1999,batchSeq:1}]})
  expect(freshTitle.versions.facts).toMatch(/^[a-f0-9]{64}$/)
  expect(freshTitle.versions.facts).not.toBe(currentTitle.versions.facts)
  expectNative(db.$client)
},30000)

it('captures four native reconcile slots and reuses them without network or duplicate archives',async()=>{
  const {db}=fixture(),uscc='91330200712345678C',time='2026-11-14T04:00:00Z'
  const entity=db.insert(s.enterprise).values({name:'Native reconcile',nameNorm:'Native reconcile',usccNorm:uscc}).returning().get()
  db.insert(s.record).values({enterpriseId:entity.id,titleCode:'specialized_sme',source:'jxj',nameRaw:entity.name,usccRaw:uscc}).run()
  const fetchImpl=vi.fn(async()=>({ok:true,status:200,text:async()=>JSON.stringify({zrarData:{grid:{businessListGrid:{page:1,pageSize:50,maxCount:0,pageSet:[]},applyGrid:{page:1,pageSize:50,maxCount:0,pageSet:[]}}}})}))
  const options={db,titles:['specialized_sme'],usccs:[uscc],now:()=>new Date(time),cookie:'synthetic-native=1',fetchImpl,retries:0}
  const first=await runPlatformReconcile(options)
  expect(first).toMatchObject({targetCount:1,queries:{network:4,reused:0},write:{status:'committed'}})
  expect(db.$client.prepare('select count(*) n from platform_collection').get()).toEqual({n:4})
  const originals=db.$client.prepare('select * from platform_archive_value order by id').all()
  const second=await runPlatformReconcile({...options,fetchImpl:async()=>{throw new Error('Fresh native slots must not fetch')}})
  expect(second).toMatchObject({targetCount:1,queries:{network:0,reused:4}})
  expect(db.$client.prepare('select * from platform_archive_value order by id').all()).toEqual(originals)
  expectNative(db.$client)
},30000)
