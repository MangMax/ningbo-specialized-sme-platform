import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { copyFileSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'
import { upgradeCollections } from '../upgrade/collections'
import { upgradeObservations } from '../upgrade/observations'
import { upgradeProjections } from '../upgrade/projections'
import { finalizeObservations, finalizeCollectionScopes } from '../upgrade/finalize-observations'
import { installFingerprintBasis } from '../upgrade/fingerprint-basis'
const evidence=process.env.FINGERPRINT_SCHEMA_EVIDENCE_DIR??tmpdir()
function fixture(seed?:(s:Database.Database)=>void) {
  const root=mkdtempSync(join(evidence,'sqlite-')),source=join(root,'source.sqlite'),target=join(root,'target.sqlite')
  const s=new Database(source);migrate(drizzle(s),{migrationsFolder:'db/migrations'})
  s.exec(`INSERT INTO platform_query(id,interface,query_key,rdjb,queried_at,status,created_at) VALUES(1,'apply_list','Q','2','t','success','c');
    INSERT INTO platform_relation(id,query_id,sequence_no,relation_key,raw_fields,created_at) VALUES(11,1,1,'A','null','c');`)
  seed?.(s)
  s.close();copyFileSync(source,target)
  upgradeCollections({source,target,runId:'collections',batchSize:10})
  upgradeObservations({source,target,runId:'observations',collectionRunId:'collections',batchSize:10})
  upgradeProjections({source,target,runId:'projections',observationRunId:'observations',collectionRunId:'collections',batchSize:10})
  const opts={source,target,runId:'final',projectionRunId:'projections',observationRunId:'observations',collectionRunId:'collections'}
  finalizeObservations(opts);finalizeCollectionScopes({...opts,runId:'scopes',finalizationRunId:'final'})
  const t=new Database(target);t.pragma('foreign_keys=ON')
  return {source,target,t}
}
it('requires actual FK ON before schema writes even inside an outer transaction',()=>{
  const {t}=fixture();t.pragma('foreign_keys=OFF');const before=t.serialize()
  for(const outer of [false,true]) {
    if(outer)t.exec('BEGIN')
    expect(()=>installFingerprintBasis(t)).toThrow(/foreign_keys/)
    if(outer)t.exec('ROLLBACK')
    expect(t.serialize()).toEqual(before)
  }
  t.close()
})
it('defers orphan basis validation to outer COMMIT and restores facts on explicit rollback',()=>{
  const {t}=fixture();installFingerprintBasis(t);const before=t.serialize()
  t.exec("BEGIN; SAVEPOINT nested; INSERT INTO platform_observation_fingerprint_basis VALUES(100,'uncaptured',NULL); RELEASE nested")
  expect(()=>t.exec('COMMIT')).toThrow(/FOREIGN KEY/);expect(t.inTransaction).toBe(true)
  t.exec('ROLLBACK');expect(t.serialize()).toEqual(before)
  t.exec("BEGIN; INSERT INTO platform_observation_fingerprint_basis VALUES(100,'uncaptured',NULL); INSERT INTO platform_business_observation(id,collection_id,sequence_no,position_state,identity_state,content_state,indexed_at) VALUES(100,1,2,'unknown','not_indexed','not_indexed',NULL); COMMIT")
  expect(t.pragma('foreign_key_check')).toEqual([]);t.close()
})

import { finalizeFingerprintBasis } from '../upgrade/fingerprint-basis'
it('upgrades complete populated 71606 preserving original cells and seals then replays without writes',()=>{
  const {source,target,t}=fixture();t.close()
  // Independent frozen 71606 predecessor, separate from the original legacy source.
  const predecessor=target+'.71606';copyFileSync(target,predecessor)
  const result=finalizeFingerprintBasis({source:predecessor,target,runId:'basis',predecessorRunId:'scopes'})
  expect(result.state).toBe('complete')
  const a=new Database(target)
  expect(a.pragma('user_version',{simple:true})).toBe(71607)
  expect(a.prepare('select * from platform_observation_fingerprint_basis').all()).toEqual([])
  expect(a.prepare('select identity_state,input_fingerprint,indexed_at from platform_business_observation').get()).toEqual({identity_state:'not_indexed',input_fingerprint:null,indexed_at:null})
  expect(a.prepare("select hex(a.bytes) bytes,r.sealed from platform_observation_archive_ref r join platform_archive_value a on a.id=r.archive_id where r.owner_id=11 and r.field='rawFields'").get()).toEqual({bytes:'6E756C6C',sealed:1})
  const bytes=a.serialize();a.close()
  expect(finalizeFingerprintBasis({source:predecessor,target,runId:'basis',predecessorRunId:'scopes'}).state).toBe('complete')
  const b=new Database(target);expect(b.serialize()).toEqual(bytes);b.close()
})

import { installFingerprintBarrier, fingerprintArchiveInventory } from '../upgrade/fingerprint-basis'
it.each([0,1])('enforces insert-only schemes BLOB archive and bidirectional owner exclusion with recursive triggers %i',recursive=>{
  const {t}=fixture();installFingerprintBasis(t);t.pragma(`recursive_triggers=${recursive}`)
  // Independent literal bytes and SHA256, not the archive writer as expected oracle.
  t.exec("INSERT INTO platform_archive_value(id,storage_class,bytes,byte_length,sha256) VALUES(100,'blob',X'7B7D',2,'44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a'); INSERT INTO platform_observation_fingerprint_basis VALUES(11,'legacy-indexed-v1',100)")
  for(const sql of [
    "UPDATE platform_observation_fingerprint_basis SET scheme='target-command-v1'",
    'DELETE FROM platform_observation_fingerprint_basis',
    'INSERT OR REPLACE INTO platform_observation_fingerprint_basis SELECT * FROM platform_observation_fingerprint_basis',
    "INSERT INTO platform_observation_fingerprint_basis VALUES(11,'uncaptured',NULL) ON CONFLICT(observation_id) DO NOTHING",
    "INSERT INTO platform_observation_fingerprint_basis VALUES(12,'unknown',NULL)",
    "INSERT INTO platform_observation_fingerprint_basis VALUES(12,'target-command-v1',NULL)",
    "INSERT INTO platform_observation_fingerprint_basis VALUES(12,'uncaptured',100)",
    "INSERT INTO platform_observation_fingerprint_basis VALUES(0,'uncaptured',NULL)",
    "INSERT INTO platform_observation_fingerprint_basis VALUES(9007199254740992,'uncaptured',NULL)",
    "INSERT INTO platform_observation_fingerprint_basis VALUES(12,'legacy-indexed-v1',999)",
  ])expect(()=>t.exec(sql),sql).toThrow()
  for(const ref of ['platform_collection_archive_ref','platform_observation_archive_ref','platform_version_archive_ref']) {
    const field=ref.includes('collection')?'rawResponse':ref.includes('version')?'canonicalRawJson':'rawFields'
    expect(()=>t.prepare(`INSERT INTO ${ref}(owner_id,field,archive_id) VALUES(999,?,100)`).run(field)).toThrow(/exclusive/)
    // Existing ref archive may not become a basis input, including refs whose payload is BLOB.
    const a=t.prepare(`SELECT archive_id id FROM ${ref} LIMIT 1`).get() as {id:number}|undefined
    if(a)expect(()=>t.prepare("INSERT INTO platform_observation_fingerprint_basis VALUES(12,'target-command-v1',?)").run(a.id)).toThrow()
  }
  expect(fingerprintArchiveInventory(t)).toHaveLength(8)
  t.exec('CREATE TABLE unknown_owner(id INTEGER PRIMARY KEY,a INTEGER REFERENCES platform_archive_value(id))')
  expect(()=>fingerprintArchiveInventory(t)).toThrow(/inventory/);t.close()
})
it('blocks old indexed INSERT and bootstrap UPDATE while retaining original seals and deferred complete pairs',()=>{
  const {t}=fixture();installFingerprintBasis(t);installFingerprintBarrier(t)
  const insert="INSERT INTO platform_business_observation(id,collection_id,sequence_no,position_state,identity_state,content_state,key_source,projection_rule_version,input_fingerprint,indexed_at) VALUES(100,1,2,'unknown','missing_key','unverifiable','none','platform-observation-v1','hash','time')"
  const update="UPDATE platform_business_observation SET identity_state='missing_key',content_state='unverifiable',key_source='none',projection_rule_version='platform-observation-v1',input_fingerprint='hash',indexed_at='time' WHERE id=11"
  expect(()=>t.exec(insert)).toThrow(/basis required/);expect(()=>t.exec(update)).toThrow(/basis required/)
  t.exec("INSERT INTO platform_archive_value(id,storage_class,bytes,byte_length,sha256) VALUES(100,'blob',X'7B7D',2,'44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a')")
  t.exec("BEGIN; SAVEPOINT nested; INSERT INTO platform_observation_fingerprint_basis VALUES(100,'target-command-v1',100)")
  t.exec(insert);t.exec('RELEASE nested; COMMIT')
  expect(t.pragma('foreign_key_check')).toEqual([])
  expect(()=>t.exec('UPDATE platform_observation_archive_ref SET sealed=0')).toThrow();t.close()
})

import { createHash } from 'node:crypto'
it('recovers proven legacy indexed literal null input without changing original hash or bytes',()=>{
  // Literal canonical envelope independently fixed by the published oracle, not implementation output.
  const input='{"interface":"apply_list","invalidRaw":"null","queriedAt":"t","queryId":1,"queryKey":"Q","rawFields":null,"rdjb":"2","relationKey":"A","sequenceNo":1}'
  const fingerprint=createHash('sha256').update(input).digest('hex')
  const f=fixture(s=>{
    s.exec("INSERT INTO platform_business_record(id,interface,platform_key,identity_rule_version,created_at) VALUES(9,'apply_list','A','platform-observation-v1','c')")
    s.prepare("INSERT INTO platform_business_observation(relation_id,record_id,identity_state,content_state,key_source,projection_rule_version,input_fingerprint,indexed_at) VALUES(11,9,'resolved','unverifiable','relation_key','platform-observation-v1',?,'original time')").run(fingerprint)
  });f.t.close();const predecessor=f.target+'.71606';copyFileSync(f.target,predecessor)
  expect(finalizeFingerprintBasis({source:predecessor,target:f.target,runId:'basis',predecessorRunId:'scopes',legacySource:f.source}).state).toBe('complete')
  const t=new Database(f.target)
  expect(t.prepare('SELECT b.scheme,hex(a.bytes) bytes,a.sha256,o.input_fingerprint,o.indexed_at FROM platform_observation_fingerprint_basis b JOIN platform_archive_value a ON a.id=b.input_archive_id JOIN platform_business_observation o ON o.id=b.observation_id').get()).toEqual({scheme:'legacy-indexed-v1',bytes:Buffer.from(input).toString('hex').toUpperCase(),sha256:fingerprint,input_fingerprint:fingerprint,indexed_at:'original time'})
  t.close()
})

import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
it.each(['created','recovered','barrier','receipt'])('rolls back all successor DDL marker receipt and facts at %s and restarts',stage=>{
  const f=fixture();f.t.close();const source=f.target+'.71606';copyFileSync(f.target,source)
  const before=readFileSync(f.target)
  expect(()=>finalizeFingerprintBasis({source,target:f.target,runId:'basis',predecessorRunId:'scopes',beforeCommit:s=>{if(s===stage)throw new Error('injected '+stage)}})).toThrow('injected '+stage)
  expect(readFileSync(f.target)).toEqual(before)
  expect(finalizeFingerprintBasis({source,target:f.target,runId:'basis',predecessorRunId:'scopes'}).state).toBe('complete')
})
it('rejects unproved after-predecessor fact drift with zero target writes',()=>{
  const f=fixture();f.t.close();const source=f.target+'.71606';copyFileSync(f.target,source)
  const t=new Database(f.target);t.exec("UPDATE platform_business_observation SET source_relation_key='changed' WHERE id=11");t.close()
  const before=readFileSync(f.target)
  expect(()=>finalizeFingerprintBasis({source,target:f.target,runId:'basis',predecessorRunId:'scopes'})).toThrow(/Unproven target/)
  expect(readFileSync(f.target)).toEqual(before)
})
it('rejects FK OFF barrier installation inside outer transactions before any writes',()=>{
  const {t}=fixture();installFingerprintBasis(t);t.pragma('foreign_keys=OFF');const before=t.serialize()
  t.exec('BEGIN');expect(()=>installFingerprintBarrier(t)).toThrow(/foreign_keys/);t.exec('ROLLBACK')
  expect(t.serialize()).toEqual(before);t.close()
})
it('keeps source lock during schema and receipt writes and replays in another process',()=>{
  const f=fixture();f.t.close();const source=f.target+'.71606';copyFileSync(f.target,source)
  const before=readFileSync(source),stages:string[]=[]
  finalizeFingerprintBasis({source,target:f.target,runId:'basis',predecessorRunId:'scopes',beforeCommit:stage=>{
    const result=spawnSync(process.execPath,['--input-type=module','-e',`import Database from 'better-sqlite3';const t=new Database(process.argv[1]);t.pragma('busy_timeout=1');try{t.exec("UPDATE platform_collection SET query_key='drift'");process.stdout.write('WRITE')}catch(e){process.stdout.write(e.code)}finally{t.close()}`,source],{encoding:'utf8'})
    expect(result.stdout,result.stderr).toBe('SQLITE_BUSY');stages.push(stage)
  }})
  expect(stages).toEqual(['created','recovered','barrier','receipt']);expect(readFileSync(source)).toEqual(before)
  const result=spawnSync(process.execPath,['upgrade/run-fingerprint-basis.mjs',source,f.target,join(f.target+'.evidence'),'basis','scopes'],{encoding:'utf8'})
  writeFileSync(f.target+'.replay.stdout',result.stdout);writeFileSync(f.target+'.replay.stderr',result.stderr)
  expect(result.status,result.stderr).toBe(0)
})
it('preserves runtime initialization and old command guard on the successor',async()=>{
  const f=fixture();f.t.close();const source=f.target+'.71606';copyFileSync(f.target,source)
  finalizeFingerprintBasis({source,target:f.target,runId:'basis',predecessorRunId:'scopes'})
  const {useRuntimeDb,initializeDb}=await import('../db/client')
  for(const readOnly of [false,true])expect(()=>useRuntimeDb({dbPath:f.target,readOnly})).toThrow(/finalized/i)
  expect(()=>initializeDb({dbPath:f.target})).toThrow(/finalized/i)
  const {writeNewCollectionTarget}=await import('../lib/platform/collection-target-command')
  const t=new Database(f.target);t.pragma('foreign_keys=ON');const before=t.serialize()
  expect(()=>writeNewCollectionTarget(drizzle(t),{queryText:'{}',evidenceText:null,createdAt:'c',assignments:[]})).toThrow(/71606/)
  expect(t.serialize()).toEqual(before);t.close()
})

it('checks the complete physical basis FK index trigger catalog and original ref DDL stays byte equal',()=>{
  const {t}=fixture()
  const original=t.prepare("SELECT type,name,sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY type,name").all()
  installFingerprintBasis(t);installFingerprintBarrier(t)
  const after=t.prepare("SELECT type,name,sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY type,name").all()
  for(const row of original)expect(after).toContainEqual(row)
  expect(t.pragma('foreign_key_list(platform_observation_fingerprint_basis)')).toEqual(expect.arrayContaining([
    expect.objectContaining({table:'platform_archive_value',from:'input_archive_id',to:'id',on_delete:'RESTRICT'}),
    expect.objectContaining({table:'platform_business_observation',from:'observation_id',to:'id',on_delete:'RESTRICT'}),
  ]))
  expect(t.pragma('index_list(platform_observation_fingerprint_basis)')).toEqual([expect.objectContaining({unique:1,origin:'u'})])
  const triggers=t.prepare("SELECT name FROM sqlite_schema WHERE type='trigger' AND (name LIKE 'platform_fingerprint_basis_%' OR name LIKE '%fingerprint_exclusive' OR name LIKE 'platform_observation_fingerprint_%') ORDER BY name").all()
  expect(triggers).toHaveLength(8)
  const ddl=t.prepare("SELECT sql FROM sqlite_schema WHERE name='platform_observation_fingerprint_basis'").get() as {sql:string}
  expect(ddl.sql).toContain('DEFERRABLE INITIALLY DEFERRED');t.close()
})

import { writeApplyTarget } from '../lib/platform/apply-target-writer'
it('rolls back content archives sequences and aliases when the old direct writer hits the basis-first barrier',()=>{
  const {t}=fixture();installFingerprintBasis(t);installFingerprintBarrier(t)
  // Outer empty COMMIT increments SQLite header counters, not business facts or high waters.
  const facts=()=>{const bytes=t.serialize();bytes.fill(0,24,28);bytes.fill(0,92,96);return bytes}
  const before=facts()
  const input={collectionId:1,position:{sequenceNo:2,positionState:'unknown' as const},row:{sequenceNo:2,relationKey:'new',rawFields:{id:'new',rdjb:'2'}},assignment:{enterpriseId:null,matchBasis:'none' as const,verificationStatus:'pending' as const,origin:'command' as const,actor:{type:'agent' as const,id:'test'},basis:'test',recordedAt:null}}
  t.exec('BEGIN')
  expect(()=>writeApplyTarget(drizzle(t),input)).toThrow(/basis required/)
  t.exec('COMMIT');expect(facts()).toEqual(before);t.close()
})

it('binds allocation highwaters and rejects target sequence drift',()=>{
  const f=fixture();f.t.close();const source=f.target+'.71606';copyFileSync(f.target,source)
  const t=new Database(f.target);t.exec("UPDATE sqlite_sequence SET seq=seq+50 WHERE name='platform_archive_value'");t.close()
  const before=readFileSync(f.target)
  expect(()=>finalizeFingerprintBasis({source,target:f.target,runId:'basis',predecessorRunId:'scopes'})).toThrow(/Unproven target/)
  expect(readFileSync(f.target)).toEqual(before)
})

it('retains known S gap: a valid after-predecessor command with original input is rejected rather than recovered',()=>{
  const f=fixture(),source=f.target+'.71606';f.t.close();copyFileSync(f.target,source)
  const t=new Database(f.target);t.pragma('foreign_keys=ON')
  const input={collectionId:1,position:{sequenceNo:2,positionState:'unknown' as const},row:{sequenceNo:2,relationKey:'new',rawFields:{id:'new',rdjb:'2'}},assignment:{enterpriseId:null,matchBasis:'none' as const,verificationStatus:'pending' as const,origin:'command' as const,actor:{type:'agent' as const,id:'original-call'},basis:'trusted original call',recordedAt:null}}
  expect(writeApplyTarget(drizzle(t),input).reused).toBe(false);t.close()
  writeFileSync(f.target+'.original-command.json',JSON.stringify(input,null,2)+'\n')
  const before=readFileSync(f.target)
  expect(()=>finalizeFingerprintBasis({source,target:f.target,runId:'basis',predecessorRunId:'scopes'})).toThrow(/Unproven target/)
  expect(readFileSync(f.target)).toEqual(before)
})
