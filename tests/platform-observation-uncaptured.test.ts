import * as schema from '../upgrade/legacy-schema'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bindLegacyAlias, writeOwnerArchive, sealArchiveOwner } from '../upgrade/frozen/immutable-archive'
import { ensurePlatformObservation } from '../upgrade/frozen/server/platform-business-record'
import { readPlatformBusinessMetadata } from '../upgrade/frozen/server/platform-business-record-read'

import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'

it('stores not_indexed with explicitly uncaptured facts instead of a parser result', () => {
  const s = new Database(':memory:'); s.pragma('foreign_keys=ON')
  try {
    migrate(drizzle(s), { migrationsFolder: resolve('db/migrations') })
    s.exec(`INSERT INTO platform_query(id,interface,query_key,rdjb,queried_at,status,created_at) VALUES(1,'business_list','fixture','2','original','success','original');
      INSERT INTO platform_relation(id,query_id,sequence_no,created_at) VALUES(1,1,1,'original');
      INSERT INTO platform_business_observation(relation_id,identity_state,content_state) VALUES(1,'not_indexed','not_indexed')`)
    expect(s.prepare('SELECT record_id,version_id,key_source,projection_rule_version,input_fingerprint,indexed_at FROM platform_business_observation').get()).toEqual({record_id:null,version_id:null,key_source:null,projection_rule_version:null,input_fingerprint:null,indexed_at:null})
  } finally { s.close() }
})

