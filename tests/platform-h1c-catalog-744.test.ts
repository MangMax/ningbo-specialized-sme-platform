import Database from 'better-sqlite3'
import { copyFileSync, readFileSync, statSync } from 'node:fs'
import { serialize } from 'node:v8'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { processReaderFixture, emptyProcessReaderFixture } from './helpers/process-target-734'
import { authenticateH1cCatalog } from '../lib/platform/h1c-catalog'
import { processStoredInstalled } from '../lib/platform/process-stored-catalog'
import { schemaHash } from '../lib/platform/sqlite-row-cells'
import { projectionManifest } from '../upgrade/projections'

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
type Fixture = Awaited<ReturnType<typeof processReaderFixture>>
let original: Fixture, target: Database.Database

/** Test-owned controlled catalog only; not the C migration implementation. */
function successor(f: Fixture, name='controlled-h1c', changeDdl=(ddl:string)=>ddl) {
  const path = join(f.root, name+'.sqlite')
  copyFileSync(f.target, path)
  const t = new Database(path)
  t.pragma('foreign_keys=ON')
  const table = (name: string) => (t.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name=?").get(name) as {sql:string}).sql
  const ddl = table('record_correspondence').replaceAll('`relation_id`', '`observation_id`').replace('REFERENCES `platform_relation`', 'REFERENCES `platform_business_observation`')
  const audit = table('record_correspondence_audit')
  const indexes = t.prepare("SELECT sql FROM sqlite_schema WHERE type='index' AND tbl_name IN ('record_correspondence','record_correspondence_audit') AND sql IS NOT NULL ORDER BY name").all() as {sql:string}[]
  const sequence = t.prepare("SELECT * FROM sqlite_sequence WHERE name IN ('record_correspondence','record_correspondence_audit') ORDER BY name").all() as {name:string;seq:number}[]
  t.transaction(() => {
    t.exec('CREATE TEMP TABLE saved_edges AS SELECT * FROM record_correspondence; CREATE TEMP TABLE saved_audit AS SELECT * FROM record_correspondence_audit; DROP TABLE record_correspondence_audit; DROP TABLE record_correspondence')
    t.exec(changeDdl(ddl)); t.exec(audit)
    t.exec('INSERT INTO record_correspondence SELECT * FROM saved_edges; INSERT INTO record_correspondence_audit SELECT * FROM saved_audit')
    for (const index of indexes) t.exec(index.sql.replaceAll('`relation_id`', '`observation_id`'))
    t.exec("DELETE FROM sqlite_sequence WHERE name IN ('record_correspondence','record_correspondence_audit')")
    for (const row of sequence) t.prepare('INSERT INTO sqlite_sequence(name,seq) VALUES(?,?)').run(row.name,row.seq)
    t.exec('DROP TABLE saved_edges; DROP TABLE saved_audit')
    t.pragma('user_version=71611')
    const predecessorRun = t.prepare("SELECT * FROM platform_migration_run WHERE run_id='process'").get()
    const predecessorCheckpoints = t.prepare("SELECT * FROM platform_migration_checkpoint WHERE run_id='process' ORDER BY phase,source_table").all()
    const sourceSchemaHash = schemaHash(f.t), targetSchemaHash = schemaHash(t)
    const copiedCount = (t.prepare('SELECT count(*) n FROM record_correspondence').get() as {n:number}).n
    const digest = hash(JSON.stringify({version:1,predecessorRun,predecessorCheckpoints,sourceSchemaHash,targetSchemaHash,copiedCount}))
    t.prepare('INSERT INTO platform_migration_run(run_id,state,source_snapshot_sha256,source_schema_hash,source_manifest_sha256,target_schema_version,transform_version) VALUES(?,?,?,?,?,?,?)').run('h1c','complete',hash(readFileSync(f.target)),sourceSchemaHash,'0'.repeat(64),targetSchemaHash,'h1c-correspondence-observation-v1')
    t.prepare('INSERT INTO platform_migration_checkpoint(run_id,phase,source_table,last_old_id,copied_count,batch_digest) VALUES(?,?,?,?,?,?)').run('h1c','h1c-correspondence-fk','record_correspondence',0,copiedCount,digest)
  }).immediate()
  return t
}

beforeAll(async () => { original = await processReaderFixture(); target = successor(original) })
afterAll(() => { target?.close(); original?.close() })

it('authenticates only the fixed complete successor catalog against the actual accepted populated 71610 catalog', () => {
  expect(processStoredInstalled(original.t)).toBe(true)
  expect(authenticateH1cCatalog(target)).toEqual({kind:'h1c-catalog-binding',predecessorRunId:'process',predecessorSchemaHash:schemaHash(original.t),targetSchemaHash:schemaHash(target)})
  expect(target.pragma('foreign_key_check')).toEqual([])
})

function rebind(t: Database.Database) {
  const prior = t.prepare("SELECT * FROM platform_migration_run WHERE run_id='process'").get() as {target_schema_version:string}
  const predecessorCheckpoints = t.prepare("SELECT * FROM platform_migration_checkpoint WHERE run_id='process' ORDER BY phase,source_table").all()
  const targetSchemaHash = schemaHash(t), sourceSchemaHash = prior.target_schema_version
  const copiedCount = (t.prepare("SELECT copied_count FROM platform_migration_checkpoint WHERE run_id='h1c'").get() as {copied_count:number}).copied_count
  t.prepare("UPDATE platform_migration_run SET target_schema_version=?,source_schema_hash=? WHERE run_id='h1c'").run(targetSchemaHash,sourceSchemaHash)
  t.prepare("UPDATE platform_migration_checkpoint SET batch_digest=? WHERE run_id='h1c'").run(hash(JSON.stringify({version:1,predecessorRun:prior,predecessorCheckpoints,sourceSchemaHash,targetSchemaHash,copiedCount})))
}
it('rejects unrelated schema changes even with mutually forged predecessor and successor hash receipts', () => {
  target.exec('BEGIN')
  try {
    target.exec('CREATE INDEX forged_unrelated ON enterprise(name)')
    // Derive the would-be predecessor hash independently from the real predecessor.
    original.t.exec('BEGIN')
    try {
      original.t.exec('CREATE INDEX forged_unrelated ON enterprise(name)')
      target.prepare("UPDATE platform_migration_run SET target_schema_version=? WHERE run_id='process'").run(schemaHash(original.t))
    } finally { original.t.exec('ROLLBACK') }
    rebind(target)
    expect(() => authenticateH1cCatalog(target)).toThrow()
  } finally { target.exec('ROLLBACK') }
})

function receiptCells(t: Database.Database, historical=false) {
  return ['platform_migration_run','platform_migration_checkpoint'].map(table=>{
    const columns=t.pragma(`table_info(${table})`) as {name:string}[]
    return t.prepare(`SELECT ${columns.flatMap((c,i)=>[`typeof("${c.name}") k${i}`,`hex(cast("${c.name}" AS BLOB)) b${i}`]).join(',')} FROM ${table} ${historical?"WHERE run_id<>'h1c'":''} ORDER BY run_id${table.endsWith('checkpoint')?',phase,source_table':''}`).all()
  })
}
function state(t:Database.Database) {
  return {catalog:schemaHash(t),facts:projectionManifest(t),receipts:receiptCells(t),sequence:t.prepare('SELECT * FROM sqlite_sequence ORDER BY name').all(),changes:t.prepare('SELECT total_changes() n').get(),phase:t.pragma('user_version',{simple:true})}
}
it('authenticates the independently migrated empty predecessor catalog without touching facts or original receipt bytes', async()=>{
  const f=await emptyProcessReaderFixture(), t=successor(f)
  try {
    expect(schemaHash(f.t)).toBe('a9af200fe3a21866bf65d9138b9b01be6738fb681f9e2bc512cd2bfa700d2776')
    const before=state(t), source=state(f.t)
    expect(authenticateH1cCatalog(t).predecessorSchemaHash).toBe(schemaHash(f.t))
    expect(receiptCells(t,true)).toEqual(receiptCells(f.t))
    expect(state(t)).toEqual(before);expect(state(f.t)).toEqual(source)
  }finally{t.close();f.close()}
})
it('preserves populated facts sequences and every historical receipt cell during repeated read-only authentication',()=>{
  const before=state(target), source=state(original.t)
  expect(receiptCells(target,true)).toEqual(receiptCells(original.t))
  authenticateH1cCatalog(target);authenticateH1cCatalog(target)
  expect(state(target)).toEqual(before);expect(state(original.t)).toEqual(source)
})
it('authenticates a readonly disk connection without changing either file or its receipt bytes',()=>{
  const before=readFileSync(target.name), source=readFileSync(original.target)
  const readonly=new Database(target.name,{readonly:true})
  try{expect(authenticateH1cCatalog(readonly).predecessorRunId).toBe('process')}finally{readonly.close()}
  expect(readFileSync(target.name)).toEqual(before);expect(readFileSync(original.target)).toEqual(source)
})

const badCatalogs = [
  ['extra unrelated index', 'CREATE INDEX unexpected_enterprise_idx ON enterprise(name)'],
  ['extra unrelated column', 'ALTER TABLE enterprise ADD COLUMN unexpected TEXT'],
  ['extra unrelated trigger', 'CREATE TRIGGER unexpected_enterprise_trigger AFTER INSERT ON enterprise BEGIN SELECT 1; END'],
  ['missing audit incoming owner', 'DROP TABLE record_correspondence_audit'],
  ['missing edge unique index', 'DROP INDEX record_correspondence_edge_uq'],
  ['weakened process barrier', 'DROP TRIGGER platform_process_stored_no_update'],
  ['extra correspondence check column', 'ALTER TABLE record_correspondence ADD COLUMN unexpected INTEGER CHECK(unexpected=0)'],
] as const
it.each(badCatalogs)('rejects %s even after rebinding the successor catalog hash',(_name,sql)=>{
  target.exec('BEGIN')
  try {
    target.exec(sql);rebind(target)
    const before=state(target)
    expect(()=>authenticateH1cCatalog(target)).toThrow()
    expect(state(target)).toEqual(before)
  }finally{target.exec('ROLLBACK')}
  expect(authenticateH1cCatalog(target).kind).toBe('h1c-catalog-binding')
})

const badBindings = [
  ['missing successor run', "DELETE FROM platform_migration_checkpoint WHERE run_id='h1c'; DELETE FROM platform_migration_run WHERE run_id='h1c'"],
  ['unfinished successor', "UPDATE platform_migration_run SET state='running' WHERE run_id='h1c'"],
  ['wrong transform', "UPDATE platform_migration_run SET transform_version='h1c-forged' WHERE run_id='h1c'"],
  ['wrong actual catalog hash', "UPDATE platform_migration_run SET target_schema_version='"+'f'.repeat(64)+"' WHERE run_id='h1c'"],
  ['wrong predecessor hash', "UPDATE platform_migration_run SET source_schema_hash='"+'f'.repeat(64)+"' WHERE run_id='h1c'"],
  ['missing successor checkpoint', "DELETE FROM platform_migration_checkpoint WHERE run_id='h1c'"],
  ['wrong checkpoint phase', "UPDATE platform_migration_checkpoint SET phase='forged' WHERE run_id='h1c'"],
  ['wrong checkpoint owner', "UPDATE platform_migration_checkpoint SET source_table='enterprise' WHERE run_id='h1c'"],
  ['wrong checkpoint position', "UPDATE platform_migration_checkpoint SET last_old_id=1 WHERE run_id='h1c'"],
  ['wrong checkpoint count', "UPDATE platform_migration_checkpoint SET copied_count=99 WHERE run_id='h1c'"],
  ['wrong binding digest', "UPDATE platform_migration_checkpoint SET batch_digest='"+'f'.repeat(64)+"' WHERE run_id='h1c'"],
  ['changed predecessor receipt bytes', "UPDATE platform_migration_run SET source_snapshot_sha256='"+'f'.repeat(64)+"' WHERE run_id='process'"],
  ['wrong predecessor run identity', "UPDATE platform_migration_run SET run_id='forged-process' WHERE run_id='process'"],
  ['changed predecessor checkpoint bytes', "UPDATE platform_migration_checkpoint SET copied_count=99 WHERE run_id='process'"],
  ['missing process completion', "DELETE FROM platform_migration_checkpoint WHERE run_id='process'"],
] as const
it.each(badBindings)('rejects %s without writes or stale successful-authentication caching',(_name,sql)=>{
  authenticateH1cCatalog(target)
  target.exec('BEGIN')
  try {
    if(_name==='wrong predecessor run identity')target.pragma('defer_foreign_keys=ON')
    target.exec(sql)
    const before=state(target)
    expect(()=>authenticateH1cCatalog(target)).toThrow()
    expect(state(target)).toEqual(before)
  }finally{target.exec('ROLLBACK')}
})
it.each([0,71605,71606,71607,71608,71609,71610,71612])('does not accept phase %i as the fixed H1c catalog',phase=>{
  target.exec('BEGIN')
  try{target.pragma(`user_version=${phase}`);const before=state(target);expect(()=>authenticateH1cCatalog(target)).toThrow();expect(state(target)).toEqual(before)}finally{target.exec('ROLLBACK')}
})
it('rejects marker-only and an unchanged relation FK instead of accepting an incomplete successor catalog',()=>{
  original.t.exec('BEGIN')
  try{original.t.pragma('user_version=71611');expect(()=>authenticateH1cCatalog(original.t)).toThrow()}finally{original.t.exec('ROLLBACK')}
  const wrong=successor(original,'wrong-fk',ddl=>ddl.replace('REFERENCES `platform_business_observation`','REFERENCES `platform_relation`'))
  try{const before=state(wrong);expect(()=>authenticateH1cCatalog(wrong)).toThrow();expect(state(wrong)).toEqual(before)}finally{wrong.close()}
})
it('rejects duplicate successor or predecessor receipts and extra checkpoints',()=>{
  for(const sql of [
    "INSERT INTO platform_migration_run SELECT 'duplicate',source_snapshot_sha256,source_schema_hash,source_manifest_sha256,target_schema_version,transform_version,state FROM platform_migration_run WHERE run_id='h1c'",
    "INSERT INTO platform_migration_run SELECT 'duplicate',source_snapshot_sha256,source_schema_hash,source_manifest_sha256,target_schema_version,transform_version,state FROM platform_migration_run WHERE run_id='process'",
    "INSERT INTO platform_migration_checkpoint SELECT run_id,'extra',source_table,last_old_id,copied_count,batch_digest FROM platform_migration_checkpoint WHERE run_id='h1c'",
    "INSERT INTO platform_migration_checkpoint SELECT run_id,'extra',source_table,last_old_id,copied_count,batch_digest FROM platform_migration_checkpoint WHERE run_id='process'",
  ]){
    target.exec('BEGIN')
    try{target.exec(sql);const before=state(target);expect(()=>authenticateH1cCatalog(target)).toThrow();expect(state(target)).toEqual(before)}finally{target.exec('ROLLBACK')}
  }
})
it('still rejects a forged predecessor witness binding even after recomputing the successor digest',()=>{
  target.exec('BEGIN')
  try{
    target.prepare("UPDATE platform_migration_run SET source_schema_hash=? WHERE run_id='process'").run('f'.repeat(64))
    rebind(target)
    expect(()=>authenticateH1cCatalog(target)).toThrow()
  }finally{target.exec('ROLLBACK')}
})

it('leaves 71610 behavior and all unconnected 71611 consumers fail closed',async()=>{
  const {capturePhase}=await import('../lib/platform/fingerprint-capture')
  const {getTargetBusinessProcess}=await import('../server/utils/platform-business-processes-target')
  expect(processStoredInstalled(original.t)).toBe(true)
  expect(capturePhase(original.db,true)).toBe(true)
  expect(getTargetBusinessProcess(original.db,1).observations.length).toBeGreaterThan(0)
  expect(()=>processStoredInstalled(target)).toThrow('process_stored_phase_or_receipt')
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
        worker.postMessage({dbPath:path,id:'h1c-guard',identity,readonly:false,action:'preflight',payload:serialize({}),operation:'list',filter:{},title:'specialized_sme',temporaryPath:join(original.root,'never.xlsx'),jobId:'h1c-guard'})
      })
      if(kind==='import')expect(result).toMatchObject({type:'failure',error:{message:expect.stringMatching(/finalized/i)}})
      if(kind==='export')expect(result).toEqual({type:'failure',message:'当前名录导出执行失败；请核对数据或资源限制后重新提交'})
      if(kind==='read')expect(result).toMatchObject({type:'failure',code:'enterprise_read_failed'})
    }finally{await worker.terminate()}
  }
  expect(readFileSync(path)).toEqual(before)
},30000)
