import { finalEvidenceFixture } from '../../helpers/final-evidence-fixture'
import { createHash } from 'node:crypto'
import { platformResultToImport } from '../../../lib/platform/recognized-evidence'
import type { PlatformLiveQueryResult } from '../../../lib/platform/live-query'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import * as legacySchema from '../../../upgrade/legacy-schema'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { processReaderFixture } from '../../helpers/process-target-734'
import { readPlatformQueryEvidence } from '../../helpers/legacy-evidence-oracle'
import { writeNewCollectionTarget } from '../../../lib/platform/collection-target-command'
import { targetSchema as s } from '../../../lib/platform/target-schema'
import { eq } from 'drizzle-orm'
import { readTargetPlatformEvidence } from '../../../lib/platform/target-evidence-read'
let f: ReturnType<typeof finalEvidenceFixture<Awaited<ReturnType<typeof processReaderFixture>>>>
beforeAll(async()=>{ f=finalEvidenceFixture(await processReaderFixture(true,old=>{
  old.exec(`INSERT INTO platform_query(id,interface,query_key,rdjb,queried_at,status,raw_response,created_at) VALUES
    (21,'apply_list','apply','2','t','success','','c'),(22,'recognized_list','recognized','2','t','success',NULL,'c'),
    (23,'apply_list','failed','2','t','failed',NULL,'c'),(24,'apply_list','empty','2','t','no_record',NULL,'c');
    INSERT INTO platform_relation(id,query_id,sequence_no,raw_fields,created_at) VALUES
    (21,21,1,'{ "n":1.00,"n":2,"u":"🙂" }','c'),(22,22,1,NULL,'c'),(23,22,4,'broken','c');
    UPDATE platform_query SET raw_response=CAST(X'00FF0102' AS BLOB) WHERE id=24;`)
  old.exec("INSERT INTO import_batch(id,idempotency_key,source_kind,source_identity,created_at) VALUES(1,'test','platform_archive','fixture','created')")
  old.prepare("INSERT INTO platform_query_legacy_provenance(query_id,source_identity,source_sha256,segment_index,collection,input_fingerprint,import_batch_id,created_at) VALUES(21,'original',?,0,?,'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',1,'c')").run('a'.repeat(64),'{ \"source\":\"queryList\", \"raw\":\"行🙂\\n\" }')
  old.prepare("INSERT INTO platform_query_legacy_provenance(query_id,source_identity,source_sha256,segment_index,collection,input_fingerprint,import_batch_id,created_at) VALUES(13,'both',?,1,?,'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',1,'c')").run('a'.repeat(64),'broken supplement')
  old.prepare('UPDATE platform_query SET raw_response=? WHERE id=11').run('x'.repeat(65535)+'🙂尾')
})) })
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
let newApply: {queryId:number;observationId:number;relationAlias:number}
it('new three-source writers seal complete original DTO snapshots with external aliases',()=>{
  const oracle=new Database(':memory:');migrate(drizzle(oracle),{migrationsFolder:'db/migrations'})
  vi.useFakeTimers();vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
  f.t.exec("UPDATE platform_legacy_alias_sequence SET high_water=500 WHERE namespace='relation'")
  try {
   for(const source of ['apply_list','business_list','recognized_list'] as const){
    const raw={id:'new-'+source,rdjb:'2',qymc:'Original'}
    const row={sequenceNo:1,relationKey:raw.id,nameRaw:'Original',rawFields:raw,sourceText:'new source'}
    let query:any={interface:source,queryKey:'new-'+source,rdjb:'2',queriedAt:'t',status:'success',rawResponse:'new raw',relations:[row]}
    if(source==='recognized_list'){
      const evidence:PlatformLiveQueryResult={source:'queryBusList',status:'success',effectiveConditions:{name:'Original',combination:'and'},titleScope:{mode:'selected',rdjb:['2']},queriedAt:'2026-01-01T00:00:00Z',completedAt:'2026-01-01T00:01:00Z',rows:[raw],dataRows:[raw],pages:[{source:'queryBusList',rdjb:'2',page:1,maxPage:1,status:'success',fetchedCount:1,declaredTotal:1,error:null}],fetchedCount:1,declaredTotal:1,completeness:'complete',fullRange:true,unfinished:[],error:null,limits:{maxRequests:1,maxRows:50,maxDurationMs:1000,pageSize:50}}
      query={...platformResultToImport(evidence),relations:[row]}
    }
    const written=writeNewCollectionTarget(f.db,{queryText:JSON.stringify(query),evidenceText:query.collectionEvidence?JSON.stringify(query.collectionEvidence):null,createdAt:'c',assignments:[{nameRaw:'Original',origin:'command',matchBasis:'none',verificationStatus:'pending',actor:{type:'agent',id:'test'},basis:'explicit'}]})
    const result=written.observations[0]!,collectionId=written.queryAlias
    if(source==='apply_list')newApply={queryId:collectionId,observationId:result.observationId,relationAlias:result.relationAlias}
    const chunk=read({queryId:collectionId,relationId:result.relationAlias,field:'relation'})
    if(typeof chunk.data!=='string')throw new Error('chunk expected')
    expect(result.relationAlias).not.toBe(result.observationId)
    oracle.prepare("INSERT INTO platform_query(id,interface,query_key,rdjb,queried_at,status,created_at) VALUES(?, ?,?,'2','t','success','c')").run(collectionId,source,String(collectionId))
    oracle.prepare("INSERT INTO platform_relation(id,query_id,sequence_no,relation_key,name_raw,raw_fields,title_raw,source_text,created_at) VALUES(?,?,1,?,'Original',?,'2', 'new source','2026-01-01T00:00:00.000Z')").run(result.relationAlias,collectionId,raw.id,JSON.stringify(raw))
    expect(chunk).toEqual(readPlatformQueryEvidence(drizzle(oracle,{schema:legacySchema}),{queryId:collectionId,relationId:result.relationAlias,field:'relation'}))
    expect(Buffer.from(chunk.data,'base64').toString()).toContain('"nameRaw":"Original"')
    expect(Buffer.from(chunk.data,'base64').toString()).toContain('"id":'+result.relationAlias+',"queryId":'+collectionId)
   }
  } finally {vi.useRealTimers();oracle.close()}
})
it('target SQL never reads retired query/relation entities',()=>{
  f.statements.length=0
  read({queryId:21,relationId:21,field:'relation'});read({queryId:11,field:'relations'});read({queryId:24,field:'rawResponse'});read({queryId:23,field:'legacyProvenance'})
  expect(f.statements.filter(q=>/\b(?:from|join)\s+["`]?platform_(?:query|relation)["`]?(?:\s|$)/i.test(q))).toEqual([])
})

it('returns legacy SQL NULL for legally absent T04 provenance after complete source migration and sealing',()=>{
  for(const queryId of [11,12,22,23,24])for(const offset of [0,7,65536]) {
    const input={queryId,field:'legacyProvenance' as const,offset,length:3}
    expect(read(input)).toEqual(readPlatformQueryEvidence(f.old,input))
  }
  expect(f.t.prepare("SELECT * FROM platform_collection_archive_ref WHERE owner_id=23 AND field='legacyProvenance'").all()).toEqual([])
})

it('decodes only the archived provenance collection cell and returns its original bytes',()=>{
  for(const queryId of [21,13])for(const offset of [0,1,3,20,999]) {
    const input={queryId,field:'legacyProvenance' as const,offset,length:3}
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

it('resolves external query aliases independently of target collection IDs and rejects target integers',()=>{
  f.t.exec("UPDATE platform_legacy_alias_sequence SET high_water=900 WHERE namespace='query'")
  const result=writeNewCollectionTarget(f.db,{queryText:JSON.stringify({interface:'apply_list',queryKey:'alias-only',rdjb:'2',queriedAt:'t',status:'no_record',rawResponse:'x'}),evidenceText:null,createdAt:'c',assignments:[]})
  expect(result.queryAlias).toBe(901)
  expect(result.collectionId).not.toBe(result.queryAlias)
  expect(read({queryId:result.queryAlias,field:'rawResponse'})).toMatchObject({data:'eA==',totalBytes:1})
  expect(()=>read({queryId:result.collectionId,field:'rawResponse'})).toThrowError(expect.objectContaining({statusCode:404}))
})

// Adversarial mutations are confined to an enclosing rolled-back synthetic transaction.
function withCorruption(mutate:()=>void,assertion:()=>void) {
  const rollback=Symbol('synthetic rollback')
  try {f.db.transaction(()=>{
    for(const {name} of f.t.prepare("SELECT name FROM sqlite_schema WHERE type='trigger' AND tbl_name IN ('platform_collection_archive_ref','platform_observation_archive_ref','platform_runtime_capability')").all() as {name:string}[])
      f.t.exec('DROP TRIGGER "'+name.replaceAll('"','""')+'"')
    mutate();assertion();throw rollback
  })}catch(error){if(error!==rollback)throw error}
}
it('rejects deleted present provenance for both supplement-only and conflict T04 sources instead of returning NULL',()=>{
  for(const queryId of [21,13]) {
    expect(readPlatformQueryEvidence(f.old,{queryId,field:'legacyProvenance'})).toMatchObject({isNull:false})
    withCorruption(()=>{f.t.prepare("DELETE FROM platform_collection_archive_ref WHERE owner_id=? AND field='legacyProvenance'").run(queryId)},()=>{
      expect(()=>read({queryId,field:'legacyProvenance'})).toThrow('Contradictory T04 provenance lifecycle')
    })
  }
})
it('rejects partial or singly sealed T04 sets, contradictory metadata, unknown lifecycle and incomplete receipts',()=>{
  const mutations=[
    "DELETE FROM platform_collection_archive_ref WHERE owner_id=23 AND field='rawResponse'",
    "DELETE FROM platform_collection_archive_ref WHERE owner_id=23 AND field='collectionEvidence'",
    "UPDATE platform_collection_archive_ref SET sealed=0 WHERE owner_id=23 AND field='rawResponse'",
    "UPDATE platform_collection_archive_ref SET sealed=0 WHERE owner_id=23",
    "UPDATE platform_collection SET provenance_state='legacy_supplement' WHERE id=23",
    "UPDATE platform_collection SET parse_state='invalid' WHERE id=23",
    "UPDATE platform_collection SET rule_version='unrecognized' WHERE id=23",
    "UPDATE platform_migration_run SET state='running' WHERE transform_version='collection-legacy-provenance-v1'",
  ]
  for(const mutation of mutations)withCorruption(()=>f.t.exec(mutation),()=>{
    expect(()=>read({queryId:23,field:'legacyProvenance'})).toThrow(/Incomplete|incomplete|Contradictory|Unknown|Missing completed/)
  })
})
it('returns independent old SQL NULL for complete new command lifecycle and rejects damaged command capture',()=>{
  const result=writeNewCollectionTarget(f.db,{queryText:JSON.stringify({interface:'apply_list',queryKey:'absence-command',rdjb:'2',queriedAt:'t',status:'no_record',rawResponse:''}),evidenceText:null,createdAt:'c',assignments:[]})
  const oracle=new Database(':memory:');migrate(drizzle(oracle),{migrationsFolder:'db/migrations'})
  try {
    oracle.prepare("INSERT INTO platform_query(id,interface,query_key,rdjb,queried_at,status,raw_response,created_at) VALUES(?,'apply_list','absence-command','2','t','no_record','','c')").run(result.queryAlias)
    for(const offset of [0,7,65536]) {
      const input={queryId:result.queryAlias,field:'legacyProvenance' as const,offset,length:3}
      expect(read(input)).toEqual(readPlatformQueryEvidence(drizzle(oracle,{schema:legacySchema}),input))
    }
    for(const field of ['request','rawResponse','collectionEvidence']) {
      withCorruption(()=>{f.t.prepare('DELETE FROM platform_collection_archive_ref WHERE owner_id=? AND field=?').run(result.collectionId,field)},()=>{
        expect(()=>read({queryId:result.queryAlias,field:'legacyProvenance'})).toThrow('Incomplete command provenance field set')
      })
      withCorruption(()=>{f.t.prepare('UPDATE platform_collection_archive_ref SET sealed=0 WHERE owner_id=? AND field=?').run(result.collectionId,field)},()=>{
        expect(()=>read({queryId:result.queryAlias,field:'legacyProvenance'})).toThrow('Incomplete sealed provenance owner')
      })
    }
    for(const request of [null,'broken JSON',JSON.stringify({interface:'apply_list',queryKey:'another',queriedAt:'t',rawResponse:''}),JSON.stringify({interface:'apply_list',queryKey:'absence-command',rdjb:'2',queriedAt:'t',reuseExisting:true,rawResponse:''})])
      withCorruption(()=>{
        const bytes=request===null?null:Buffer.from(request)
        const value=f.db.insert(s.platformArchiveValue).values({storageClass:bytes===null?'null':'text',bytes,byteLength:bytes?.length??null,sha256:bytes===null?null:createHash('sha256').update(bytes).digest('hex'),createdAt:null}).returning().get()
        f.t.prepare("UPDATE platform_collection_archive_ref SET archive_id=? WHERE owner_id=? AND field='request'").run(value.id,result.collectionId)
      },()=>{expect(()=>read({queryId:result.queryAlias,field:'legacyProvenance'})).toThrow(/Missing original|Untrusted original|Contradictory original/)})
    for(const mutation of ["provenance_state='legacy_supplement'","parse_state='valid'","rule_version='future-command'"])
      withCorruption(()=>f.t.exec('UPDATE platform_collection SET '+mutation+' WHERE id='+result.collectionId),()=>{
        expect(()=>read({queryId:result.queryAlias,field:'legacyProvenance'})).toThrow(/Contradictory|Unknown/)
      })
  }finally{oracle.close()}
})
it('keeps pre-snapshot target-command observation inventory explicitly unsupported without online repair',()=>{
  const queryId=newApply.queryId,observation={id:newApply.observationId},alias={oldId:newApply.relationAlias}
  withCorruption(()=>{f.t.prepare("DELETE FROM platform_observation_archive_ref WHERE owner_id=? AND field='legacyRowSnapshot'").run(observation.id)},()=>{
    // Models the exact two-field inventory emitted by the accepted pre-H1a writer (base363d0b50).
    const inventory=f.t.prepare('SELECT field,sealed,archive_id FROM platform_observation_archive_ref WHERE owner_id=? ORDER BY field').all(observation.id)
    expect(inventory).toEqual([expect.objectContaining({field:'rawFields',sealed:1}),expect.objectContaining({field:'sourceText',sealed:1})])
    expect(()=>read({queryId,relationId:alias.oldId,field:'relation'})).toThrow('Missing sealed original relation snapshot')
    expect(f.t.prepare('SELECT field,sealed,archive_id FROM platform_observation_archive_ref WHERE owner_id=? ORDER BY field').all(observation.id)).toEqual(inventory)
  })
})

it.each(['queryList','businessList','queryBusList'] as const)('returns old SQL NULL for complete %s command with original captured evidence',source=>{
  const evidence:PlatformLiveQueryResult={source,status:'no_record',effectiveConditions:source==='businessList'?{uscc:'91330200712345678A',combination:'and'}:{name:'No rows',combination:'and'},titleScope:{mode:source==='queryList'?'source_default':'selected',rdjb:source==='queryList'?[]:['2']},queriedAt:'2026-11-11T00:00:00Z',completedAt:'2026-11-11T00:01:00Z',rows:[],dataRows:[],pages:[{source,rdjb:source==='queryList'?null:'2',page:1,maxPage:1,status:'success',fetchedCount:0,declaredTotal:0,error:null}],fetchedCount:0,declaredTotal:0,completeness:'complete',fullRange:true,unfinished:[],error:null,limits:{maxRequests:1,maxRows:50,maxDurationMs:1000,pageSize:50}}
  const query=platformResultToImport(evidence)
  const result=writeNewCollectionTarget(f.db,{queryText:JSON.stringify(query),evidenceText:JSON.stringify(evidence),createdAt:'c',assignments:[]})
  const oracle=new Database(':memory:');migrate(drizzle(oracle),{migrationsFolder:'db/migrations'})
  try {
    oracle.prepare("INSERT INTO platform_query(id,interface,query_key,rdjb,queried_at,status,created_at) VALUES(?,?,'query','2','t','no_record','c')").run(result.queryAlias,query.interface)
    const input={queryId:result.queryAlias,field:'legacyProvenance' as const}
    expect(read(input)).toEqual(readPlatformQueryEvidence(drizzle(oracle,{schema:legacySchema}),input))
    expect(f.t.prepare('SELECT field,sealed FROM platform_collection_archive_ref WHERE owner_id=? ORDER BY field').all(result.collectionId)).toEqual([{field:'collectionEvidence',sealed:1},{field:'rawResponse',sealed:1},{field:'request',sealed:1}])
    f.statements.length=0;read(input)
    expect(f.statements.filter(q=>/\b(?:from|join)\s+["`]?platform_(?:query|relation)["`]?(?:\s|$)/i.test(q))).toEqual([])
  }finally{oracle.close()}
})
