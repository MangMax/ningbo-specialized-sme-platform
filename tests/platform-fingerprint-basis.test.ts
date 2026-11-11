import Database from 'better-sqlite3'
import * as expandSchema from '../db/schema'
import { ensurePlatformObservation } from '../server/utils/platform-business-record'
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
  expect(a.prepare('select identity_state,content_state,record_id,version_id,key_source,projection_rule_version,input_fingerprint,indexed_at,batch_id from platform_business_observation').get()).toEqual({identity_state:'not_indexed',content_state:'not_indexed',record_id:null,version_id:null,key_source:null,projection_rule_version:null,input_fingerprint:null,indexed_at:null,batch_id:null})
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
it('preserves runtime initialization guards and rejects malformed C-capable successor commands',async()=>{
  const f=fixture();f.t.close();const source=f.target+'.71606';copyFileSync(f.target,source)
  finalizeFingerprintBasis({source,target:f.target,runId:'basis',predecessorRunId:'scopes'})
  const {useRuntimeDb,initializeDb}=await import('../db/client')
  for(const readOnly of [false,true])expect(()=>useRuntimeDb({dbPath:f.target,readOnly})).toThrow(/finalized/i)
  expect(()=>initializeDb({dbPath:f.target})).toThrow(/finalized/i)
  const {writeNewCollectionTarget}=await import('../lib/platform/collection-target-command')
  const t=new Database(f.target);t.pragma('foreign_keys=ON');const before=t.serialize()
  expect(()=>writeNewCollectionTarget(drizzle(t),{queryText:'{}',evidenceText:null,createdAt:'c',assignments:[]})).toThrow(/Invalid input/)
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

it('recovers a proven after-predecessor command preserving original own keys position and assignment',()=>{
  const f=fixture(),source=f.target+'.71606';f.t.close();copyFileSync(f.target,source)
  const t=new Database(f.target);t.pragma('foreign_keys=ON')
  const input={collectionId:1,position:{sequenceNo:2,positionState:'unknown' as const},row:{sequenceNo:2,relationKey:'new',rawFields:{id:'new',rdjb:'2'}},assignment:{enterpriseId:null,matchBasis:'none' as const,verificationStatus:'pending' as const,origin:'command' as const,actor:{type:'agent' as const,id:'original-call'},basis:'trusted original call',recordedAt:null}}
  expect(writeApplyTarget(drizzle(t),input).reused).toBe(false);t.close()
  writeFileSync(f.target+'.original-command.json',JSON.stringify(input,null,2)+'\n')
  const snapshot=f.target+'.event';copyFileSync(f.target,snapshot)
  const eventSource=f.target+'.event.json'
  writeFileSync(eventSource,JSON.stringify({predecessorSha256:createHash('sha256').update(readFileSync(source)).digest('hex'),targetSha256:createHash('sha256').update(readFileSync(snapshot)).digest('hex'),events:[{observationId:12,lifecycle:'command',originalInput:input}]}))
  const result=finalizeFingerprintBasis({source,target:f.target,runId:'basis',predecessorRunId:'scopes',eventSource:{path:eventSource,sha256:createHash('sha256').update(readFileSync(eventSource)).digest('hex'),snapshot}})
  expect(result.recoveryManifest).toContainEqual(expect.objectContaining({observationId:12,scheme:'target-command-v1',reason:null}))
  const db=new Database(f.target)
  expect(db.prepare('select hex(bytes) bytes from platform_archive_value a join platform_observation_fingerprint_basis b on b.input_archive_id=a.id').get()).toEqual({bytes:Buffer.from('{"assignment":{"actor":{"id":"original-call","type":"agent"},"basis":"trusted original call","enterpriseId":null,"matchBasis":"none","origin":"command","recordedAt":null,"verificationStatus":"pending"},"collectionId":1,"position":{"positionState":"unknown","sequenceNo":2},"row":{"rawFields":{"id":"new","rdjb":"2"},"relationKey":"new","sequenceNo":2}}').toString('hex').toUpperCase()})
  db.close()
})

function eventEvidence(source:string,target:string,events:unknown[]) {
  const snapshot=target+'.events.sqlite',path=target+'.events.json';copyFileSync(target,snapshot)
  const digest=(path:string)=>createHash('sha256').update(readFileSync(path)).digest('hex')
  writeFileSync(path,JSON.stringify({predecessorSha256:digest(source),targetSha256:digest(snapshot),events}))
  return {path,sha256:digest(path),snapshot}
}
it.each([null,7])('recovers a proven bootstrap with captured batch %s without inferring lifecycle from request or hash',batchId=>{
  const f=fixture(s=>{if(batchId!==null)s.prepare("INSERT INTO import_batch(id,idempotency_key,source_kind,source_identity,created_at) VALUES(?,'bootstrap','platform_archive','original','c')").run(batchId)});f.t.close();const source=f.target+'.71606';copyFileSync(f.target,source)
  const literal='{"interface":"apply_list","invalidRaw":"null","queriedAt":"t","queryId":1,"queryKey":"Q","rawFields":null,"rdjb":"2","relationKey":"A","sequenceNo":1}'
  const hash=createHash('sha256').update(literal).digest('hex')
  const t=new Database(f.target)
  t.exec("INSERT INTO platform_business_record(id,interface,platform_key,identity_rule_version,created_at) VALUES(9,'apply_list','A','platform-observation-v1','c')")
  t.prepare("UPDATE platform_business_observation SET record_id=9,identity_state='resolved',content_state='unverifiable',key_source='relation_key',projection_rule_version='platform-observation-v1',input_fingerprint=?,indexed_at='bootstrap event time',batch_id=? WHERE id=11").run(hash,batchId);t.close()
  const eventSource=eventEvidence(source,f.target,[{observationId:11,lifecycle:'legacy-bootstrap'}])
  const result=finalizeFingerprintBasis({source,target:f.target,runId:'basis',predecessorRunId:'scopes',legacySource:f.source,eventSource})
  expect(result.recoveryManifest).toContainEqual(expect.objectContaining({observationId:11,oldAlias:11,queryAlias:1,scheme:'legacy-bootstrap-v1',reason:null}))
  const db=new Database(f.target);expect(db.prepare('SELECT batch_id FROM platform_business_observation WHERE id=11').get()).toEqual({batch_id:batchId});db.close()
})

import { writeProcessTarget } from '../lib/platform/process-target-writer'
import { writeRecognizedTarget } from '../lib/platform/recognized-target-writer'
const writers={apply_list:writeApplyTarget,business_list:writeProcessTarget,recognized_list:writeRecognizedTarget}
it.each(Object.keys(writers) as (keyof typeof writers)[])('recovers %s original command and seals proven missing input as uncaptured',sourceInterface=>{
  for(const captured of [true,false]) {
    const f=fixture(s=>s.prepare('UPDATE platform_query SET interface=?').run(sourceInterface));f.t.close();const source=f.target+'.71606';copyFileSync(f.target,source)
    const t=new Database(f.target);t.pragma('foreign_keys=ON')
    const input={collectionId:1,position:{sequenceNo:2,positionState:'unknown' as const,pageId:null,pageRowNo:null,extraPosition:'kept'},row:{sequenceNo:2,relationKey:'new',sourceText:'exact source',rawFields:{id:'new',rdjb:'2',whpcyear:false}},assignment:{enterpriseId:null,matchBasis:'none' as const,verificationStatus:'pending' as const,origin:'command' as const,actor:{type:'agent' as const,id:'original'},basis:'independent capture',recordedAt:null,commandReceiptId:null,extraOwnKey:'kept'}}
    const row=writers[sourceInterface](drizzle(t),input);t.close()
    const eventSource=eventEvidence(source,f.target,[{observationId:row.observationId,lifecycle:'command',...(captured?{originalInput:input}:{})}])
    const options={source,target:f.target,runId:'basis',predecessorRunId:'scopes',eventSource}
    const result=finalizeFingerprintBasis(options)
    expect(result.recoveryManifest).toContainEqual(expect.objectContaining({observationId:row.observationId,scheme:captured?'target-command-v1':'uncaptured',reason:captured?null:'original-command-input-not-captured',oldAlias:row.relationAlias,queryAlias:1}))
    const db=new Database(f.target),before=db.serialize();db.close()
    expect(finalizeFingerprintBasis(options).state).toBe('complete')
    const after=new Database(f.target);expect(after.serialize()).toEqual(before);after.close()
  }
})
it.each(Object.keys(writers) as (keyof typeof writers)[])('rolls back %s old writer archives aliases and highwaters under caller-caught rejection',sourceInterface=>{
  const {t}=fixture(s=>s.prepare('UPDATE platform_query SET interface=?').run(sourceInterface));installFingerprintBasis(t);installFingerprintBarrier(t)
  const facts=()=>{const bytes=t.serialize();bytes.fill(0,24,28);bytes.fill(0,92,96);return bytes}
  const before=facts();t.exec('BEGIN')
  expect(()=>writers[sourceInterface](drizzle(t),{collectionId:1,position:{sequenceNo:2,positionState:'unknown'},row:{sequenceNo:2,relationKey:'new',rawFields:{id:'new',rdjb:'2'}},assignment:{enterpriseId:null,matchBasis:'none',verificationStatus:'pending',origin:'command',actor:{type:'agent',id:'test'},basis:'test',recordedAt:null}})).toThrow(/basis required/)
  t.exec('COMMIT');expect(facts()).toEqual(before);t.close()
})
it.each(['recovered','receipt'])('rolls back actual recovered command rows including new basis archives at %s',stage=>{
  const f=fixture();f.t.close();const source=f.target+'.71606';copyFileSync(f.target,source)
  const t=new Database(f.target);t.pragma('foreign_keys=ON')
  const input={collectionId:1,position:{sequenceNo:2,positionState:'unknown' as const},row:{sequenceNo:2,relationKey:'new',rawFields:{id:'new'}},assignment:{enterpriseId:null,matchBasis:'none' as const,verificationStatus:'pending' as const,origin:'command' as const,actor:{type:'agent' as const,id:'original'},basis:'test',recordedAt:null}}
  const row=writeApplyTarget(drizzle(t),input);t.close()
  const eventSource=eventEvidence(source,f.target,[{observationId:row.observationId,lifecycle:'command',originalInput:input}]),before=readFileSync(f.target)
  expect(()=>finalizeFingerprintBasis({source,target:f.target,runId:'basis',predecessorRunId:'scopes',eventSource,beforeCommit:s=>{if(s===stage)throw new Error('injected '+s)}})).toThrow('injected '+stage)
  expect(readFileSync(f.target)).toEqual(before)
  expect(finalizeFingerprintBasis({source,target:f.target,runId:'basis',predecessorRunId:'scopes',eventSource}).recoveryManifest).toContainEqual(expect.objectContaining({observationId:row.observationId,scheme:'target-command-v1'}))
})

it.each([null,'null','{bad','42','true','"word"','[1,null]','{"id":"A"}'].flatMap(raw=>(Object.keys(writers) as (keyof typeof writers)[]).map(sourceInterface=>({raw,sourceInterface}))))('recovers legacy original SQL raw partition $raw for $sourceInterface preserving literal bytes and hash',({raw,sourceInterface})=>{
  let value:unknown=null;try{value=raw===null?null:JSON.parse(raw)}catch{}
  const literal='{"interface":'+JSON.stringify(sourceInterface)+',"invalidRaw":'+JSON.stringify(value===null?raw:null)+',"queriedAt":"t","queryId":1,"queryKey":"Q","rawFields":'+JSON.stringify(value)+',"rdjb":"2","relationKey":"A","sequenceNo":1}'
  const fingerprint=createHash('sha256').update(literal).digest('hex')
  const f=fixture(s=>{
    s.prepare('UPDATE platform_query SET interface=?').run(sourceInterface)
    s.prepare('UPDATE platform_relation SET raw_fields=?').run(raw)
    ensurePlatformObservation(drizzle(s,{schema:expandSchema}),11,undefined,fingerprint)
  });f.t.close();const source=f.target+'.71606';copyFileSync(f.target,source)
  const result=finalizeFingerprintBasis({source,target:f.target,runId:'basis',predecessorRunId:'scopes',legacySource:f.source})
  expect(result.recoveryManifest[0]!.scheme).toBe('legacy-indexed-v1')
  const t=new Database(f.target)
  expect(t.prepare('SELECT hex(a.bytes) bytes,a.sha256 FROM platform_observation_fingerprint_basis b JOIN platform_archive_value a ON a.id=b.input_archive_id').get()).toEqual({bytes:Buffer.from(literal).toString('hex').toUpperCase(),sha256:fingerprint});t.close()
})
it.each(['blob','invalid-utf8','wrong-hash','wrong-rule'])('rejects legacy %s without writing successor DDL or receipts',kind=>{
  const f=fixture(s=>{
    if(kind==='blob')s.exec("UPDATE platform_relation SET raw_fields=X'6E756C6C'")
    if(kind==='invalid-utf8')s.exec("UPDATE platform_relation SET raw_fields=CAST(X'FF' AS TEXT)")
    const literal='{"interface":"apply_list","invalidRaw":"null","queriedAt":"t","queryId":1,"queryKey":"Q","rawFields":null,"rdjb":"2","relationKey":"A","sequenceNo":1}'
    s.exec("INSERT INTO platform_business_record(id,interface,platform_key,identity_rule_version,created_at) VALUES(9,'apply_list','A','platform-observation-v1','c')")
    s.prepare("INSERT INTO platform_business_observation(relation_id,record_id,identity_state,content_state,key_source,projection_rule_version,input_fingerprint,indexed_at) VALUES(11,9,'resolved','unverifiable','relation_key',?,?,'original time')").run(kind==='wrong-rule'?'wrong':'platform-observation-v1',kind==='wrong-hash'?'wrong':createHash('sha256').update(literal).digest('hex'))
  });f.t.close();const source=f.target+'.71606';copyFileSync(f.target,source);const before=readFileSync(f.target)
  expect(()=>finalizeFingerprintBasis({source,target:f.target,runId:'basis',predecessorRunId:'scopes',legacySource:f.source})).toThrow()
  expect(readFileSync(f.target)).toEqual(before)
})
it.each(['input','revision1','projection','version','alias','target','event-hash','unknown-lifecycle'])('rejects independently frozen command %s conflict with zero target writes',conflict=>{
  const f=fixture();f.t.close();const source=f.target+'.71606';copyFileSync(f.target,source)
  const t=new Database(f.target);t.pragma('foreign_keys=ON')
  const input={collectionId:1,position:{sequenceNo:2,positionState:'unknown' as const},row:{sequenceNo:2,relationKey:'new',rawFields:{id:'new',rdjb:'2'}},assignment:{enterpriseId:null,matchBasis:'none' as const,verificationStatus:'pending' as const,origin:'command' as const,actor:{type:'agent' as const,id:'test'},basis:'test',recordedAt:null}}
  const row=writeApplyTarget(drizzle(t),input)
  // Corrupt the independent frozen event source as well, to exercise fact verification beyond byte binding.
  const corrupt=(trigger:string,sql:string)=>{const ddl=t.prepare('SELECT sql FROM sqlite_schema WHERE name=?').get(trigger) as {sql:string};t.exec('DROP TRIGGER '+trigger);t.exec(sql);t.exec(ddl.sql)}
  if(conflict==='revision1')corrupt('platform_assignment_no_update',"UPDATE platform_observation_assignment SET basis='changed' WHERE revision=1 AND observation_id=12")
  if(conflict==='projection')t.exec("UPDATE platform_apply_projection SET status='changed' WHERE observation_id=12")
  if(conflict==='version')t.exec("UPDATE platform_business_record_version SET content_hash='changed' WHERE id="+row.versionId)
  if(conflict==='alias')corrupt('platform_legacy_relation_alias_no_delete','DELETE FROM platform_legacy_relation_alias WHERE observation_id=12')
  t.close()
  const eventSource=eventEvidence(source,f.target,conflict==='unknown-lifecycle'?[]:[{observationId:row.observationId,lifecycle:'command',originalInput:conflict==='input'?{...input,position:{...input.position,pageId:null}}:input}])
  if(conflict==='target'){const db=new Database(f.target);db.exec("UPDATE platform_business_observation SET source_relation_key='drift' WHERE id=12");db.close()}
  if(conflict==='event-hash')eventSource.sha256='wrong'
  const before=readFileSync(f.target)
  expect(()=>finalizeFingerprintBasis({source,target:f.target,runId:'basis',predecessorRunId:'scopes',eventSource})).toThrow()
  expect(readFileSync(f.target)).toEqual(before)
})
it('recovers the retained DCNXXw original-command counterexample rather than accepting its rejection',()=>{
  const original='/Users/mang/.t3/acceptance/platform-complete-migration/fingerprint-schema/raw/sqlite-DCNXXw/target.sqlite'
  const root=mkdtempSync(join(evidence,'retained-')),source=join(root,'predecessor.sqlite'),target=join(root,'target.sqlite')
  copyFileSync(original+'.71606',source);copyFileSync(original,target)
  const input:unknown=JSON.parse(readFileSync(original+'.original-command.json','utf8'))
  const eventSource=eventEvidence(source,target,[{observationId:12,lifecycle:'command',originalInput:input}])
  expect(finalizeFingerprintBasis({source,target,runId:'basis-continuation',predecessorRunId:'scopes',eventSource}).recoveryManifest).toContainEqual(expect.objectContaining({observationId:12,scheme:'target-command-v1',oldAlias:12}))
})

it('verifies revision1 while preserving later assignment revisions and input presence differences',()=>{
  const f=fixture();f.t.close();const source=f.target+'.71606';copyFileSync(f.target,source)
  const t=new Database(f.target);t.pragma('foreign_keys=ON')
  const input={collectionId:1,position:{sequenceNo:2,positionState:'unknown' as const},row:{sequenceNo:2,rawFields:null},assignment:{matchBasis:'none' as const,verificationStatus:'pending' as const,origin:'command' as const,actor:{type:'agent' as const,id:'original'},basis:'original with omitted nullable own keys'}}
  const row=writeApplyTarget(drizzle(t),input)
  t.prepare("INSERT INTO platform_observation_assignment(observation_id,revision,enterprise_id,match_basis,verification_status,actor,basis,origin) VALUES(?,2,NULL,'manual','confirmed','{\"type\":\"user\",\"id\":\"later\"}','later revision','command')").run(row.observationId);t.close()
  const eventSource=eventEvidence(source,f.target,[{observationId:row.observationId,lifecycle:'command',originalInput:input}])
  expect(finalizeFingerprintBasis({source,target:f.target,runId:'basis',predecessorRunId:'scopes',eventSource}).recoveryManifest).toContainEqual(expect.objectContaining({observationId:row.observationId,scheme:'target-command-v1'}))
  const db=new Database(f.target);expect(db.prepare('SELECT revision,basis FROM platform_observation_assignment WHERE observation_id=? ORDER BY revision').all(row.observationId)).toEqual([{revision:1,basis:'original with omitted nullable own keys'},{revision:2,basis:'later revision'}]);db.close()
})
it.each(['null','text'])('rejects a %s archive as captured BLOB without side effects',storageClass=>{
  const {t}=fixture();installFingerprintBasis(t)
  const value=storageClass==='null'?{bytes:null,length:null,digest:null}:{bytes:Buffer.from('{}'),length:2,digest:'44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a'}
  t.prepare('INSERT INTO platform_archive_value(id,storage_class,bytes,byte_length,sha256) VALUES(100,?,?,?,?)').run(storageClass,value.bytes,value.length,value.digest)
  const before=t.serialize()
  expect(()=>t.exec("INSERT INTO platform_observation_fingerprint_basis VALUES(11,'target-command-v1',100)")).toThrow(/BLOB/)
  expect(t.serialize()).toEqual(before);t.close()
})
it.each(['created','recovered','barrier','receipt'])('locks independent after-event snapshot throughout successor %s stage',wanted=>{
  const f=fixture();f.t.close();const source=f.target+'.71606';copyFileSync(f.target,source)
  const t=new Database(f.target);t.pragma('foreign_keys=ON')
  const input={collectionId:1,position:{sequenceNo:2,positionState:'unknown' as const},row:{sequenceNo:2,rawFields:null},assignment:{enterpriseId:null,matchBasis:'none' as const,verificationStatus:'pending' as const,origin:'command' as const,actor:{type:'agent' as const,id:'test'},basis:'test',recordedAt:null}}
  const row=writeApplyTarget(drizzle(t),input);t.close()
  const eventSource=eventEvidence(source,f.target,[{observationId:row.observationId,lifecycle:'command',originalInput:input}])
  let checked=false
  finalizeFingerprintBasis({source,target:f.target,runId:'basis',predecessorRunId:'scopes',eventSource,beforeCommit:stage=>{
    if(stage!==wanted)return
    const result=spawnSync(process.execPath,['--input-type=module','-e',`import Database from 'better-sqlite3';const t=new Database(process.argv[1]);t.pragma('busy_timeout=1');try{t.exec("UPDATE platform_collection SET query_key='drift'");process.stdout.write('WRITE')}catch(e){process.stdout.write(e.code)}finally{t.close()}`,eventSource.snapshot],{encoding:'utf8'})
    expect(result.stdout,result.stderr).toBe('SQLITE_BUSY');checked=true
  }})
  expect(checked).toBe(true)
})

import { writeNewCollectionTarget } from '../lib/platform/collection-target-command'
import { platformResultToImport } from '../lib/platform/recognized-evidence'
import type { PlatformLiveQueryResult } from '../lib/platform/live-query'
it.each(['queryList','businessList','queryBusList'] as const)('recovers original writer envelope produced by a full %s collection command',sourceKind=>{
  const f=fixture(s=>s.exec("INSERT INTO title(code,name_zh,level,rank) VALUES('specialized_sme','专精特新中小企业','municipal',2)"));f.t.close()
  const source=f.target+'.71606';copyFileSync(f.target,source)
  const e:PlatformLiveQueryResult={source:sourceKind,status:'success',effectiveConditions:sourceKind==='businessList'?{uscc:'91330200712345678A',combination:'and'}:{name:'Example',combination:'and'},titleScope:{mode:sourceKind==='queryList'?'source_default':'selected',rdjb:sourceKind==='queryList'?[]:['2']},queriedAt:'2026-11-11T00:00:00Z',completedAt:'2026-11-11T00:01:00Z',rows:[{id:'new',qymc:'Example',rdjb:'2'}],dataRows:[{id:'new',qymc:'Example',rdjb:'2'}],pages:[{source:sourceKind,rdjb:sourceKind==='queryList'?null:'2',page:1,maxPage:1,status:'success',fetchedCount:1,declaredTotal:1,error:null}],fetchedCount:1,declaredTotal:1,completeness:'complete',fullRange:true,unfinished:[],error:null,limits:{maxRequests:100,maxRows:5000,maxDurationMs:60000,pageSize:50}}
  const query=platformResultToImport(e),assignment={enterpriseId:null,matchBasis:'none' as const,verificationStatus:'pending' as const,origin:'command' as const,actor:{type:'agent' as const,id:'full-command'},basis:'original full command',recordedAt:null}
  const t=new Database(f.target);t.pragma('foreign_keys=ON')
  const result=writeNewCollectionTarget(drizzle(t),{queryText:JSON.stringify(query),evidenceText:JSON.stringify(e),createdAt:'original',assignments:[assignment]})
  const row=result.observations[0]!,position=t.prepare('SELECT page_id,page_row_no FROM platform_business_observation WHERE id=?').get(row.observationId) as {page_id:number,page_row_no:number};t.close()
  const input={collectionId:result.collectionId,position:{sequenceNo:1,pageId:position.page_id,pageRowNo:position.page_row_no,positionState:'verified'},row:query.relations![0],assignment}
  const eventSource=eventEvidence(source,f.target,[{observationId:row.observationId,lifecycle:'command',originalInput:input}])
  expect(finalizeFingerprintBasis({source,target:f.target,runId:'basis',predecessorRunId:'scopes',eventSource}).recoveryManifest).toContainEqual(expect.objectContaining({observationId:row.observationId,scheme:'target-command-v1'}))
})

it('rejects bootstrap evidence changing predecessor position with zero writes',()=>{
  const f=fixture();f.t.close();const source=f.target+'.71606';copyFileSync(f.target,source)
  const literal='{"interface":"apply_list","invalidRaw":"null","queriedAt":"t","queryId":1,"queryKey":"Q","rawFields":null,"rdjb":"2","relationKey":"A","sequenceNo":1}'
  const t=new Database(f.target)
  t.exec("INSERT INTO platform_business_record(id,interface,platform_key,identity_rule_version,created_at) VALUES(9,'apply_list','A','platform-observation-v1','c')")
  t.prepare("UPDATE platform_business_observation SET record_id=9,identity_state='resolved',content_state='unverifiable',key_source='relation_key',projection_rule_version='platform-observation-v1',input_fingerprint=?,indexed_at='bootstrap event time',position_state='conflict' WHERE id=11").run(createHash('sha256').update(literal).digest('hex'));t.close()
  const eventSource=eventEvidence(source,f.target,[{observationId:11,lifecycle:'legacy-bootstrap'}]),before=readFileSync(f.target)
  expect(()=>finalizeFingerprintBasis({source,target:f.target,runId:'basis',predecessorRunId:'scopes',legacySource:f.source,eventSource})).toThrow(/predecessor.*positionState/)
  expect(readFileSync(f.target)).toEqual(before)
})
it('seals proven command lifecycle with missing original input as uncaptured rather than rejecting recovery',()=>{
  const f=fixture();f.t.close();const source=f.target+'.71606';copyFileSync(f.target,source)
  const t=new Database(f.target);t.pragma('foreign_keys=ON')
  const row=writeApplyTarget(drizzle(t),{collectionId:1,position:{sequenceNo:2,positionState:'unknown'},row:{sequenceNo:2,rawFields:null},assignment:{enterpriseId:null,matchBasis:'none',verificationStatus:'pending',origin:'command',actor:{type:'agent',id:'original'},basis:'original',recordedAt:null}});t.close()
  const eventSource=eventEvidence(source,f.target,[{observationId:row.observationId,lifecycle:'command'}])
  expect(finalizeFingerprintBasis({source,target:f.target,runId:'basis',predecessorRunId:'scopes',eventSource}).recoveryManifest).toContainEqual(expect.objectContaining({observationId:row.observationId,scheme:'uncaptured',certification:'refused-uncaptured',reason:'original-command-input-not-captured'}))
})

it('recovers command evidence through the CLI and replays in an independent process with identical row manifest',()=>{
  const f=fixture();f.t.close();const source=f.target+'.71606';copyFileSync(f.target,source)
  const t=new Database(f.target);t.pragma('foreign_keys=ON')
  const input={collectionId:1,position:{sequenceNo:2,positionState:'unknown' as const},row:{sequenceNo:2,rawFields:null},assignment:{enterpriseId:null,matchBasis:'none' as const,verificationStatus:'pending' as const,origin:'command' as const,actor:{type:'agent' as const,id:'original'},basis:'original',recordedAt:null}}
  const row=writeApplyTarget(drizzle(t),input);t.close()
  const eventSource=eventEvidence(source,f.target,[{observationId:row.observationId,lifecycle:'command',originalInput:input}])
  let original:unknown
  for(const attempt of ['first','replay']) {
    const dir=f.target+'.cli-'+attempt
    const result=spawnSync(process.execPath,['upgrade/run-fingerprint-basis.mjs',source,f.target,dir,'basis','scopes','',eventSource.path,eventSource.sha256,eventSource.snapshot],{encoding:'utf8'})
    writeFileSync(dir+'.stdout',result.stdout);writeFileSync(dir+'.stderr',result.stderr)
    expect(result.status,result.stderr).toBe(0)
    const receipt=JSON.parse(readFileSync(join(dir,'receipt.json'),'utf8'))
    expect(receipt.recoveryManifest).toContainEqual(expect.objectContaining({observationId:row.observationId,scheme:'target-command-v1',certification:'verified',oldAlias:row.relationAlias,queryAlias:1}))
    if(attempt==='first')original=receipt;else expect(receipt).toEqual(original)
  }
})
it('CLI persists every observation refusal reason and original aliases after recovery conflict without target writes',()=>{
  const f=fixture();f.t.close();const source=f.target+'.71606';copyFileSync(f.target,source)
  const t=new Database(f.target);t.pragma('foreign_keys=ON')
  const input={collectionId:1,position:{sequenceNo:2,positionState:'unknown' as const},row:{sequenceNo:2,rawFields:null},assignment:{enterpriseId:null,matchBasis:'none' as const,verificationStatus:'pending' as const,origin:'command' as const,actor:{type:'agent' as const,id:'original'},basis:'original',recordedAt:null}}
  const row=writeApplyTarget(drizzle(t),input);t.close()
  const eventSource=eventEvidence(source,f.target,[{observationId:row.observationId,lifecycle:'command',originalInput:{...input,position:{...input.position,pageId:null}}}]),before=readFileSync(f.target),dir=f.target+'.cli-rejected'
  const result=spawnSync(process.execPath,['upgrade/run-fingerprint-basis.mjs',source,f.target,dir,'basis','scopes','',eventSource.path,eventSource.sha256,eventSource.snapshot],{encoding:'utf8'})
  writeFileSync(dir+'.stdout',result.stdout);writeFileSync(dir+'.stderr',result.stderr)
  expect(result.status).not.toBe(0);expect(readFileSync(f.target)).toEqual(before)
  const failure=JSON.parse(readFileSync(join(dir,'failure.json'),'utf8'))
  expect(failure.recoveryManifest).toHaveLength(2)
  expect(failure.recoveryManifest).toContainEqual(expect.objectContaining({observationId:row.observationId,scheme:'rejected',certification:'rejected',oldAlias:row.relationAlias,queryAlias:1,reason:'Command fingerprint conflict'}))
})

it.each([false,true])('checks proven recognized additive fidelity event with conflicting fields %s',drift=>{
  const f=fixture(s=>{
    s.prepare('UPDATE platform_query SET interface=?').run('recognized_list')
    s.prepare('UPDATE platform_relation SET raw_fields=?').run('{"id":"A","rdjb":"2"}')
    ensurePlatformObservation(drizzle(s,{schema:expandSchema}),11)
    s.exec('UPDATE platform_recognized_projection SET source_validity_date=NULL,source_maintenance_batch=NULL,source_maintenance_year_absent=NULL')
  });f.t.close();const source=f.target+'.71606';copyFileSync(f.target,source)
  const t=new Database(f.target);t.pragma('foreign_keys=ON')
  const input={collectionId:1,position:{sequenceNo:2,positionState:'unknown' as const},row:{sequenceNo:2,relationKey:'A',rawFields:{id:'A',rdjb:'2'}},assignment:{enterpriseId:null,matchBasis:'none' as const,verificationStatus:'pending' as const,origin:'command' as const,actor:{type:'agent' as const,id:'original'},basis:'original',recordedAt:null}}
  const row=writeRecognizedTarget(drizzle(t),input)
  if(drift)t.exec("UPDATE platform_recognized_projection SET source_validity_date='invented' WHERE version_id IS NOT NULL")
  t.close()
  const eventSource=eventEvidence(source,f.target,[{observationId:row.observationId,lifecycle:'command',originalInput:input}])
  const before=readFileSync(f.target),run=()=>finalizeFingerprintBasis({source,target:f.target,runId:'basis',predecessorRunId:'scopes',legacySource:f.source,eventSource})
  if(drift){expect(run).toThrow(/predecessor facts/);expect(readFileSync(f.target)).toEqual(before)}
  else expect(run().recoveryManifest).toContainEqual(expect.objectContaining({observationId:row.observationId,scheme:'target-command-v1'}))
})