const sources = ['apply', 'business', 'recognized'] as const
function fixture(pre = false) {
  const root = mkdtempSync(join(tmpdir(), '714-'))
  cpSync(resolve('db/migrations'), root, { recursive: true })
  const journal = JSON.parse(readFileSync(join(root, 'meta/_journal.json'), 'utf8'))
  journal.entries = journal.entries.filter((e: {idx:number}) => !pre || e.idx <= 51)
  writeFileSync(join(root, 'meta/_journal.json'), JSON.stringify(journal))
  const s = new Database(join(root, 'fixture.sqlite')); s.pragma('foreign_keys=ON')
  const db = drizzle(s, {schema}); migrate(db, {migrationsFolder:root})
  for (const [i,src] of sources.entries()) {
    const id=i+1
    s.prepare(`INSERT INTO platform_query(id,interface,query_key,rdjb,queried_at,status,created_at) VALUES(?,?,?,'2','original','success','original')`).run(id,src+'_list',src)
    db.insert(schema.platformCollection).values({id,interface:src==='apply'?'apply_list':src==='business'?'business_list':'recognized_list',queryKey:src,rdjb:'2',queriedAt:'original',createdAt:'original',status:'success',completeness:'unknown',provenanceState:'unknown',parseState:'absent',ruleVersion:'fixture'}).run()
    db.insert(schema.platformCollectionPage).values({id,collectionId:id,ordinal:0,positionState:'unknown'}).run()
    s.prepare(`INSERT INTO platform_relation(id,query_id,sequence_no,relation_key,raw_fields,created_at) VALUES(?,?,1,'K',' {"id":"K"} ','original')`).run(id,id)
    s.prepare(`INSERT INTO platform_business_record(id,interface,platform_key,identity_rule_version,created_at) VALUES(?,?,'K','old','original')`).run(id,src+'_list')
    s.prepare(`INSERT INTO platform_business_record_version(id,record_id,hash_algorithm,content_hash,canonical_raw_json,created_at) VALUES(?,?,'old-algorithm','old-hash',' {"id":"K"} ','original')`).run(id,id)
    s.prepare(`INSERT INTO platform_business_observation(relation_id,id,collection_id,sequence_no,page_id,position_state,source_relation_key,record_id,version_id,identity_state,content_state,key_source,projection_rule_version,input_fingerprint,indexed_at) VALUES(?,?,?,1,?,'unknown',' K ',?,?,'resolved','verified','both','old-rule','old-fingerprint','original')`).run(id,id,id,id,id,id)
    bindLegacyAlias(db,{kind:'query',oldId:id,collectionId:id});bindLegacyAlias(db,{kind:'relation',oldId:id,observationId:id})
    const a=writeOwnerArchive(db,{kind:'observation',ownerId:id,field:'rawFields'},{storageClass:'blob',bytes:Buffer.from([0,255,32]),createdAt:null})
    sealArchiveOwner(db,{kind:'observation',ownerId:id})
    const v=writeOwnerArchive(db,{kind:'version',ownerId:id,field:'canonicalRawJson'},{storageClass:'text',bytes:Buffer.from(' {"id":"K"} '),createdAt:null})
    sealArchiveOwner(db,{kind:'version',ownerId:id})
    s.prepare('UPDATE platform_business_record_version SET canonical_archive_id=? WHERE id=?').run(v,id)
    db.insert(schema.platformObservationAssignment).values({observationId:id,revision:1,matchBasis:'none',verificationStatus:'pending',origin:'migrated_current',nameRaw:' 原名 '}).run()
    s.prepare(`INSERT INTO platform_${src}_projection(version_id,record_id,rule_version,created_at) VALUES(?,?,'old','original')`).run(id,id)
    const extra=['province','status','batch','declare_kind','applied_at','award_batch_label','year'].flatMap(field=>['stored_'+field+'_kind','parsed_'+field+'_kind',field+'_conflict'])
    const values=['province','status','batch','declare_kind','applied_at','award_batch_label','year'].flatMap(()=>['absent','absent',0])
    s.prepare(`INSERT INTO platform_${src}_projection(observation_id,basis,source_title_kind,source_title_rule_version,source_archive_id,parse_state,rule_version,created_at,${extra.join(',')}) VALUES(?,'unavailable','invalid','old',?,'invalid','old','original',${values.map(()=>'?').join(',')})`).run(id,a,...values)
  }
  return {s,db,root, close(){s.close()}}
}
function catalog(s: Database.Database) {return s.prepare("SELECT type,name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all()}
const tables=['platform_query','platform_relation','platform_business_record','platform_business_record_version','platform_business_observation','platform_collection','platform_collection_page','platform_archive_value','platform_collection_archive_ref','platform_observation_archive_ref','platform_version_archive_ref','platform_legacy_query_alias','platform_legacy_relation_alias','platform_observation_assignment',...sources.map(src=>'platform_'+src+'_projection')]
function facts(s: Database.Database) {return tables.map(t=>s.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all())}

it('upgrades populated 0051 preserving sealed archives aliases assignments projections hashes IDs FKs and triggers',()=>{
  const f=fixture(true),fresh=fixture()
  try {
    const before=facts(f.s), triggers=f.s.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger' ORDER BY name").all()
    migrate(f.db,{migrationsFolder:resolve('db/migrations')})
    expect(facts(f.s)).toEqual(before)
    if(process.env.T714_EVIDENCE_DIR) {
      const dir=process.env.T714_EVIDENCE_DIR;mkdirSync(dir,{recursive:true})
      writeFileSync(join(dir,'upgrade-manifest.json'),JSON.stringify({oldFixture:f.root,newFixture:fresh.root,tables,before,after:facts(f.s),catalog:catalog(f.s),foreignKeys:f.s.pragma('foreign_key_check'),fkDefinitions:tables.map(t=>[t,f.s.pragma(`foreign_key_list(${t})`)]),triggers},null,2))
    }
    expect(catalog(f.s)).toEqual(catalog(fresh.s))
    expect(f.s.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger' ORDER BY name").all()).toEqual(triggers)
    expect(f.s.pragma('foreign_keys',{simple:true})).toBe(1)
    expect(f.s.pragma('foreign_key_check')).toEqual([])
    expect(f.s.pragma('integrity_check',{simple:true})).toBe('ok')
    for(const statement of ["UPDATE platform_observation_archive_ref SET sealed=0",'DELETE FROM platform_observation_assignment','DELETE FROM platform_legacy_relation_alias','UPDATE platform_collection_page SET collection_id=2 WHERE id=1','UPDATE platform_business_observation SET collection_id=2 WHERE relation_id=1']) expect(()=>f.s.exec(statement)).toThrow()
    f.s.exec(`INSERT INTO platform_relation(id,query_id,sequence_no,relation_key,raw_fields,created_at) VALUES(9,1,9,'new','{"id":"new"}','original')`)
    expect(ensurePlatformObservation(f.db,9).observationCreated).toBe(true)
    expect(f.db.select().from(schema.platformBusinessObservation).all().find(r=>r.relationId===9)?.indexedAt).toEqual(expect.any(String))
  }finally{f.close();fresh.close()}
})

it('rolls back late DDL failure atomically on populated 0051 and permits a clean retry',()=>{
 const f=fixture(true)
 try {
  const before=facts(f.s),original=catalog(f.s)
  const sql=readFileSync(resolve('db/migrations/0052_swift_starhawk.sql'),'utf8')
  expect(()=>f.s.transaction(()=>{for(const stmt of sql.split('--> statement-breakpoint'))if(stmt.trim())f.s.exec(stmt);f.s.exec('SELECT deliberate_late_failure')})()).toThrow('deliberate_late_failure')
  expect(facts(f.s)).toEqual(before);expect(catalog(f.s)).toEqual(original)
  expect(f.s.pragma('foreign_key_check')).toEqual([])
  migrate(f.db,{migrationsFolder:resolve('db/migrations')});expect(facts(f.s)).toEqual(before)
 }finally{f.close()}
})

it('rejects NULL loopholes mixed capture states forged metadata and invalid record version pairs including replace and upsert',()=>{
 const f=fixture()
 try {
  f.s.exec(`INSERT INTO platform_relation(id,query_id,sequence_no,created_at) VALUES(9,1,9,'original');INSERT INTO platform_business_observation(relation_id,identity_state,content_state) VALUES(9,'not_indexed','not_indexed')`)
  const invalid=["identity_state=NULL","content_state=NULL","identity_state='missing_key'","content_state='unverifiable'","record_id=1","version_id=1","key_source='none'","projection_rule_version=''","input_fingerprint='fake'","indexed_at='NOW'","identity_state=x'00'","content_state='unknown'"]
  for(const patch of invalid)expect(()=>f.s.exec(`UPDATE platform_business_observation SET ${patch} WHERE relation_id=9`)).toThrow()
  for(const patch of ["identity_state='unknown'","content_state='unknown'","record_id=NULL","version_id=NULL","record_id=2","version_id=2","identity_state='missing_key'","content_state='unverifiable'","key_source=NULL","key_source='bad'","key_source=x'00'","projection_rule_version=NULL","input_fingerprint=NULL","indexed_at=NULL","projection_rule_version=x'00'","input_fingerprint=x'00'","indexed_at=x'00'"])expect(()=>f.s.exec(`UPDATE platform_business_observation SET ${patch} WHERE relation_id=1`)).toThrow()
  for(const recursive of [0,1]) {
   f.s.pragma(`recursive_triggers=${recursive}`)
   expect(()=>f.s.exec(`INSERT OR REPLACE INTO platform_business_observation(relation_id,identity_state,content_state,key_source) VALUES(9,'not_indexed','not_indexed','none')`)).toThrow()
   expect(()=>f.s.exec(`INSERT INTO platform_business_observation(relation_id,identity_state,content_state) VALUES(9,'not_indexed','not_indexed') ON CONFLICT(relation_id) DO UPDATE SET indexed_at='fake'`)).toThrow()
  }
  expect(readPlatformBusinessMetadata(f.db,[9]).get(9)).toMatchObject({identityState:'not_indexed',contentState:'not_indexed',keySource:null,recordId:null,versionId:null,projectionRuleVersion:null})
  expect(f.s.pragma('foreign_key_check')).toEqual([])
 }finally{f.close()}
})

it('retains indexed missing_key conflict and resolved unverifiable branches and requires explicit ORM null for uncaptured time',()=>{
 const f=fixture()
 try {
  for(const [i,state] of ['missing_key','conflict','resolved'].entries()) {
   const id=i+10;f.s.prepare(`INSERT INTO platform_relation(id,query_id,sequence_no,created_at) VALUES(?,1,?,'original')`).run(id,id)
   f.s.prepare(`INSERT INTO platform_business_observation(relation_id,record_id,identity_state,content_state,key_source,projection_rule_version,input_fingerprint,indexed_at) VALUES(?,?,?,'unverifiable','none','','',' original ')`).run(id,state==='resolved'?1:null,state)
   expect(f.s.prepare('SELECT indexed_at FROM platform_business_observation WHERE relation_id=?').get(id)).toEqual({indexed_at:' original '})
  }
  f.s.exec(`INSERT INTO platform_relation(id,query_id,sequence_no,created_at) VALUES(20,1,20,'original')`)
  const row={relationId:20,identityState:'not_indexed',contentState:'not_indexed'} as const
  // Existing indexed-writer JS default is retained; it must never persist on this branch.
  expect(()=>f.db.insert(schema.platformBusinessObservation).values(row).run()).toThrow()
  f.db.insert(schema.platformBusinessObservation).values({...row,indexedAt:null}).run()
  expect(f.db.select().from(schema.platformBusinessObservation).all().find(r=>r.relationId===20)).toMatchObject({indexedAt:null,inputFingerprint:null,keySource:null})
  f.s.exec(`UPDATE platform_business_observation SET id=20,collection_id=1,sequence_no=20,position_state='unknown',source_relation_key='  ' WHERE relation_id=20`)
  f.db.insert(schema.platformObservationAssignment).values({observationId:20,revision:1,matchBasis:'none',verificationStatus:'pending',origin:'migrated_current'}).run()
  writeOwnerArchive(f.db,{kind:'observation',ownerId:20,field:'rawFields'},{storageClass:'null',bytes:null,createdAt:null});sealArchiveOwner(f.db,{kind:'observation',ownerId:20})
  bindLegacyAlias(f.db,{kind:'relation',oldId:20,observationId:20})
  expect(f.s.pragma('foreign_key_check')).toEqual([])
 }finally{f.close()}
})
