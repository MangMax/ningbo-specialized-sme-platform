import Database from 'better-sqlite3'
import { join } from 'node:path'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { beforeAll, afterAll, expect, it } from 'vitest'
import { z } from 'zod'
import { processReaderFixture, emptyProcessReaderFixture } from './helpers/process-target-734'
import { controlledH1cSuccessor } from './helpers/h1c-catalog-target'
import { projectionManifest } from '../upgrade/projections'
import { schemaHash } from '../lib/platform/sqlite-row-cells'
import { listTargetBusinessProcesses, readTargetBusinessProcessOptions, readTargetBusinessProcessFacts, getTargetBusinessProcess } from '../server/utils/platform-business-processes-target'
import { listTargetRecognizedDirectory, readTargetRecognizedOptions, getTargetRecognizedRecord } from '../server/utils/platform-recognized-target'
import { capturePhase } from '../lib/platform/fingerprint-capture'
import { listTargetDeclarations } from '../server/utils/platform-declarations-target'
import { writeProcessTarget } from '../lib/platform/process-target-writer'
import { readTargetRelationEvidenceDisplay } from '../server/utils/platform-relation-evidence-display-target'
import { processStoredInstalled, processPredecessorSchema, inheritProcessStoredCatalog } from '../lib/platform/process-stored-catalog'
import { witnessCatalogPresent, witnessInstalled, witnessPredecessorSchema, inheritWitnessCatalog } from '../lib/platform/recognized-witness-catalog'
import { recognizedStoredInstalled, inheritRecognizedStoredCatalog } from '../lib/platform/recognized-stored-catalog'
import { targetSchema } from '../lib/platform/target-schema'
import * as schema from '../db/schema'
import { ensurePlatformObservation } from '../server/utils/platform-business-record'

let source: Awaited<ReturnType<typeof processReaderFixture>>, target: Database.Database
beforeAll(async()=>{
  source=await processReaderFixture(false,old=>{
    old.exec(`INSERT INTO platform_query(id,interface,query_key,rdjb,queried_at,status,created_at) VALUES(21,'recognized_list','R','2','t','success','c');
      INSERT INTO platform_relation(id,query_id,sequence_no,name_raw,raw_fields,created_at) VALUES(21,21,1,'Directory','{"id":"R","rdjb":"2","whpcyear":"2024","rddqrq":" date ","whpc":"B"}','c')`)
    ensurePlatformObservation(drizzle(old,{schema}),21)
  })
  target=controlledH1cSuccessor(source)
})
afterAll(()=>{target?.close();source?.close()})

it('inherits the exact process witness and recognized catalog chain on an authenticated controlled successor',()=>{
  expect(processStoredInstalled(target)).toBe(true)
  expect(processPredecessorSchema(target)).toBe(processPredecessorSchema(source.t))
  expect(witnessCatalogPresent(target)).toBe(true)
  expect(witnessInstalled(target)).toBe(true)
  expect(witnessPredecessorSchema(target)).toBe(witnessPredecessorSchema(source.t))
  expect(recognizedStoredInstalled(target)).toBe(true)
})

