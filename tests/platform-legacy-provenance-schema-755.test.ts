import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { beforeAll, beforeEach, afterAll, expect, it } from 'vitest'
import * as schema from '../upgrade/legacy-schema'
import { targetSchema } from '../lib/platform/target-schema'
import { processReaderFixture } from './helpers/process-target-734'
import { transferCorrespondence } from '../upgrade/correspondence'
import { transferDifferenceReferences } from '../upgrade/difference-references'
import { indexLegacyProvenance } from '../upgrade/legacy-provenance'
import { installLegacyProvenance } from '../upgrade/legacy-provenance-schema'
import { requireLegacyProvenanceReady } from '../lib/platform/legacy-provenance-catalog'
import { legacyPlatformProvenanceSchema } from '../lib/platform/legacy-provenance'
import { allocateLegacyAlias, bindArchive, sealArchiveOwner, insertArchiveValue, reserveLegacyIds } from '../upgrade/frozen/target-archive'
import { writeNewCollectionTarget } from '../upgrade/frozen/collection-target-command'

let f: Awaited<ReturnType<typeof processReaderFixture>>, source:string, target:string
let caseNumber=0
let normal: ReturnType<typeof writeNewCollectionTarget>
const sha = 'a'.repeat(64), fingerprint = 'b'.repeat(64)
const originalCollection = ' { "source":"businessList", "pages":[], "rows":[], "text":"尾\\u0000行\\n😀" } \n'
function batch(t:Database.Database,key:string) {
  return drizzle(t,{schema}).insert(schema.importBatch).values({idempotencyKey:key,sourceKind:'platform_archive',sourceIdentity:' original ',status:'committed',createdAt:'c',committedAt:'t'}).returning().get().id
}
function ordinary(t:Database.Database,key:string) {
  return writeNewCollectionTarget(drizzle(t,{schema:targetSchema}),{queryText:JSON.stringify({interface:'business_list',queryKey:key,rdjb:'2',queriedAt:'2026-11-13',status:'no_record',rawResponse:' original response ',relations:[]}),evidenceText:null,assignments:[],createdAt:'c'})
}
/** Lawful low-level typed owners only. S does not admit the W command on 71613. */
function syntheticOrdinaryOwner(t:Database.Database) {
  const db=drizzle(t,{schema:targetSchema})
  return db.transaction(tx=>{
    const collectionId=tx.insert(schema.platformCollection).values({interface:'business_list',queryKey:'9133020078041158X6',rdjb:'2',titleCode:'specialized_sme',queriedAt:'2026-11-13T00:00:00Z',createdAt:'c',status:'no_record',completeness:'unknown',provenanceState:'unknown',parseState:'absent',ruleVersion:'w4a-new-collection-v1'}).returning().get().id
    const queryText=JSON.stringify({interface:'business_list',queryKey:'9133020078041158X6',rdjb:'2',titleCode:'specialized_sme',queriedAt:'2026-11-13T00:00:00Z',status:'no_record',rawResponse:' original response ',relations:[]})
    for(const [field,bytes] of [['request',Buffer.from(queryText)],['rawResponse',Buffer.from(' original response ')],['collectionEvidence',null]] as const) {
      const archiveId=insertArchiveValue(tx,bytes===null?{storageClass:'null',bytes:null,createdAt:'c'}:{storageClass:'text',bytes,createdAt:'c'})
      bindArchive(tx,{kind:'collection',ownerId:collectionId,field,archiveId})
    }
    for(const name of ['name','uscc','combination','sqsj','rddqrq','whpcyear','whpc','szq','orderField','orderDirection'] as const) tx.insert(schema.platformCollectionCondition).values({collectionId,name,valueKind:'absent'}).run()
    tx.insert(targetSchema.platformQueryTitleScopeError).values({collectionId}).run()
    sealArchiveOwner(tx,{kind:'collection',ownerId:collectionId})
    const queryAlias=allocateLegacyAlias(tx,{kind:'query',collectionId})
    return {collectionId,queryAlias}
  })
}
/** Independent SQLite oracle uses complete PK, storage class and bytes, no new parser. */
function cells(t:Database.Database,table:string,where='') {
  const fields=t.prepare(`PRAGMA table_info("${table}")`).all() as {name:string;pk:number}[]
  const pk=fields.filter(x=>x.pk).sort((a,b)=>a.pk-b.pk).map(x=>`"${x.name}"`).join(',')||'rowid'
  return t.prepare(`SELECT ${fields.flatMap(c=>[`typeof("${c.name}") AS "type_${c.name}"`,`hex(cast("${c.name}" AS blob)) AS "hex_${c.name}"`]).join(',')} FROM "${table}" ${where} ORDER BY ${pk}`).all()
}
function complete(runId='s755') { return indexLegacyProvenance({source,target,runId,batchSize:1}) }
beforeAll(async()=>{
  f=await processReaderFixture(false,old=>{
    const id=batch(old,'original755')
    const insert=old.prepare('INSERT INTO platform_query_legacy_provenance VALUES(?,?,?,?,?,?,?,?)')
    insert.run(11,' 源\u0000😀\n ',sha,0,originalCollection,fingerprint,id,' 时\u0000间 ')
    insert.run(12,'x'.repeat(2000),'c'.repeat(64),Number.MAX_SAFE_INTEGER,Buffer.from('{"rows":[],"pages":[]}'),fingerprint,id,'')
    const db=drizzle(old,{schema})
    db.insert(schema.differenceReason).values({id:101,enterpriseId:1,titleCode:'specialized_sme',direction:'missing_in_miit',status:'needs_review',evidenceQueryId:11,evidenceRelationId:1,requestHash:' old hash ',basis:' { "queryId":11 } ',recordedAt:'t'}).run()
    old.exec(`INSERT INTO evidence_revision_113(id,source_kind,source_key,source_version,coverage_digest,fact_digest,coverage_changed,fact_changed,metadata,max_decision_id,created_at) VALUES(11,'platform','old','v','hash1','hash2',1,1,' { "queryId":11 } ',101,' old time ');
      INSERT INTO evidence_impact_progress_113 VALUES(11,101,1);
      INSERT INTO explanation_impact_113(id,enterprise_id,title_code,direction,decision_id,latest_revision_id,pending_since_revision_id,classification) VALUES(12,1,'specialized_sme','missing_in_miit',101,11,11,'review');
      INSERT INTO evidence_review_receipt_114(id,idempotency_key,request_hash,kind,enterprise_id,title_code,direction,decision_id,source_decision_id,reviewed_revision_id,actor,basis,response,recorded_at)
      VALUES(13,'old755',' old hash ','review',1,'specialized_sme','missing_in_miit',101,101,11,' { "type":"agent" } ',' 原始 ',' { "queryId":11 } ',' time ');`)
    db.insert(schema.importReceipt).values({batchId:id,operation:'commit',requestHash:' frozen ',requestBody:' { "source":"old" } ',status:'committed',summary:{written:2},createdAt:'c',completedAt:'t'}).run()
  })
  reserveLegacyIds(f.db,{query:8000,relation:9000})
  normal=writeNewCollectionTarget(f.db,{
    queryText:JSON.stringify({interface:'business_list',queryKey:'normal-without-provenance',rdjb:'2',queriedAt:'2026-11-13',status:'success',rawResponse:' original response ',relations:[{sequenceNo:1,relationKey:'normal755',enterpriseId:1,nameRaw:'Alpha',rawFields:{id:'normal755',rdjb:'2',cszt:'pending'}}]}),
    evidenceText:null,createdAt:'c',
    assignments:[{enterpriseId:1,nameRaw:'Alpha',matchBasis:'none',verificationStatus:'pending',origin:'command',actor:{type:'agent',id:'755'},basis:'normal source'}],
  })
  f.close()
  const s10=join(f.root,'fixed71610.sqlite'),s11=join(f.root,'fixed71611.sqlite')
  copyFileSync(f.target,s10);copyFileSync(s10,s11)
  transferCorrespondence({source:s10,target:s11,runId:'correspondence755'})
  source=join(f.root,'fixed71612.sqlite');copyFileSync(s11,source)
  transferDifferenceReferences({source:s11,target:source,runId:'difference755'})
  target=join(f.root,'target71613.sqlite')
})
beforeEach(context=>{
  target=join(f.root,`case-${++caseNumber}-71613.sqlite`)
  copyFileSync(source,target)
  writeFileSync(join(f.root,`case-${caseNumber}.json`),JSON.stringify({test:context.task.name,source,target},null,2)+'\n')
})
afterAll(()=>{ /* Raw owned fixture is retained for archive/readback, never deleted by tests. */ })

