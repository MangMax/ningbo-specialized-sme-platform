import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import * as legacySchema from '../db/schema'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { processReaderFixture } from './helpers/process-target-734'
import { readPlatformQueryEvidence } from '../lib/platform/evidence-read'
import { writeApplyTarget } from '../lib/platform/apply-target-writer'
import { writeProcessTarget } from '../lib/platform/process-target-writer'
import { writeRecognizedTarget } from '../lib/platform/recognized-target-writer'
import { targetSchema as s } from '../lib/platform/target-schema'
import { eq } from 'drizzle-orm'
import { readTargetPlatformEvidence } from '../lib/platform/target-evidence-read'
let f: Awaited<ReturnType<typeof processReaderFixture>>
beforeAll(async()=>{ f=await processReaderFixture(true,old=>{
  old.exec(`INSERT INTO platform_query(id,interface,query_key,rdjb,queried_at,status,raw_response,created_at) VALUES
    (21,'apply_list','apply','2','t','success','','c'),(22,'recognized_list','recognized','2','t','success',NULL,'c'),
    (23,'apply_list','failed','2','t','failed',NULL,'c'),(24,'apply_list','empty','2','t','no_record',NULL,'c');
    INSERT INTO platform_relation(id,query_id,sequence_no,raw_fields,created_at) VALUES
    (21,21,1,'{ "n":1.00,"n":2,"u":"🙂" }','c'),(22,22,1,NULL,'c'),(23,22,4,'broken','c');
    UPDATE platform_query SET raw_response=CAST(X'00FF0102' AS BLOB) WHERE id=24;`)
  old.exec("INSERT INTO import_batch(id,idempotency_key,source_kind,source_identity,created_at) VALUES(1,'test','platform_archive','fixture','created')")
  old.prepare("INSERT INTO platform_query_legacy_provenance(query_id,source_identity,source_sha256,segment_index,collection,input_fingerprint,import_batch_id,created_at) VALUES(21,'original',?,0,?,'fp',1,'c')").run('a'.repeat(64),'{ \"source\":\"queryList\", \"raw\":\"行🙂\\n\" }')
  old.prepare('UPDATE platform_query SET raw_response=? WHERE id=11').run('x'.repeat(65535)+'🙂尾')
}) })
afterAll(()=>f?.close())
it('returns frozen SQLite DTO bytes through explicit target aliases after complete migration',()=>{
  const input={queryId:11,relationId:1,field:'relation' as const}
  expect(readTargetPlatformEvidence(f.db,input)).toEqual(readPlatformQueryEvidence(f.old,input))
})

