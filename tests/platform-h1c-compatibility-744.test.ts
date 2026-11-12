import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { readFileSync, statSync } from 'node:fs'
import { serialize } from 'node:v8'
import { join } from 'node:path'
import { beforeAll, afterAll, expect, it } from 'vitest'
import { processReaderFixture } from './helpers/process-target-734'
import { controlledH1cSuccessor } from './helpers/h1c-catalog-target'
import { targetSchema } from '../lib/platform/target-schema'
import { requireH1cReady } from '../lib/platform/h1c-catalog'
import { processStoredInstalled } from '../lib/platform/process-stored-catalog'
import { recognizedStoredInstalled } from '../lib/platform/recognized-stored-catalog'
import { witnessInstalled } from '../lib/platform/recognized-witness-catalog'
import { listTargetBusinessProcesses } from '../server/utils/platform-business-processes-target'
import { writeProcessTarget, type ProcessTargetInput } from '../lib/platform/process-target-writer'
import { writeApplyTarget } from '../lib/platform/apply-target-writer'
import { writeRecognizedTarget } from '../lib/platform/recognized-target-writer'
import { verifyFingerprint } from '../lib/platform/fingerprint-verifier'
import { writeCollectionTarget } from '../lib/platform/collection-target-command'
import { projectionManifest } from '../upgrade/projections'

