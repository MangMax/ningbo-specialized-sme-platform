import { withArchiveProcessFacts, type PlatformObservationFact } from "../../../lib/platform/observation-facts"

import { platformRowTitle } from "../../../lib/platform/row-title"

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as schema from '../../../upgrade/legacy-schema'
import { writeOwnerArchive, sealArchiveOwner } from '../../../upgrade/frozen/immutable-archive'
import { ensurePlatformObservation } from '../../../upgrade/frozen/server/platform-business-record'
import { normalizePlatformRelation } from '../../../lib/platform/normalization'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'

it('keeps version writers and permits a separate observation owner for each source', () => {
  const s = new Database(':memory:'); s.pragma('foreign_keys=ON')
  try {
    migrate(drizzle(s), { migrationsFolder: resolve('db/migrations') })
    for (const [i, source] of ['apply','business','recognized'].entries()) {
      const id = i + 1
      s.prepare(`INSERT INTO platform_business_record(id,interface,platform_key,identity_rule_version,created_at) VALUES(?,?,?,'old','old')`).run(id, source + '_list', source)
      s.prepare(`INSERT INTO platform_business_record_version(id,record_id,hash_algorithm,content_hash,canonical_raw_json,created_at) VALUES(?,?,'old','hash','{}','old')`).run(id,id)
      s.prepare(`INSERT INTO platform_${source}_projection(version_id,record_id,rule_version,created_at) VALUES(?,?,'old','old')`).run(id,id)
      expect(s.prepare(`SELECT id,version_id,observation_id,basis FROM platform_${source}_projection`).get()).toEqual({ id: 1, version_id: id, observation_id: null, basis: 'verified_raw' })
    }
  } finally { s.close() }
})