it('runs readonly preflight and actual CLI after populated schema0 full pipeline preserving original eight cells aliases all PK bytes refs and histories',()=>{
  const sourceBytes=readFileSync(source),before=readFileSync(target)
  const preflight=execFileSync(process.execPath,['upgrade/run-legacy-provenance.mjs',source,target,join(f.root,'preflight755'),'cli755','--preflight'],{encoding:'utf8'})
  expect(JSON.parse(preflight)).toEqual({state:'ready',rows:2,version:71613})
  expect(readFileSync(target)).toEqual(before)
  const output=execFileSync(process.execPath,['upgrade/run-legacy-provenance.mjs',source,target,join(f.root,'cli755'),'cli755'],{encoding:'utf8'})
  expect(JSON.parse(output)).toEqual({state:'complete',rows:2,version:71613})
  const old=new Database(f.legacySource,{readonly:true}),s=new Database(source,{readonly:true}),t=new Database(target)
  try {
    const metadata=t.prepare('SELECT * FROM platform_collection_legacy_provenance ORDER BY collection_id').all()
    const refs=t.prepare("SELECT owner_id,archive_id FROM platform_collection_archive_ref WHERE field='legacyProvenance' ORDER BY owner_id").all() as {owner_id:number;archive_id:number}[]
    expect(metadata).toEqual([
      {collection_id:11,origin:'t04_envelope',source_identity:' 源\u0000😀\n ',source_sha256:sha,segment_index:0,input_fingerprint:fingerprint,import_batch_id:1,created_at:' 时\u0000间 ',archive_id:refs[0]!.archive_id},
      {collection_id:12,origin:'t04_envelope',source_identity:'x'.repeat(2000),source_sha256:'c'.repeat(64),segment_index:Number.MAX_SAFE_INTEGER,input_fingerprint:fingerprint,import_batch_id:1,created_at:'',archive_id:refs[1]!.archive_id},
    ])
    expect(normal.queryAlias).toBe(8001);expect(normal.collectionId).not.toBe(normal.queryAlias)
    expect(normal.observations[0]!.relationAlias).toBe(9001);expect(normal.observations[0]!.observationId).not.toBe(9001)
    expect(t.prepare('SELECT collection_id FROM platform_collection_legacy_provenance WHERE collection_id IN (?,13)').all(normal.collectionId)).toEqual([])
    // Independent envelope construction directly from schema0 SQLite storage cells.
    for(const id of [11,12]) {
      const names=['query_id','source_identity','source_sha256','segment_index','collection','input_fingerprint','import_batch_id','created_at']
      const chunks:Buffer[]=[Buffer.from('T04-PROVENANCE\n')]
      for(const name of names) {
        const cell=old.prepare(`SELECT typeof("${name}") kind,cast("${name}" AS blob) bytes FROM platform_query_legacy_provenance WHERE query_id=?`).get(id) as {kind:string;bytes:Buffer}
        chunks.push(Buffer.from(`${name} ${cell.kind} ${cell.bytes.length}\n`),cell.bytes,Buffer.from('\n'))
      }
      const archive=t.prepare("SELECT bytes FROM platform_archive_value WHERE id=(SELECT archive_id FROM platform_collection_archive_ref WHERE owner_id=? AND field='legacyProvenance')").get(id) as {bytes:Buffer}
      expect(archive.bytes).toEqual(Buffer.concat(chunks))
    }
    const tables=s.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as {name:string}[]
    for(const {name} of tables) expect(cells(t,name,['platform_migration_run','platform_migration_checkpoint'].includes(name)?"WHERE run_id<>'cli755'":''),name).toEqual(cells(s,name))
    for(const name of ['platform_query_legacy_provenance','evidence_revision_113','evidence_impact_progress_113','explanation_impact_113','evidence_review_receipt_114','import_batch','import_receipt']) expect(cells(t,name),name).toEqual(cells(old,name))
    const catalog="SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY type,name"
    const oldCatalog=s.prepare(catalog).all() as {name:string}[]
    const oldNames=new Set(oldCatalog.map(r=>r.name))
    expect((t.prepare(catalog).all() as {name:string}[]).filter(r=>oldNames.has(r.name))).toEqual(oldCatalog)
    expect(t.pragma('foreign_key_check')).toEqual([]);expect(t.pragma('integrity_check')).toEqual([{integrity_check:'ok'}])
    expect(t.pragma('foreign_key_list(platform_collection_legacy_provenance)')).toEqual(expect.arrayContaining(['platform_collection','import_batch','platform_archive_value'].map(table=>expect.objectContaining({table,on_delete:'RESTRICT'}))))
    expect(t.prepare("SELECT name FROM sqlite_schema WHERE type='index' AND tbl_name='platform_collection_legacy_provenance'").all()).toHaveLength(2)
    expect(()=>requireLegacyProvenanceReady(t)).not.toThrow()
    expect(old.pragma('user_version',{simple:true})).toBe(0)
  } finally {old.close();s.close();t.close()}
  expect(readFileSync(source)).toEqual(sourceBytes)
})
it.each(['schema','batch','promotion'] as const)('rolls back atomic %s and checkpoint then retries the same run',stage=>{
  let calls=0
  expect(()=>indexLegacyProvenance({source,target,runId:'fault755',batchSize:1,beforeCommit:at=>{if(at===stage && ++calls===(stage==='batch'?2:1)) throw new Error('injected transaction failure')}})).toThrow('injected transaction failure')
  const t=new Database(target)
  try {
    expect(t.pragma('foreign_keys',{simple:true})).toBe(1);expect(t.pragma('user_version',{simple:true})).toBe(71612)
    if(stage==='schema') { expect(t.prepare("SELECT 1 FROM sqlite_schema WHERE name='platform_collection_legacy_provenance'").get()).toBeUndefined() }
    else {
      expect(t.prepare('SELECT count(*) n FROM platform_collection_legacy_provenance').get()).toEqual({n:stage==='batch'?1:2})
      expect(t.prepare("SELECT copied_count FROM platform_migration_checkpoint WHERE run_id='fault755'").get()).toEqual({copied_count:stage==='batch'?1:2})
      expect(t.prepare("SELECT state FROM platform_migration_run WHERE run_id='fault755'").get()).toEqual({state:'running'})
    }
    expect(t.pragma('foreign_key_check')).toEqual([])
  } finally {t.close()}
  copyFileSync(target,target+'.after-failure.sqlite')
  expect(complete('fault755')).toEqual({state:'complete',rows:2,version:71613})
})
it('retains normal new collection synthetic lawful supplement and receipt byte for byte on completed replay',()=>{
  complete('replay755')
  const t=new Database(target),db=drizzle(t,{schema:targetSchema})
  try {
    expect(()=>ordinary(t,'successor-command-stays-closed')).toThrow('Explicit 71606 target required')
    const added=syntheticOrdinaryOwner(t),id=batch(t,'after755')
    const supplementText=' { "source":"businessList", "status":"no_record", "effectiveConditions":{"uscc":"9133020078041158X6","combination":"and"}, "titleScope":{"mode":"selected","rdjb":["2"]}, "queriedAt":"2026-11-13T00:00:00Z", "completedAt":"2026-11-13T00:01:00Z", "rows":[], "pages":[{"source":"businessList","rdjb":"2","page":1,"status":"success","fetchedCount":0,"declaredTotal":0,"error":null}], "fetchedCount":0, "declaredTotal":0, "completeness":"complete", "fullRange":true, "unfinished":[], "error":null, "limits":{"maxRequests":100,"maxRows":5000,"maxDurationMs":60000,"pageSize":50} } '
    // The original public schema independently proves this is a valid empty
    // supplement envelope. No W command, new parser or fingerprint oracle is used.
    expect(legacyPlatformProvenanceSchema.safeParse({queryId:added.queryAlias,interface:'business_list',queryKey:'9133020078041158X6',rdjb:'2',queriedAt:'2026-11-13T00:00:00Z',sourceIdentity:' new ',sourceSha256:'d'.repeat(64),segmentIndex:3,collection:JSON.parse(supplementText),relations:[]}).success).toBe(true)
    const archiveId=insertArchiveValue(db,{storageClass:'text',bytes:Buffer.from(supplementText),createdAt:'now'})
    db.insert(targetSchema.platformCollectionLegacyProvenance).values({collectionId:added.collectionId,origin:'supplement',sourceIdentity:' new ',sourceSha256:'d'.repeat(64),segmentIndex:3,inputFingerprint:'e'.repeat(64),importBatchId:id,createdAt:'newtime',archiveId}).run()
    db.insert(schema.importReceipt).values({batchId:id,operation:'commit',requestHash:' new hash ',requestBody:' { "synthetic":"S only" } ',status:'committed',summary:{written:1},createdAt:'new',completedAt:'new'}).run()
  } finally {t.close()}
  const bytes=readFileSync(target)
  expect(complete('replay755')).toEqual({state:'complete',rows:2,version:71613})
  expect(readFileSync(target)).toEqual(bytes)
})
it.each(['UPDATE platform_collection_legacy_provenance SET created_at=created_at WHERE collection_id=11','DELETE FROM platform_collection_legacy_provenance WHERE collection_id=11','INSERT OR REPLACE INTO platform_collection_legacy_provenance SELECT * FROM platform_collection_legacy_provenance WHERE collection_id=11'])('rejects insert-only mutation %s',statement=>{
  complete()
  const t=new Database(target),before=cells(t,'platform_collection_legacy_provenance')
  try {expect(()=>t.exec(statement)).toThrow();expect(cells(t,'platform_collection_legacy_provenance')).toEqual(before)} finally {t.close()}
})
it('enforces exact same-owner sealed T04 pointer and exclusive supplement refs and basis in both insertion directions',()=>{
  complete()
  const t=new Database(target),db=drizzle(t,{schema:targetSchema}),p=targetSchema.platformCollectionLegacyProvenance
  const base={origin:'supplement' as const,sourceIdentity:'valid',sourceSha256:'d'.repeat(64),segmentIndex:1,inputFingerprint:fingerprint,importBatchId:1,createdAt:'c'}
  try {
    const archived=t.prepare("SELECT archive_id FROM platform_collection_archive_ref WHERE owner_id=11 AND field='legacyProvenance'").get() as {archive_id:number}
    expect(()=>db.insert(p).values({...base,collectionId:13,origin:'t04_envelope',archiveId:archived.archive_id}).run()).toThrow()
    const sameBytes=insertArchiveValue(db,{storageClass:'blob',bytes:(t.prepare('SELECT bytes FROM platform_archive_value WHERE id=?').get(archived.archive_id) as {bytes:Buffer}).bytes,createdAt:null})
    expect(()=>db.insert(p).values({...base,collectionId:13,origin:'t04_envelope',archiveId:sameBytes}).run()).toThrow()
    const archiveId=insertArchiveValue(db,{storageClass:'text',bytes:Buffer.from('{"rows":[]}'),createdAt:null})
    db.insert(p).values({...base,collectionId:13,archiveId}).run()
    expect(()=>db.insert(p).values({...base,sourceSha256:'e'.repeat(64),collectionId:normal.collectionId,archiveId}).run()).toThrow('overwrite or source collision')
    for(const ref of ['platform_collection_archive_ref','platform_observation_archive_ref','platform_version_archive_ref']) {
      // A new unsealed owner field exercises each ref insert boundary; invalid metadata cannot make a collision lawful.
      expect(()=>t.prepare(`INSERT INTO ${ref}(owner_id,field,archive_id) VALUES(999,?,?)`).run(ref==='platform_collection_archive_ref'?'request':ref==='platform_observation_archive_ref'?'sourceText':'canonicalRawJson',archiveId)).toThrow('provenance archive exclusive')
    }
    expect(()=>t.prepare("INSERT INTO platform_observation_fingerprint_basis VALUES(999,'target-command-v1',?)").run(archiveId)).toThrow('provenance archive exclusive')
    expect(()=>t.prepare("INSERT INTO platform_observation_fingerprint_basis VALUES(999,'target-command-v1',?)").run(archived.archive_id)).toThrow('provenance archive exclusive')
    const basis=t.prepare('SELECT input_archive_id FROM platform_observation_fingerprint_basis WHERE input_archive_id IS NOT NULL LIMIT 1').get() as {input_archive_id:number}
    expect(()=>db.insert(p).values({...base,sourceSha256:'e'.repeat(64),collectionId:normal.collectionId,archiveId:basis.input_archive_id}).run()).toThrow()
    for(const ref of ['platform_collection_archive_ref','platform_observation_archive_ref','platform_version_archive_ref']) {
      const existing=t.prepare(`SELECT archive_id FROM ${ref} LIMIT 1`).get() as {archive_id:number}
      expect(()=>db.insert(p).values({...base,sourceSha256:'e'.repeat(64),collectionId:normal.collectionId,archiveId:existing.archive_id}).run()).toThrow()
    }
    expect(t.pragma('foreign_key_check')).toEqual([])
  } finally {t.close()}
})
it.each([
  ['source collision',{sourceSha256:sha,segmentIndex:0}],
  ['negative segment',{segmentIndex:-1}],['unsafe segment',{segmentIndex:9007199254740992}],
  ['uppercase hash',{sourceSha256:'A'.repeat(64)}],['bad fingerprint',{inputFingerprint:'bad'}],
  ['empty identity',{sourceIdentity:''}],['long identity',{sourceIdentity:'😀'.repeat(1001)}],
  ['bad batch',{importBatchId:999}],['bad owner',{collectionId:999}],['bad origin',{origin:'unknown'}],
  ['BLOB identity',{sourceIdentity:Buffer.from('x')}],['NUL hash',{sourceSha256:sha+'\u0000'}],
  ['BLOB time',{createdAt:Buffer.from('t')}],['zero owner',{collectionId:0}],['zero batch',{importBatchId:0}],
  ['interior NUL hash',{sourceSha256:'a'.repeat(32)+'\u0000'+'a'.repeat(31)}],
] as const)('rejects metadata boundary %s without a partial index row',(_name,patch)=>{
  complete()
  const t=new Database(target)
  try {
    const archive=insertArchiveValue(drizzle(t,{schema}),{storageClass:'text',bytes:Buffer.from('{}'),createdAt:null})
    const values={collectionId:13,origin:'supplement',sourceIdentity:'x',sourceSha256:'d'.repeat(64),segmentIndex:1,inputFingerprint:fingerprint,importBatchId:1,createdAt:'',archiveId:archive,...patch}
    expect(()=>t.prepare('INSERT INTO platform_collection_legacy_provenance VALUES(@collectionId,@origin,@sourceIdentity,@sourceSha256,@segmentIndex,@inputFingerprint,@importBatchId,@createdAt,@archiveId)').run(values)).toThrow()
    expect(t.prepare('SELECT count(*) n FROM platform_collection_legacy_provenance').get()).toEqual({n:2})
  } finally {t.close()}
})
it('rejects FK OFF at the schema write boundary and unknown incomplete same-file or drifted predecessor before writes',()=>{
  const t=new Database(target)
  try {
    t.pragma('foreign_keys=OFF');expect(()=>installLegacyProvenance(t)).toThrow('foreign_keys=ON')
    t.pragma('foreign_keys=ON')
    t.pragma('user_version=71613');expect(()=>requireLegacyProvenanceReady(t)).toThrow('incomplete')
  } finally {t.close()}
  const before=readFileSync(target)
  expect(()=>complete()).toThrow('Unsupported difference reference schema version')
  expect(readFileSync(target)).toEqual(before)
  expect(()=>indexLegacyProvenance({source,target:source,runId:'same'})).toThrow('Distinct isolated')
  copyFileSync(source,target)
  const changed=new Database(target);changed.exec("UPDATE platform_collection SET queried_at='drift' WHERE id=11");changed.close()
  const drift=readFileSync(target)
  expect(()=>complete()).toThrow('unchanged independent predecessor')
  expect(readFileSync(target)).toEqual(drift)
})
it('refuses missing alias archive digest and mismatching original cells with immutable failed preflight',()=>{
  const mutations=[
    "DELETE FROM platform_legacy_query_alias WHERE old_id=11",
    "UPDATE platform_archive_value SET sha256='"+'0'.repeat(64)+"' WHERE id=(SELECT archive_id FROM platform_collection_archive_ref WHERE owner_id=11 AND field='legacyProvenance')",
    "DELETE FROM platform_archive_value WHERE id=(SELECT archive_id FROM platform_collection_archive_ref WHERE owner_id=11 AND field='legacyProvenance')",
    "UPDATE platform_query_legacy_provenance SET source_sha256='invalid' WHERE query_id=11",
  ]
  for(const [i,mutation] of mutations.entries()) {
    const src=join(f.root,`bad-source-${i}.sqlite`),dst=join(f.root,`bad-target-${i}.sqlite`);copyFileSync(source,src)
    const s=new Database(src);s.pragma('foreign_keys=OFF')
    // Corruption fixture deliberately removes source protection, never a production repair path.
    for(const row of s.prepare("SELECT name FROM sqlite_schema WHERE type='trigger' AND tbl_name IN ('platform_archive_value','platform_legacy_query_alias')").all() as {name:string}[]) s.exec(`DROP TRIGGER "${row.name}"`)
    s.exec(mutation);s.close();copyFileSync(src,dst)
    const before=readFileSync(dst)
    expect(()=>indexLegacyProvenance({source:src,target:dst,runId:'bad'})).toThrow()
    expect(readFileSync(dst)).toEqual(before)
  }
})
it.each([
  ['original BLOB metadata',"UPDATE platform_query_legacy_provenance SET source_identity=X'78' WHERE query_id=11",'Unsupported original metadata storage class'],
  ['original REAL segment',"UPDATE platform_query_legacy_provenance SET segment_index=0.5 WHERE query_id=11",'Original T04 eight cells differ'],
  ['duplicate source segment',"DROP INDEX platform_query_legacy_source_uq; UPDATE platform_query_legacy_provenance SET source_sha256='"+sha+"',segment_index=0 WHERE query_id=12",'Duplicate provenance source identity'],
  ['cross-owner envelope',"UPDATE platform_legacy_query_alias SET collection_id=999 WHERE old_id=11; UPDATE platform_legacy_query_alias SET collection_id=11 WHERE old_id=12; UPDATE platform_legacy_query_alias SET collection_id=12 WHERE old_id=11",'T04 original query alias mismatch'],
  ['unknown archive FK owner',"CREATE TABLE unexpected_archive_owner(id INTEGER PRIMARY KEY,archive_id INTEGER REFERENCES platform_archive_value(id))",'Unknown archive FK owner inventory'],
] as const)('refuses frozen source corruption %s before schema installation',(name,mutation,error)=>{
  const src=join(f.root,`corrupt-${name}.sqlite`),dst=join(f.root,`corrupt-target-${name}.sqlite`);copyFileSync(source,src)
  const s=new Database(src);s.pragma('foreign_keys=OFF')
  try {
    for(const row of s.prepare("SELECT name FROM sqlite_schema WHERE type='trigger' AND tbl_name IN ('platform_archive_value','platform_legacy_query_alias')").all() as {name:string}[]) s.exec(`DROP TRIGGER "${row.name}"`)
    s.exec(mutation)
    // Reframe matching original cells: type/duplicate failures must not rely on a
    // stale archive or the new parser to manufacture their expected result.
    for(const id of [11,12]) {
      const chunks:Buffer[]=[Buffer.from('T04-PROVENANCE\n')]
      for(const field of ['query_id','source_identity','source_sha256','segment_index','collection','input_fingerprint','import_batch_id','created_at']) {
        const cell=s.prepare(`SELECT typeof("${field}") kind,cast("${field}" AS blob) bytes FROM platform_query_legacy_provenance WHERE query_id=?`).get(id) as {kind:string;bytes:Buffer}
        chunks.push(Buffer.from(`${field} ${cell.kind} ${cell.bytes.length}\n`),cell.bytes,Buffer.from('\n'))
      }
      const bytes=Buffer.concat(chunks),hash=createHash('sha256').update(bytes).digest('hex')
      s.prepare("UPDATE platform_archive_value SET bytes=?,byte_length=?,sha256=? WHERE id=(SELECT archive_id FROM platform_collection_archive_ref WHERE owner_id=? AND field='legacyProvenance')").run(bytes,bytes.length,hash,id)
    }
  } finally {s.close()}
  copyFileSync(src,dst);const before=readFileSync(dst)
  expect(()=>indexLegacyProvenance({source:src,target:dst,runId:'corrupt'})).toThrow(error)
  expect(readFileSync(dst)).toEqual(before)
})
it('completes an actual pipeline without provenance and preserves absent metadata on replay',async()=>{
  const empty=await processReaderFixture()
  empty.close()
  const s10=join(empty.root,'empty71610.sqlite'),s11=join(empty.root,'empty71611.sqlite'),s12=join(empty.root,'empty71612.sqlite')
  copyFileSync(empty.target,s10);copyFileSync(s10,s11);transferCorrespondence({source:s10,target:s11,runId:'empty-h1c'})
  copyFileSync(s11,s12);transferDifferenceReferences({source:s11,target:s12,runId:'empty-difference'})
  const dst=join(empty.root,'empty71613.sqlite');copyFileSync(s12,dst)
  expect(indexLegacyProvenance({source:s12,target:dst,runId:'empty'})).toEqual({state:'complete',rows:0,version:71613})
  const t=new Database(dst)
  try {
    expect(t.prepare('SELECT * FROM platform_collection_legacy_provenance').all()).toEqual([])
    expect(t.prepare("SELECT last_old_id,copied_count FROM platform_migration_checkpoint WHERE run_id='empty'").get()).toEqual({last_old_id:0,copied_count:0})
  } finally {t.close()}
  const bytes=readFileSync(dst)
  expect(indexLegacyProvenance({source:s12,target:dst,runId:'empty'})).toEqual({state:'complete',rows:0,version:71613})
  expect(readFileSync(dst)).toEqual(bytes)
})
it.each(['checkpoint','historical collection','unknown version','source binding'] as const)('refuses completed replay drift in %s without rewriting evidence',kind=>{
  complete('drift755')
  let src=source
  const t=new Database(target)
  try {
    if(kind==='checkpoint')t.exec("UPDATE platform_migration_checkpoint SET batch_digest='different' WHERE run_id='drift755'")
    if(kind==='historical collection')t.exec("UPDATE platform_collection SET queried_at='different' WHERE id=13")
    if(kind==='unknown version')t.pragma('user_version=71614')
    if(kind==='source binding') {
      src=join(f.root,'changed-frozen-source.sqlite');copyFileSync(source,src)
      const s=new Database(src);s.exec("UPDATE platform_collection SET queried_at='different' WHERE id=13");s.close()
    }
  } finally {t.close()}
  const bytes=readFileSync(target)
  expect(()=>indexLegacyProvenance({source:src,target,runId:'drift755'})).toThrow()
  expect(readFileSync(target)).toEqual(bytes)
})
it.each([
  ['blob archive','blob',Buffer.from('{}')],
  ['invalid JSON','text',Buffer.from('invalid')],
  ['array JSON','text',Buffer.from('[]')],
] as const)('refuses supplement %s without claiming archive ownership',(_name,storageClass,bytes)=>{
  complete()
  const t=new Database(target),db=drizzle(t,{schema:targetSchema})
  try {
    const archiveId=insertArchiveValue(db,{storageClass,bytes,createdAt:null})
    expect(()=>db.insert(targetSchema.platformCollectionLegacyProvenance).values({collectionId:13,origin:'supplement',sourceIdentity:'x',sourceSha256:'d'.repeat(64),segmentIndex:0,inputFingerprint:fingerprint,importBatchId:1,createdAt:'',archiveId}).run()).toThrow()
    expect(t.prepare('SELECT count(*) n FROM platform_collection_legacy_provenance').get()).toEqual({n:2})
  } finally {t.close()}
})
it.each(['source unknown','source incomplete','target incomplete'] as const)('refuses %s completion before writing a schema',kind=>{
  const src=join(f.root,`${kind}-source.sqlite`),dst=join(f.root,`${kind}-target.sqlite`)
  copyFileSync(source,src);copyFileSync(source,dst)
  const changed=new Database(kind==='target incomplete'?dst:src)
  try {
    if(kind==='source unknown')changed.pragma('user_version=71614')
    else changed.exec("UPDATE platform_migration_run SET state='running' WHERE transform_version='difference-evidence-reference-v1'")
  } finally {changed.close()}
  const bytes=readFileSync(dst)
  expect(()=>indexLegacyProvenance({source:src,target:dst,runId:'completion'})).toThrow(kind==='source unknown'?'Unsupported difference reference schema version':'Difference reference migration incomplete')
  expect(readFileSync(dst)).toEqual(bytes)
})
it('rolls back the first batch checkpoint and retains originals immutable and sealed',()=>{
  expect(()=>indexLegacyProvenance({source,target,runId:'first-batch',batchSize:1,beforeCommit:stage=>{if(stage==='batch')throw new Error('first batch cancellation')}})).toThrow('first batch cancellation')
  const t=new Database(target),s=new Database(source,{readonly:true})
  try {
    expect(t.prepare('SELECT count(*) n FROM platform_collection_legacy_provenance').get()).toEqual({n:0})
    expect(t.prepare("SELECT last_old_id,copied_count FROM platform_migration_checkpoint WHERE run_id='first-batch'").get()).toEqual({last_old_id:0,copied_count:0})
    expect(cells(t,'platform_archive_value')).toEqual(cells(s,'platform_archive_value'))
    expect(()=>t.exec('UPDATE platform_archive_value SET bytes=bytes WHERE id=1')).toThrow()
    expect(()=>t.exec('DELETE FROM platform_archive_value WHERE id=1')).toThrow()
    expect(()=>t.exec("INSERT INTO platform_collection_archive_ref SELECT owner_id,'request',archive_id,0 FROM platform_collection_archive_ref WHERE owner_id=11 LIMIT 1")).toThrow()
    expect(cells(t,'platform_collection_archive_ref')).toEqual(cells(s,'platform_collection_archive_ref'))
  } finally {t.close();s.close()}
  copyFileSync(target,target+'.after-failure.sqlite')
  expect(complete('first-batch')).toEqual({state:'complete',rows:2,version:71613})
})