function read(input: Parameters<typeof readTargetPlatformEvidence>[1]) {return readTargetPlatformEvidence(f.db,input)}
it('matches all three collection fields and independent old reader byte ranges including UTF8 and BLOB',()=>{
  for(const queryId of [11,12,13,21,22,23,24])for(const field of ['rawResponse','collectionEvidence'] as const)
    for(const offset of [0,1,65535,65536,65540,999999]) {
      const input={queryId,field,offset,length:3}
      expect(read(input)).toEqual(readPlatformQueryEvidence(f.old,input))
    }
  const part=read({queryId:11,field:'rawResponse'})
  expect(part).toMatchObject({byteLength:65536,totalBytes:65542,hasMore:true})
  expect(read({queryId:21,field:'rawResponse'})).toMatchObject({isNull:false,data:'',totalBytes:0})
  expect(read({queryId:22,field:'rawResponse'})).toMatchObject({isNull:true,data:''})
})
it('uses actual frozen SQLite JSON bytes, preserves duplicate keys/numeric spelling, and literal NULL DTO order',()=>{
  for(const [queryId,relationId] of [[11,7],[21,21],[22,22]] as const) {
    const input={queryId,relationId,field:'relation' as const}
    const result=read(input)
    expect(result).toEqual(readPlatformQueryEvidence(f.old,input))
  }
  const result=read({queryId:22,relationId:22,field:'relation'})
  if(typeof result.data!=='string')throw new Error('chunk expected')
  expect(Buffer.from(result.data,'base64').toString()).toBe('{"id":22,"queryId":22,"sequenceNo":1,"relationKey":null,"enterpriseId":null,"rawFields":null,"titleRaw":null,"sourceText":null,"usccRaw":null,"nameRaw":null,"aliasNameRaw":null,"province":null,"status":null,"batch":null,"declareKind":null,"appliedAt":null,"awardBatchLabel":null,"year":null,"matchBasis":"none","verificationStatus":"pending","createdAt":"c"}')
  const raw=read({queryId:21,relationId:21,field:'relation'})
  if(typeof raw.data!=='string')throw new Error('chunk expected')
  expect(Buffer.from(raw.data,'base64').toString()).toContain('"rawFields":{"n":1.00,"n":2,"u":"🙂"}')
})
it('preserves SQLite malformed JSON and BLOB-in-DTO errors instead of substituting NULL',()=>{
  for(const [queryId,relationId,error] of [[22,23,'malformed JSON'],[12,8,'JSON cannot hold BLOB values']] as const){
    const input={queryId,relationId,field:'relation' as const}
    expect(()=>readPlatformQueryEvidence(f.old,input)).toThrow(error)
    expect(()=>read(input)).toThrow(error)
  }
})
it('pages original sequences and global counts with namespace pairing and empty/deep pages',()=>{
  for(const queryId of [11,12,21,22,23,24])for(const page of [1,2,3,Number.MAX_SAFE_INTEGER]) {
    const input={queryId,field:'relations' as const,page,pageSize:1}
    expect(read(input)).toEqual(readPlatformQueryEvidence(f.old,input))
  }
  for(const input of [{queryId:1,relationId:1},{queryId:11,relationId:21},{queryId:22,relationId:21},{queryId:999,relationId:999}])
    expect(()=>read({...input,field:'relation'})).toThrowError(expect.objectContaining({statusCode:404}))
  for(const invalid of [{queryId:0},{queryId:1.5},{offset:-1},{length:0},{length:65537},{pageSize:201},{page:0},{offset:Number.MAX_SAFE_INTEGER},{queryId:Number.MAX_SAFE_INTEGER+1}])
    expect(()=>read({queryId:11,field:'rawResponse',...invalid})).toThrowError(expect.objectContaining({statusCode:400}))
  expect(()=>read({queryId:11,field:'relation'})).toThrowError(expect.objectContaining({statusCode:400}))
})
it('reads fresh assignment attribution without changing any immutable source fields or archives',()=>{
  const input={queryId:11,relationId:1,field:'relation' as const}
  const before=read(input), archives=f.t.prepare('SELECT id,sha256,byte_length,hex(bytes) bytes FROM platform_archive_value ORDER BY id').all()
  const original=f.db.select().from(s.platformObservationAssignment).where(eq(s.platformObservationAssignment.observationId,1)).get()!
  f.db.insert(s.platformObservationAssignment).values({...original,revision:2,enterpriseId:2,matchBasis:'manual',verificationStatus:'confirmed',origin:'command',actor:{type:'agent',id:'test'},basis:'correct',nameRaw:'Different',usccRaw:'Changed'}).run()
  const after=read(input)
  if(typeof before.data!=='string'||typeof after.data!=='string')throw new Error('chunks expected')
  const expected=Buffer.from(before.data,'base64').toString().replace('"enterpriseId":1','"enterpriseId":2').replace('"matchBasis":"none"','"matchBasis":"manual"').replace('"verificationStatus":"pending"','"verificationStatus":"confirmed"')
  expect(Buffer.from(after.data,'base64').toString()).toBe(expected)
  expect(f.t.prepare('SELECT id,sha256,byte_length,hex(bytes) bytes FROM platform_archive_value ORDER BY id').all()).toEqual(archives)
})
it('new three-source writers seal complete original DTO snapshots with external aliases',()=>{
  const oracle=new Database(':memory:');migrate(drizzle(oracle),{migrationsFolder:'db/migrations'})
  vi.useFakeTimers();vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
  f.t.exec("UPDATE platform_legacy_alias_sequence SET high_water=500 WHERE namespace='relation'")
  try {
  for(const [collectionId,writer] of [[21,writeApplyTarget],[11,writeProcessTarget],[22,writeRecognizedTarget]] as const){
    const row={sequenceNo:20,relationKey:'new',nameRaw:'Original',rawFields:{id:'new',rdjb:'2'},sourceText:'new source'}
    const result=writer(f.db,{collectionId,position:{sequenceNo:20,positionState:'unknown'},row,assignment:{nameRaw:'Original',origin:'command',matchBasis:'none',verificationStatus:'pending',actor:{type:'agent',id:'test'},basis:'explicit'}})
    const chunk=read({queryId:collectionId,relationId:result.relationAlias,field:'relation'})
    if(typeof chunk.data!=='string')throw new Error('chunk expected')
    expect(result.relationAlias).not.toBe(result.observationId)
    oracle.prepare("INSERT OR IGNORE INTO platform_query(id,interface,query_key,rdjb,queried_at,status,created_at) VALUES(?,'apply_list',?,'2','t','success','c')").run(collectionId,String(collectionId))
    oracle.prepare("INSERT INTO platform_relation(id,query_id,sequence_no,relation_key,name_raw,raw_fields,source_text,created_at) VALUES(?,?,20,'new','Original',?, 'new source','2026-01-01T00:00:00.000Z')").run(result.relationAlias,collectionId,JSON.stringify(row.rawFields))
    expect(chunk).toEqual(readPlatformQueryEvidence(drizzle(oracle,{schema:legacySchema}),{queryId:collectionId,relationId:result.relationAlias,field:'relation'}))
    expect(Buffer.from(chunk.data,'base64').toString()).toContain('"nameRaw":"Original"')
    expect(Buffer.from(chunk.data,'base64').toString()).toContain('"id":'+result.relationAlias+',"queryId":'+collectionId)
  }
  } finally {vi.useRealTimers();oracle.close()}
})
it('target SQL never reads retired query/relation entities',()=>{
  f.statements.length=0
  read({queryId:21,relationId:21,field:'relation'});read({queryId:11,field:'relations'});read({queryId:24,field:'rawResponse'})
  expect(f.statements.filter(q=>/\b(?:platform_query|platform_relation)\b/i.test(q))).toEqual([])
})