// Frozen SQL fixtures are an independent schema seam, not a new business writer.
const sources = ['apply', 'business', 'recognized'] as const
const whitelist = ['province','status','batch','declare_kind','applied_at','award_batch_label','year']
function fixture(pre = false) {
  const s = new Database(':memory:'); s.pragma('foreign_keys=ON')
  let folder = resolve('db/migrations')
  if (pre) {
    folder = mkdtempSync(join(tmpdir(), 't03b-pre-'))
    cpSync(resolve('db/migrations'), folder, { recursive: true })
    const journal = JSON.parse(readFileSync(join(folder,'meta/_journal.json'),'utf8'))
    journal.entries = journal.entries.filter((e: { idx: number }) => e.idx < 50)
    writeFileSync(join(folder,'meta/_journal.json'),JSON.stringify(journal))
  }
  const db = drizzle(s, { schema }); migrate(db, { migrationsFolder: folder })
  sources.forEach((src,i) => {
    const id=i+1
    s.prepare(`INSERT INTO platform_query(id,interface,query_key,rdjb,queried_at,status,created_at) VALUES(?,?,?,'2,3','old','success','old')`).run(id,src+'_list',src)
    db.insert(schema.platformCollection).values({ id, interface: src==='apply'?'apply_list':src==='business'?'business_list':'recognized_list', queryKey: src, rdjb: '2,3', queriedAt: 'old', createdAt: 'old', status: 'success', completeness:'unknown', provenanceState:'unknown', parseState:'absent',ruleVersion:'old' }).run()
    s.prepare(`INSERT INTO platform_business_record(id,interface,platform_key,identity_rule_version,created_at) VALUES(?,?,?,'old','old')`).run(id,src+'_list',src)
    s.prepare(`INSERT INTO platform_business_record_version(id,record_id,hash_algorithm,content_hash,canonical_raw_json,created_at) VALUES(?,?,'old','hash','{"cszt":"终审通过"}','old')`).run(id,id)
    s.prepare(`INSERT INTO platform_${src}_projection(version_id,record_id,rule_version,created_at) VALUES(?,?,'old','old')`).run(id,id)
    for(let j=0;j<3;j++) {
      const obs=id*10+j
      s.prepare(`INSERT INTO platform_relation(id,query_id,sequence_no,relation_key,raw_fields,created_at) VALUES(?,?,?,' A ','{"cszt":"终审通过"}','old')`).run(obs,id,j+1)
      s.prepare(`INSERT INTO platform_business_observation(relation_id,id,collection_id,sequence_no,position_state,record_id,version_id,identity_state,content_state,key_source,projection_rule_version,input_fingerprint,indexed_at) VALUES(?,?,?,?,'unknown',?,?,?,?, 'both','old','old-input','old')`).run(obs,obs,id,j+1,j<2?id:null,j<2?id:null,j<2?'resolved':'missing_key',j<2?'verified':'unverifiable')
      writeOwnerArchive(db,{ kind:'observation',ownerId:obs,field:'rawFields' },{ storageClass:'text',bytes:Buffer.from('{"cszt":"终审通过"}'),createdAt:'old' })
      sealArchiveOwner(db,{kind:'observation',ownerId:obs})
    }
    writeOwnerArchive(db,{ kind:'version',ownerId:id,field:'canonicalRawJson' },{ storageClass:'text',bytes:Buffer.from('{"cszt":"终审通过"}'),createdAt:'old' })
    sealArchiveOwner(db,{kind:'version',ownerId:id})
  })
  return { s, db, close() { s.close(); if(pre) rmSync(folder,{recursive:true,force:true}) } }
}
function observation(s: Database.Database, src: string, id: number, changes: Record<string, unknown> = {}) {
  const archive = s.prepare('SELECT archive_id FROM platform_observation_archive_ref WHERE owner_id=? AND field=\'rawFields\'').get(id) as {archive_id:number}
  const row: Record<string, unknown> = { observation_id:id, basis:'observation_reconciliation',source_title_kind:'absent',source_title_rule_version:'old-sql-js-v1',source_archive_id:archive.archive_id,parse_state:'valid',rule_version:'fixture',created_at:'old' }
  for(const field of whitelist) Object.assign(row,{['stored_'+field+'_kind']:'absent',['parsed_'+field+'_kind']:'absent',[field+'_conflict']:0})
  Object.assign(row,changes)
  const cols=Object.keys(row)
  s.prepare(`INSERT INTO platform_${src}_projection(${cols.join(',')}) VALUES(${cols.map(()=>'?').join(',')})`).run(...Object.values(row))
}
function catalog(s: Database.Database) { return s.prepare("SELECT type,name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all() }

it('upgrades populated 0049 to the fresh schema preserving all old facts and T02 bindings without observation inventions', () => {
  const f=fixture(true), fresh=fixture()
  try {
    const tables=['platform_query','platform_relation','platform_business_observation','platform_business_record','platform_business_record_version',...sources.map(x=>'platform_'+x+'_projection'),'platform_archive_value','platform_observation_archive_ref','platform_version_archive_ref']
    const before=tables.map(t=>f.s.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all())
    migrate(f.db,{migrationsFolder:resolve('db/migrations')})
    expect(catalog(f.s)).toEqual(catalog(fresh.s))
    tables.forEach((t,i)=>{
      const after=f.s.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()
      before[i]!.forEach((row,j)=>expect(after[j]).toMatchObject(row as object))
      expect(after).toHaveLength(before[i]!.length)
    })
    sources.forEach(src=>expect(f.s.prepare(`SELECT count(*) n FROM platform_${src}_projection WHERE observation_id IS NOT NULL`).get()).toEqual({n:0}))
    expect(f.s.pragma('foreign_key_check')).toEqual([])
    expect(f.s.pragma('integrity_check')).toEqual([{integrity_check:'ok'}])
    // Exercise the actual unchanged production writer after upgrade (separate regression file also tests replay).
    f.s.exec(`INSERT INTO platform_relation(id,query_id,sequence_no,relation_key,raw_fields,created_at) VALUES(99,1,99,'new','{"id":"new","year":2026}','old')`)
    expect(ensurePlatformObservation(f.db,99).versionCreated).toBe(true)
  } finally { f.close(); fresh.close() }
})

it.each(sources)('%s keeps shared verified status separate from per observation conflict and raw only facts', src=>{
  const f=fixture(); const id=(sources.indexOf(src)+1)*10
  try {
    const process=src!=='recognized'
    observation(f.s,src,id,{stored_status_kind:'text',stored_status:'退回',parsed_status_kind:process?'text':'absent',parsed_status:process?'终审通过':null,reconciled_status:process?null:'退回',status_conflict:process?1:0})
    observation(f.s,src,id+1,{stored_status_kind:'text',stored_status:'终审通过',parsed_status_kind:process?'text':'absent',parsed_status:process?'终审通过':null,reconciled_status:'终审通过'})
    observation(f.s,src,id+2,process?{parsed_status_kind:'text',parsed_status:'终审通过',reconciled_status:'终审通过'}:{stored_status_kind:'text',stored_status:'终审通过',reconciled_status:'终审通过'})
    expect(f.s.prepare(`SELECT version_id,stored_status,parsed_status,reconciled_status,status_conflict FROM platform_${src}_projection WHERE observation_id IS NOT NULL ORDER BY observation_id`).all()).toEqual([
      {version_id:null,stored_status:'退回',parsed_status:process?'终审通过':null,reconciled_status:process?null:'退回',status_conflict:process?1:0},
      {version_id:null,stored_status:'终审通过',parsed_status:process?'终审通过':null,reconciled_status:'终审通过',status_conflict:0},
      {version_id:null,stored_status:process?null:'终审通过',parsed_status:process?'终审通过':null,reconciled_status:'终审通过',status_conflict:0},
    ])
    // SQL literal old normalization oracle; recognized never runs process parser.
    expect(normalizePlatformRelation(src+'_list',{status:'退回',rawFields:{cszt:'终审通过'}}).normalizationConflicts.map(x=>x.field)).toEqual(process?['status']:[])
  } finally {f.close()}
})

it.each(sources)('%s rejects mixed missing duplicate cross source and mismatched version archive owners', src=>{
  const f=fixture(); const n=sources.indexOf(src)+1,id=n*10, table='platform_'+src+'_projection'
  try {
    for(const change of [{version_id:n,record_id:n},{record_id:n},{basis:'verified_raw'},{source_title_kind:null},{source_archive_id:999},{source_archive_id:2},{stored_status_kind:'nonsense'},{stored_status_kind:'text',stored_status:Buffer.from('x')},{status_conflict:1}]) expect(()=>observation(f.s,src,id,change)).toThrow()
    const other=n===1?2:1
    expect(()=>observation(f.s,src,other*10)).toThrow()
    expect(()=>f.s.prepare(`INSERT INTO ${table}(version_id,record_id,rule_version,created_at) VALUES(?,?,'old','old')`).run(other,other)).toThrow()
    expect(()=>f.s.prepare(`INSERT INTO ${table}(version_id,record_id,rule_version,created_at) VALUES(?,?,'old','old')`).run(n,other)).toThrow()
    observation(f.s,src,id)
    expect(()=>observation(f.s,src,id)).toThrow()
    expect(()=>f.s.prepare(`UPDATE platform_collection SET interface=? WHERE id=?`).run(sources[other-1]+'_list',n)).toThrow()
    expect(()=>f.s.prepare(`UPDATE platform_business_observation SET collection_id=? WHERE relation_id=?`).run(other,id)).toThrow()
    expect(()=>f.s.prepare(`UPDATE platform_business_record SET interface=? WHERE id=?`).run(sources[other-1]+'_list',n)).toThrow()
    const a=f.s.prepare("SELECT archive_id FROM platform_version_archive_ref WHERE owner_id=?").get(n) as {archive_id:number}
    f.s.prepare('UPDATE platform_business_record_version SET canonical_archive_id=? WHERE id=?').run(a.archive_id,n)
    expect(()=>f.s.prepare('UPDATE platform_business_record_version SET canonical_archive_id=? WHERE id=?').run(a.archive_id,other)).toThrow()
    expect(()=>f.s.prepare('DELETE FROM platform_business_observation WHERE relation_id=?').run(id)).toThrow()
  }finally{f.close()}
})

it.each(sources)('%s preserves all title kinds and literal SQL versus JS membership expectations', src=>{
  const f=fixture(),id=(sources.indexOf(src)+1)*10
  try {
    observation(f.s,src,id)
    const cases = [
      {kind:'absent', text:null, number:null, bool:null, raw:undefined, sql:null, js:''},
      {kind:'null', text:null, number:null, bool:null, raw:null, sql:null, js:''},
      {kind:'text', text:' 2 ', number:null, bool:null, raw:' 2 ', sql:' 2 ', js:''},
      {kind:'text', text:'', number:null, bool:null, raw:'', sql:'', js:''},
      {kind:'number', text:null, number:'2', bool:null, raw:2, sql:2, js:'2'},
      {kind:'boolean', text:null, number:null, bool:1, raw:true, sql:1, js:''},
      {kind:'boolean', text:null, number:null, bool:0, raw:false, sql:0, js:''},
      {kind:'array', text:null, number:null, bool:null, raw:[], sql:'[]', js:''},
      {kind:'object', text:null, number:null, bool:null, raw:{}, sql:'{}', js:''},
    ]
    for(const c of cases) {
      f.s.prepare(`UPDATE platform_${src}_projection SET source_title_kind=?,source_title_text=?,source_title_number_text=?,source_title_boolean=? WHERE observation_id=?`).run(c.kind,c.text,c.number,c.bool,id)
      expect(f.s.prepare(`SELECT source_title_kind,source_title_text,source_title_number_text,source_title_boolean,typeof(source_title_boolean) storage FROM platform_${src}_projection WHERE observation_id=?`).get(id)).toEqual({source_title_kind:c.kind,source_title_text:c.text,source_title_number_text:c.number,source_title_boolean:c.bool,storage:c.bool===null?'null':'integer'})
      const raw=c.raw===undefined?{}:{rdjb:c.raw}
      expect(f.s.prepare("SELECT json_extract(?, '$.rdjb') value").get(JSON.stringify(raw))).toEqual({value:c.sql})
      expect(platformRowTitle(c.kind==='boolean'?'1,2':'2,3',raw)).toBe(c.js)
      if(c.kind==='boolean') expect(f.s.prepare("SELECT cast(json_extract(?, '$.rdjb') AS text) IN ('1','2') hit").get(JSON.stringify(raw))).toEqual({hit:c.bool})
    }
    for(const change of ["source_title_kind='unknown'","source_title_kind='text',source_title_text=NULL","source_title_kind='boolean',source_title_boolean=NULL","source_title_kind='boolean',source_title_boolean=2","source_title_kind='number',source_title_number_text=''","source_title_kind='number',source_title_number_text=' 2 '","source_title_kind='number',source_title_number_text='null'","source_title_kind='text',source_title_text=x'32'"]) expect(()=>f.s.exec(`UPDATE platform_${src}_projection SET source_title_text=NULL,source_title_number_text=NULL,source_title_boolean=NULL,${change} WHERE observation_id=${id}`)).toThrow()
    // Explicit invalid parse keeps original archive, with unknown facts, not invented values.
    f.s.prepare(`UPDATE platform_${src}_projection SET source_title_kind='invalid',parse_state='invalid',basis='unavailable' WHERE observation_id=?`).run(id)
  }finally{f.close()}
})

it.each(sources)('%s enforces reconciliation whitelist storage classes safe integer boundaries and whole transaction rollback',src=>{
  const f=fixture(),id=(sources.indexOf(src)+1)*10,table='platform_'+src+'_projection'
  try {
    observation(f.s,src,id,{stored_year_kind:'number',stored_year:9007199254740991,reconciled_year:9007199254740991})
    for(const value of [9007199254740992,-9007199254740992,1.5,'',Buffer.from('1')]) expect(()=>f.s.prepare(`UPDATE ${table} SET stored_year=?,reconciled_year=? WHERE observation_id=?`).run(value,value,id)).toThrow()
    for(const field of whitelist) {
      expect(()=>f.s.exec(`UPDATE ${table} SET ${field}_conflict=2 WHERE observation_id=${id}`)).toThrow()
      expect(()=>f.s.exec(`UPDATE ${table} SET reconciled_${field}=${field==='year'?'42':"'invented'"} WHERE observation_id=${id}`)).toThrow()
    }
    const before=f.s.prepare(`SELECT * FROM ${table}`).all()
    expect(()=>f.s.transaction(()=>{
      f.s.exec(`UPDATE ${table} SET title_raw='temporary' WHERE observation_id=${id}`)
      observation(f.s,src,id+1,{status_conflict:1})
    })()).toThrow()
    expect(f.s.prepare(`SELECT * FROM ${table}`).all()).toEqual(before)
  }finally{f.close()}
})

it('preserves recognized uncaptured false empty and whitespace fidelity without confusing old year with maintenance year',()=>{
  const f=fixture()
  try {
    observation(f.s,'recognized',30,{source_maintenance_year_absent:null,source_validity_date:null,source_maintenance_batch:null,stored_year_kind:'number',stored_year:2025,reconciled_year:2025,maintenance_year:2028})
    observation(f.s,'recognized',31,{source_maintenance_year_absent:0,source_validity_date:' ',source_maintenance_batch:''})
    observation(f.s,'recognized',32,{source_maintenance_year_absent:1,source_validity_date:'',source_maintenance_batch:' '})
    expect(f.s.prepare(`SELECT source_maintenance_year_absent,source_validity_date,source_maintenance_batch,stored_year,maintenance_year FROM platform_recognized_projection WHERE observation_id IS NOT NULL ORDER BY observation_id`).all()).toEqual([
      {source_maintenance_year_absent:null,source_validity_date:null,source_maintenance_batch:null,stored_year:2025,maintenance_year:2028},
      {source_maintenance_year_absent:0,source_validity_date:' ',source_maintenance_batch:'',stored_year:null,maintenance_year:null},
      {source_maintenance_year_absent:1,source_validity_date:'',source_maintenance_batch:' ',stored_year:null,maintenance_year:null},
    ])
    expect(()=>f.s.exec(`UPDATE platform_recognized_projection SET source_maintenance_year_absent=2 WHERE observation_id=30`)).toThrow()
    expect(()=>f.s.exec(`UPDATE platform_recognized_projection SET parsed_year_kind='number',parsed_year=2025 WHERE observation_id=30`)).toThrow()
  }finally{f.close()}
})

it('rolls back every required schema statement if a late migration step fails',()=>{
 const f=fixture(true)
 try {
   const before=catalog(f.s),facts=f.s.prepare('SELECT * FROM platform_apply_projection').all()
   const statements=readFileSync(resolve('db/migrations/0050_source_projection_observation.sql'),'utf8').split('--> statement-breakpoint')
   expect(()=>f.s.transaction(()=>{for(const stmt of statements) if(stmt.trim()) f.s.exec(stmt); f.s.exec('SELECT deliberate_missing_schema_step')})()).toThrow()
   expect(catalog(f.s)).toEqual(before)
   expect(f.s.prepare('SELECT * FROM platform_apply_projection').all()).toEqual(facts)
   migrate(f.db,{migrationsFolder:resolve('db/migrations')})
   expect(f.s.pragma('foreign_key_check')).toEqual([])
 }finally{f.close()}
})

it('keeps archive supplementation within modeled nonnull version fields and never masks observation conflicts',()=>{
  const normalized=normalizePlatformRelation('business_list',{status:' 退回 ',year:2025,rawFields:{cszt:'终审通过',year:2025}})
  const fact: PlatformObservationFact={relationId:1,interface:'business_list',projectionVersionId:1,projectionRuleVersion:'old',modeledFields:['status','year'],declareKind:null,year:2025,appliedAt:null,status:'终审通过',batch:'source-only',awardBatchLabel:null,province:null,nameRaw:null,usccRaw:null,validityDateRaw:null,maintenanceYear:null,maintenanceBatch:null,district:null,awardNote:null,titleRaw:null,normalizationConflicts:normalized.normalizationConflicts}
  expect(withArchiveProcessFacts(fact,normalized).archiveProcessFacts).toEqual({province:null,status:null,batch:null,declareKind:null,appliedAt:null,awardBatchLabel:null,year:2025})
  expect(withArchiveProcessFacts({...fact,projectionVersionId:null}, {status:'仅存储'}).archiveProcessFacts?.status).toBe('仅存储')
  expect(withArchiveProcessFacts({...fact,status:null,normalizationConflicts:[]}, {status:'仅存储'}).archiveProcessFacts?.status).toBe('仅存储')
})

it.each(sources)('%s rejects unsafe owner ids and parent replacement without weakening FK ownership',src=>{
  const f=fixture(),n=sources.indexOf(src)+1,id=n*10
  try {
    observation(f.s,src,id)
    for(const col of ['id','observation_id','version_id','record_id','source_archive_id']) for(const value of [0,-1,9007199254740992,1.5,'',Buffer.from('1')]) expect(()=>f.s.prepare(`UPDATE platform_${src}_projection SET ${col}=? WHERE observation_id=?`).run(value,id)).toThrow()
    for(const recursive of [0,1]) {
      f.s.pragma(`recursive_triggers=${recursive}`)
      expect(()=>f.s.prepare(`INSERT OR REPLACE INTO platform_collection(id,interface,query_key,rdjb,queried_at,created_at,status,completeness,provenance_state,parse_state,rule_version) VALUES(?,'wrong','other','2','old','old','success','unknown','unknown','absent','old')`).run(n)).toThrow()
    }
    const versionArchive=f.s.prepare('SELECT archive_id FROM platform_version_archive_ref WHERE owner_id=?').get(n) as {archive_id:number}
    f.s.prepare('UPDATE platform_business_record_version SET canonical_archive_id=? WHERE id=?').run(versionArchive.archive_id,n)
    expect(()=>f.s.prepare('UPDATE platform_business_record_version SET canonical_archive_id=NULL WHERE id=?').run(n)).toThrow()
  }finally{f.close()}
})