const catalogCalls=[processStoredInstalled,processPredecessorSchema,witnessCatalogPresent,witnessInstalled,witnessPredecessorSchema,recognizedStoredInstalled]
function state(t:Database.Database){return {catalog:schemaHash(t),facts:projectionManifest(t),runs:t.prepare('SELECT * FROM platform_migration_run ORDER BY run_id').all(),checkpoints:t.prepare('SELECT * FROM platform_migration_checkpoint ORDER BY run_id,phase,source_table').all(),changes:t.prepare('SELECT total_changes() n').get()}}
it('keeps populated primary read DTOs options and facts equal to accepted 71610 with literal original cells',()=>{
  const db=drizzle(target,{schema:targetSchema}),before=state(target),old=state(source.t)
  for(const view of ['records','isolated'] as const){
    for(const filter of [{},{rdjb:'2'},{platformKey:'A'},{page:99},{year:2024},{titleRaw:' X '}])expect(listTargetBusinessProcesses({view,...filter},db)).toEqual(listTargetBusinessProcesses({view,...filter},source.db))
    expect(readTargetBusinessProcessOptions(view,db)).toEqual(readTargetBusinessProcessOptions(view,source.db))
    expect(listTargetRecognizedDirectory({view},db)).toEqual(listTargetRecognizedDirectory({view},source.db))
    expect(readTargetRecognizedOptions(view,db)).toEqual(readTargetRecognizedOptions(view,source.db))
  }
  expect(readTargetBusinessProcessFacts(db,[1,2,5,7,8])).toEqual(readTargetBusinessProcessFacts(source.db,[1,2,5,7,8]))
  expect(listTargetBusinessProcesses({view:'isolated',titleRaw:' X '},db)).toMatchObject({total:1,rows:[{relationId:5,titleRaw:' X ',status:' pending ',batch:' B ',nameRaw:' Original ',usccRaw:' U '}]})
  expect(listTargetRecognizedDirectory({},db)).toMatchObject({total:1,rows:[{record:{platformKey:'R'},matchedVersion:{validityDateRaw:'date',maintenanceYear:2024,maintenanceBatch:'B'}}]})
  expect(state(target)).toEqual(before);expect(state(source.t)).toEqual(old)
})
it('accepts the complete empty successor catalog and returns the original empty read DTOs',async()=>{
  const f=await emptyProcessReaderFixture(),t=controlledH1cSuccessor(f),db=drizzle(t,{schema:targetSchema})
  try{
    for(const call of catalogCalls)expect(call(t)).toEqual(call(f.t))
    expect(listTargetBusinessProcesses({},db)).toEqual({view:'records',rows:[],total:0,page:1,pageSize:25})
    expect(listTargetRecognizedDirectory({},db)).toEqual({view:'records',rows:[],total:0,page:1,pageSize:25})
  }finally{t.close();f.close()}
})
it('preserves actual accepted 71608 and 71609 catalogs and the original declarations boundary',()=>{
  const a8=new Database(join(source.root,'71608.sqlite'),{readonly:true})
  const a9=new Database(join(source.root,'process-source.sqlite'),{readonly:true})
  try{
    expect(processStoredInstalled(a8)).toBe(false);expect(processPredecessorSchema(a8)).toBeNull()
    expect(witnessInstalled(a8)).toBe(false);expect(recognizedStoredInstalled(a8)).toBe(false)
    expect(listTargetDeclarations({},drizzle(a8,{schema:targetSchema}))).toMatchObject({total:0,rows:[]})
    expect(processStoredInstalled(a9)).toBe(false);expect(processPredecessorSchema(a9)).toBeNull()
    expect(witnessInstalled(a9)).toBe(true);expect(recognizedStoredInstalled(a9)).toBe(true)
    expect(listTargetRecognizedDirectory({},drizzle(a9,{schema:targetSchema}))).toEqual(listTargetRecognizedDirectory({},source.db))
    expect(()=>listTargetDeclarations({},source.db)).toThrow('Declaration reader requires 71608')
  }finally{a8.close();a9.close()}
})
const invalid=[
  ['missing successor receipt',"DELETE FROM platform_migration_checkpoint WHERE run_id='h1c';DELETE FROM platform_migration_run WHERE run_id='h1c'"],
  ['forged target catalog',"UPDATE platform_migration_run SET target_schema_version='"+'f'.repeat(64)+"' WHERE run_id='h1c'"],
  ['changed exact predecessor receipt',"UPDATE platform_migration_run SET source_snapshot_sha256='"+'f'.repeat(64)+"' WHERE run_id='process'"],
  ['unrelated index','CREATE INDEX extra_unrelated ON enterprise(name)'],
  ['sqliteX prefix gap','CREATE INDEX sqliteXhidden ON enterprise(name)'],
  ['missing process barrier','DROP TRIGGER platform_process_stored_no_update'],
] as const
it.each(invalid)('all wired primary catalog and reader entries reject %s without authentication writes',(_name,sql)=>{
  target.exec('BEGIN')
  try{
    target.exec(sql)
    const before=state(target),db=drizzle(target,{schema:targetSchema})
    for(const call of catalogCalls)expect(()=>call(target),call.name).toThrow()
    for(const call of [()=>listTargetBusinessProcesses({},db),()=>readTargetBusinessProcessOptions('records',db),()=>readTargetBusinessProcessFacts(db,[]),()=>listTargetRecognizedDirectory({},db),()=>readTargetRecognizedOptions('records',db)])expect(call).toThrow()
    expect(state(target)).toEqual(before)
  }finally{target.exec('ROLLBACK')}
  for(const call of catalogCalls)expect(()=>call(target)).not.toThrow()
})
it('refuses marker-only 71611 on the actual unconverted predecessor',()=>{
  source.t.exec('BEGIN')
  try{source.t.pragma('user_version=71611');for(const call of catalogCalls)expect(()=>call(source.t)).toThrow()}finally{source.t.exec('ROLLBACK')}
})
it.each([0,71605,71606,71607,71608,71609,71612])('preserves original gate results and errors for unsupported or earlier phase %i',phase=>{
  // Same unchanged71610 catalog under controlled markers: compare new API behavior
  // with the accepted exact pre-A2 error literals, never treat marker as readiness.
  source.t.exec('BEGIN')
  try{
    source.t.pragma(`user_version=${phase}`)
    expect(()=>processStoredInstalled(source.t)).toThrow('process_stored_phase_or_receipt')
    expect(processPredecessorSchema(source.t)).toBeNull()
    if(phase!==71609){expect(()=>witnessInstalled(source.t)).toThrow('witness_schema_phase');expect(()=>recognizedStoredInstalled(source.t)).toThrow('recognized_stored_schema_columns')}
  }finally{source.t.exec('ROLLBACK')}
})
it('keeps B detail column access rejected while declarations capture and untrusted staging remain closed',()=>{
  const db=drizzle(target,{schema:targetSchema}),before=state(target)
  expect(()=>getTargetBusinessProcess(db,1)).toThrow(/no such column/)
  const row=target.prepare("SELECT id FROM platform_business_record WHERE interface='recognized_list'").get() as {id:number}
  expect(()=>getTargetRecognizedRecord(db,row.id)).toThrow(/no such column/)
  expect(()=>listTargetDeclarations({},db)).toThrow('Declaration reader requires 71608')
  expect(()=>capturePhase(db,true)).toThrow('Explicit finalized target required')
  expect(()=>writeProcessTarget(db,{collectionId:11,position:{sequenceNo:99,positionState:'unknown'},row:{sequenceNo:99,rawFields:{}},assignment:{matchBasis:'none',verificationStatus:'pending',origin:'command',actor:{type:'agent',id:'h1c-a2a'},basis:'controlled'}})).toThrow('Explicit finalized target required')
  expect(()=>readTargetRelationEvidenceDisplay(db,[{relationId:1}])).toThrow('Explicit 71610 evidence display target required')
  const scratch=new Database(':memory:')
  try{for(const call of [inheritProcessStoredCatalog,inheritWitnessCatalog,inheritRecognizedStoredCatalog])expect(()=>call(target,scratch)).toThrow('h1c_fingerprint_empty_catalog')}finally{scratch.close()}
  expect(state(target)).toEqual(before)
})