let f:Awaited<ReturnType<typeof processReaderFixture>>,target:Database.Database
beforeAll(async()=>{f=await processReaderFixture(false,old=>old.exec("INSERT INTO platform_query(id,interface,query_key,rdjb,queried_at,status,created_at) VALUES(21,'apply_list','apply','2','t','success','c'),(22,'recognized_list','recognized','2','t','success','c')"));target=controlledH1cSuccessor(f)})
afterAll(()=>{target?.close();f?.close()})
const db=()=>drizzle(target,{schema:targetSchema})
const input=(sequenceNo:number):ProcessTargetInput=>({collectionId:11,position:{sequenceNo,positionState:'unknown'},row:{sequenceNo,nameRaw:'New',relationKey:'N'+sequenceNo,rawFields:{id:'N'+sequenceNo,rdjb:'2',cszt:'pending',year:2024}},assignment:{nameRaw:'New',matchBasis:'none',verificationStatus:'pending',origin:'command',actor:{type:'agent',id:'compatibility'},basis:'original'}})
it('reads completed 71610 and 71611 targets with the same original process values',()=>{
 for(const t of [f.t,target]){expect(processStoredInstalled(t)).toBe(true);expect(recognizedStoredInstalled(t)).toBe(true);expect(witnessInstalled(t)).toBe(true)}
 expect(()=>requireH1cReady(target)).not.toThrow()
 expect(listTargetBusinessProcesses({},db())).toEqual(listTargetBusinessProcesses({},f.db))
 expect(listTargetBusinessProcesses({view:'isolated',titleRaw:' X '},db())).toMatchObject({total:1,rows:[{titleRaw:' X ',status:' pending ',batch:' B ',nameRaw:' Original '}]})
})
it('writes and replays normal observations with unchanged business fingerprints on both versions',()=>{
 for(const [t,d] of [[f.t,f.db],[target,db()]] as const){
  const value=input(90),result=writeProcessTarget(d,value)
  expect(verifyFingerprint(t,{observationId:result.observationId,collectionId:11,relationAlias:result.relationAlias})).toMatchObject({observationId:result.observationId,scheme:'target-command-v1'})
  const before=projectionManifest(t)
  expect(writeProcessTarget(d,value).reused).toBe(true)
  expect(projectionManifest(t)).toBe(before)
  expect(t.pragma('foreign_key_check')).toEqual([])
 }
})
it('runs complete target commands and normal replay without duplicate business writes',()=>{
 const command={queryText:JSON.stringify({interface:'business_list',queryKey:'normal-command',queriedAt:'normal-time',status:'success',rawResponse:'{}',relations:[{sequenceNo:1,rawFields:{id:'COMMAND',rdjb:'2',cszt:'pending'}}]}),evidenceText:null,createdAt:'c',assignments:[{matchBasis:'none' as const,verificationStatus:'pending' as const,origin:'command' as const,actor:{type:'agent' as const,id:'compatibility'},basis:'original'}]}
 expect(writeCollectionTarget(db(),command).reused).toBe(false)
 const before=projectionManifest(target)
 expect(writeCollectionTarget(db(),command).reused).toBe(true)
 expect(projectionManifest(target)).toBe(before)
})
it('retains apply and recognized original inputs and fingerprint replay on both completed versions',()=>{
 for(const [collectionId,writer] of [[21,writeApplyTarget],[22,writeRecognizedTarget]] as const){
  for(const [t,d] of [[f.t,f.db],[target,db()]] as const){
   const value={...input(1),collectionId},result=writer(d,value)
   expect(verifyFingerprint(t,{observationId:result.observationId,collectionId,relationAlias:result.relationAlias})).toMatchObject({scheme:'target-command-v1'})
   const before=projectionManifest(t)
   expect(writer(d,value).reused).toBe(true)
   expect(projectionManifest(t)).toBe(before)
  }
 }
})
it('rolls back actual observation archives assignments and alias allocation on a failed batch',()=>{
 const before=projectionManifest(target),sequence=target.prepare('SELECT * FROM sqlite_sequence ORDER BY name').all()
 expect(()=>db().transaction(tx=>{writeProcessTarget(tx,input(91));throw new Error('cancelled batch')})).toThrow('cancelled batch')
 expect(projectionManifest(target)).toBe(before)
 expect(target.prepare('SELECT * FROM sqlite_sequence ORDER BY name').all()).toEqual(sequence)
 expect(target.pragma('foreign_key_check')).toEqual([])
})
it.each([
 ['h1c-correspondence-observation-v1',requireH1cReady],
 ['process-exact-stored-offline-v1',processStoredInstalled],
 ['recognized-stored-title-v1',recognizedStoredInstalled],
 ['recognized-witness-offline-v1',witnessInstalled],
] as const)('reports unfinished %s migration clearly', (transform,ready)=>{
 target.exec('BEGIN')
 try{target.prepare("UPDATE platform_migration_run SET state='running' WHERE transform_version=?").run(transform);expect(()=>ready(target)).toThrow(/migration incomplete/i)}finally{target.exec('ROLLBACK')}
})
it('reports an unfinished column transfer and does not scan full catalog or receipt chains for a normal query',()=>{
 target.exec('BEGIN')
 try{target.exec('ALTER TABLE record_correspondence RENAME COLUMN observation_id TO pending_observation_id');expect(()=>requireH1cReady(target)).toThrow(/migration incomplete/i)}finally{target.exec('ROLLBACK')}
 const trace:string[]=[],reader=new Database(target.name,{readonly:true,verbose:q=>trace.push(String(q))})
 try{listTargetBusinessProcesses({},drizzle(reader,{schema:targetSchema}));expect(trace.join('\n')).not.toMatch(/sqlite_schema|platform_migration_checkpoint|CREATE TABLE|source_schema_hash|target_schema_version/)}finally{reader.close()}
})
it('keeps ordinary runtime and three source worker guards closed on the controlled successor',async()=>{
  const {useRuntimeDb,initializeDb}=await import('../db/client')
  const path=target.name, before=readFileSync(path)
  for(const readOnly of [false,true])expect(()=>useRuntimeDb({dbPath:path,readOnly})).toThrow(/finalized/i)
  expect(()=>initializeDb({dbPath:path})).toThrow(/finalized/i)
  const {createImportExecutionWorker}=await import('../server/utils/import-execution-worker-location')
  const {createCurrentExportWorker}=await import('../server/utils/current-export-worker-location')
  const {createEnterpriseWorker}=await import('../server/utils/enterprise-read-worker-location')
  const stat=statSync(path),identity={dev:stat.dev,ino:stat.ino,schemaVersion:target.pragma('schema_version',{simple:true}),migration:target.prepare('SELECT hash,created_at FROM __drizzle_migrations ORDER BY created_at DESC LIMIT 1').get()}
  for(const [kind,create] of [['import',createImportExecutionWorker],['export',createCurrentExportWorker],['read',createEnterpriseWorker]] as const){
    const worker=create()
    try {
      const result=await new Promise<Record<string,unknown>>((resolve,reject)=>{
        const timer=setTimeout(()=>reject(new Error('guard timeout '+kind)),15000)
        worker.once('error',error=>{clearTimeout(timer);reject(error)})
        worker.on('message',(message:Record<string,unknown>)=>{if(message.type!=='ready'&&message.type!=='progress'){clearTimeout(timer);resolve(message)}})
        worker.postMessage({dbPath:path,id:'h1c-guard',identity,readonly:false,action:'preflight',payload:serialize({}),operation:'list',filter:{},title:'specialized_sme',temporaryPath:join(f.root,'never.xlsx'),jobId:'h1c-guard'})
      })
      if(kind==='import')expect(result).toMatchObject({type:'failure',error:{message:expect.stringMatching(/finalized/i)}})
      if(kind==='export')expect(result).toEqual({type:'failure',message:'当前名录导出执行失败；请核对数据或资源限制后重新提交'})
      if(kind==='read')expect(result).toMatchObject({type:'failure',code:'enterprise_read_failed'})
    }finally{await worker.terminate()}
  }
  expect(readFileSync(path)).toEqual(before)
},30000)