it('fails closed for the accepted migration absence of a sealed provenance binding (737 blocker)',()=>{
  expect(readPlatformQueryEvidence(f.old,{queryId:23,field:'legacyProvenance'})).toMatchObject({isNull:true,totalBytes:0})
  expect(()=>read({queryId:23,field:'legacyProvenance'})).toThrow('Missing sealed collection archive')
  expect(f.t.prepare("SELECT * FROM platform_collection_archive_ref WHERE owner_id=23 AND field='legacyProvenance'").all()).toEqual([])
})

it('decodes only the archived provenance collection cell and returns its original bytes',()=>{
  for(const offset of [0,1,3,20,999]) {
    const input={queryId:21,field:'legacyProvenance' as const,offset,length:3}
    expect(read(input)).toEqual(readPlatformQueryEvidence(f.old,input))
  }
})

it('rejects missing or unsealed archive bindings and missing assignments without synthesizing source fields',()=>{
  for(const corruption of ['snapshot','unsealed','assignment']) {
    expect(()=>f.db.transaction(()=>{
      const triggers=f.t.prepare("SELECT name FROM sqlite_schema WHERE type='trigger' AND tbl_name IN ('platform_observation_archive_ref','platform_observation_assignment')").all() as {name:string}[]
      for(const {name} of triggers)f.t.exec('DROP TRIGGER "'+name.replaceAll('"','""')+'"')
      if(corruption==='snapshot')f.t.exec("DELETE FROM platform_observation_archive_ref WHERE owner_id=1 AND field='legacyRowSnapshot'")
      if(corruption==='unsealed')f.t.exec("UPDATE platform_observation_archive_ref SET sealed=0 WHERE owner_id=1")
      if(corruption==='assignment')f.t.exec('DELETE FROM platform_observation_assignment WHERE observation_id=1')
      read({queryId:11,relationId:1,field:'relation'})
    })).toThrow(/Missing/)
  }
})