const concurrent=[
  ['process predecessor',processPredecessorSchema,'SELECT source_schema_hash FROM platform_migration_run',"UPDATE platform_migration_run SET source_schema_hash=? WHERE run_id='process'"],
  ['witness predecessor',witnessPredecessorSchema,'SELECT r.source_schema_hash FROM platform_migration_run',"UPDATE platform_migration_run SET source_schema_hash=? WHERE run_id='witness'"],
  ['recognized installed',recognizedStoredInstalled,'SELECT r.run_id FROM platform_migration_run',"UPDATE platform_migration_run SET target_schema_version=? WHERE run_id='recognized'"],
] as const
it.each(concurrent)('standalone %s authenticates and reads one snapshot then rejects the next request after another connection commits',(_name,call,trigger,sql)=>{
  const before=state(target),expected=call(target)
  target.pragma('journal_mode=WAL')
  const writer=new Database(target.name)
  let changed=false
  const reader=new Database(target.name,{verbose:query=>{
    if(!changed&&typeof query==='string'&&query.startsWith(trigger)){writer.prepare(sql).run('f'.repeat(64));changed=true}
  }})
  try{
    expect(call(reader)).toEqual(expected)
    expect(changed).toBe(true)
    expect(()=>call(reader)).toThrow()
  }finally{
    reader.close()
    // Restore all original receipt cells, not just enough metadata to pass.
    const restore=writer.prepare('UPDATE platform_migration_run SET source_snapshot_sha256=@source_snapshot_sha256,source_schema_hash=@source_schema_hash,source_manifest_sha256=@source_manifest_sha256,target_schema_version=@target_schema_version,transform_version=@transform_version,state=@state WHERE run_id=@run_id')
    for(const row of before.runs)restore.run(z.record(z.string(),z.unknown()).parse(row))
    writer.close()
  }
  expect(call(target)).toEqual(expected)
  expect(state(target)).toEqual(before)
})
