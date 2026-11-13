import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { copyFileSync, chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, beforeEach, afterEach, afterAll, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import * as schema from '../db/schema'
import { targetSchema as s } from '../lib/platform/target-schema'
import { readPlatformQueryEvidence } from '../lib/platform/evidence-read'
import { listPlatformQueries } from '../lib/platform/read'
import { readTargetRelationDisplay } from '../lib/platform/target-relation-display'
import { resolveSelectedLegacyProvenance, readResolvedLegacyDisplay } from '../lib/platform/target-legacy-provenance'
import { readTargetRelationEvidenceDisplay } from '../server/utils/platform-relation-evidence-display-target'
import { readComparisonTargetQueryFacts, readComparisonTargetIdentities } from '../server/utils/record-comparison-target-sources'
import { selectCandidateTargetPage } from '../server/utils/candidate-target-sources'
import { createPlatformSummaryCache, platformSummaryCache } from '../server/utils/platform-summary-cache'
import { insertArchiveValue, bindArchive, sealArchiveOwner } from '../lib/platform/target-archive'
import { assertExpandRuntime } from '../db/schema-phase'
import { processReaderFixture } from './helpers/process-target-734'
import { transferCorrespondence } from '../upgrade/correspondence'
import { transferDifferenceReferences } from '../upgrade/difference-references'
import { indexLegacyProvenance } from '../upgrade/legacy-provenance'
import * as h3 from 'h3'
import { createServer } from 'node:http'

vi.mock('@db', () => ({ useDb: () => db }))
vi.mock('@nuxtjs/mcp-toolkit/server', () => ({ defineMcpTool: (tool: unknown) => tool }))
const root = mkdtempSync(join(process.env.CANDIDATE_SCOPE_EVIDENCE_DIR ?? tmpdir(), 'reader757-'))
let t: Database.Database, db: ReturnType<typeof drizzle<typeof schema>>, old: Database.Database
let oracle: ReturnType<typeof drizzle<typeof schema>>, serial = 0, baseline: Record<string,string>
const statements: string[] = []
const literal = ' { "source":"businessList", "status":"partial", "pages":[{"status":"success","rdjb":"2","page":1,"fetchedCount":1},{"status":"success","rdjb":"3","page":2,"fetchedCount":2}], "rows":[{"raw":"尾😀\\u0000"}], "unfinished":[{"page":3}], "completeness":"partial", "fullRange":false } \n'
const metadata = { sourceIdentity: ' source\u0000😀 ', sourceSha256: 'd'.repeat(64), segmentIndex: 3, inputFingerprint: 'e'.repeat(64), importBatchId: 1, createdAt: ' original time ' }

beforeAll(async () => {
  const shared = process.env.PLATFORM_757_FIXTURES
  if (shared) { baseline = {normal: join(shared,'normal-71613.sqlite'), absent: join(shared,'absent-71613.sqlite')}; return }
  // Portable fallback: one complete chain per distinct baseline, never one per test.
  baseline = {}
  for (const kind of ['normal','absent']) {
    const f = await processReaderFixture(false, source => {
      if (kind === 'normal') {
        source.exec("INSERT INTO import_batch(id,idempotency_key,source_kind,source_identity,status,created_at) VALUES(1,'757','platform_archive','source','committed','c')")
        source.prepare('INSERT INTO platform_query_legacy_provenance VALUES(?,?,?,?,?,?,?,?)').run(11,' Original\u0000😀 ','a'.repeat(64),0,literal,'b'.repeat(64),1,'c')
      }
    })
    f.close()
    const p10=join(f.root,'757-71610.sqlite'),p11=join(f.root,'757-71611.sqlite'),p12=join(f.root,'757-71612.sqlite')
    copyFileSync(f.target,p10);copyFileSync(p10,p11);transferCorrespondence({source:p10,target:p11,runId:'757c'})
    copyFileSync(p11,p12);transferDifferenceReferences({source:p11,target:p12,runId:'757d'})
    copyFileSync(p12,f.target);indexLegacyProvenance({source:p12,target:f.target,runId:'757p'})
    baseline[kind]=f.target
  }
})
function open(kind='absent') {
  const path=join(root,`case-${++serial}.sqlite`);copyFileSync(baseline[kind]!,path);chmodSync(path,0o600)
  t=new Database(path,{verbose:q=>statements.push(String(q))});t.pragma('foreign_keys=ON')
  db=drizzle(t,{schema})
  const legacyPath=join(root,`old-${serial}.sqlite`);copyFileSync(baseline[kind]!,legacyPath);chmodSync(legacyPath,0o600)
  old=new Database(legacyPath);old.pragma('user_version=0');oracle=drizzle(old,{schema})
  statements.length=0
}
beforeEach(()=>open())
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();old?.close();t?.close()})
afterAll(()=>{ writeFileSync(join(root,'custody.json'),JSON.stringify({baseline,root,note:'Private COPY only; shared baseline immutable; old-service expected values independent of resolver. Full compiled Nuxt wire UNRUN.'},null,2)) })
function reopenNormal() {old.close();t.close();open('normal')}
function batch(connection:Database.Database) {
  connection.prepare("INSERT OR IGNORE INTO import_batch(id,idempotency_key,source_kind,source_identity,status,created_at) VALUES(1,'757','platform_archive','source','committed','c')").run()
}
function supplement(connection:Database.Database, collectionId=11, text=literal, segment=3) {
  batch(connection)
  const target=drizzle(connection,{schema:s})
  return target.transaction(tx=>{
    const archiveId=insertArchiveValue(tx,{storageClass:'text',bytes:Buffer.from(text),createdAt:'c'})
    tx.insert(s.platformCollectionLegacyProvenance).values({...metadata,collectionId,archiveId,origin:'supplement',segmentIndex:segment}).run()
    return archiveId
  })
}
function oldSupplement(queryId=11,text=literal,segment=3) {
  batch(old)
  old.prepare('INSERT INTO platform_query_legacy_provenance VALUES(?,?,?,?,?,?,?,?)').run(queryId,metadata.sourceIdentity,metadata.sourceSha256,segment,text,metadata.inputFingerprint,1,metadata.createdAt)
}
function bytes(queryId:number, offset=0, length=65536) {
  const value=readPlatformQueryEvidence(db,{queryId,field:'legacyProvenance',offset,length})
  if(!('data' in value))throw new Error('Expected byte evidence')
  return value
}
function frozen() {
  const tables=['platform_collection','platform_collection_page','platform_collection_condition','platform_collection_unfinished','platform_query_title_scope','platform_business_observation','platform_observation_assignment','platform_business_record','platform_business_record_version','platform_business_projection','record_correspondence','difference_reason','evidence_revision_113','evidence_impact_progress_113','explanation_impact_113','evidence_review_receipt_114','import_receipt']
  return tables.map(table=>[table,t.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])
}
function historicalDecisions() {
  db.insert(schema.differenceReason).values({id:101,enterpriseId:1,titleCode:'specialized_sme',direction:'missing_in_miit',status:'needs_review',evidenceQueryId:11,evidenceRelationId:1,requestHash:' original hash ',basis:' { "queryId":11 } ',recordedAt:'t'}).run()
  t.exec(`INSERT INTO evidence_revision_113(id,source_kind,source_key,source_version,coverage_digest,fact_digest,coverage_changed,fact_changed,metadata,max_decision_id,created_at) VALUES(11,'platform','old','v','coverage','facts',1,1,' { "queryId":11 } ',101,' old time ');
    INSERT INTO evidence_impact_progress_113 VALUES(11,101,1);
    INSERT INTO explanation_impact_113(id,enterprise_id,title_code,direction,decision_id,latest_revision_id,pending_since_revision_id,classification) VALUES(12,1,'specialized_sme','missing_in_miit',101,11,11,'review');
    INSERT INTO evidence_review_receipt_114(id,idempotency_key,request_hash,kind,enterprise_id,title_code,direction,decision_id,source_decision_id,reviewed_revision_id,actor,basis,response,recorded_at)
    VALUES(13,'old757',' original hash ','review',1,'specialized_sme','missing_in_miit',101,101,11,' { "type":"agent" } ',' 原始 ',' { "queryId":11 } ',' time ');`)
  for(const table of ['difference_reason','evidence_revision_113','evidence_impact_progress_113','explanation_impact_113','evidence_review_receipt_114'])expect(t.prepare(`SELECT count(*) n FROM ${table}`).get(),table).toEqual({n:1})
}
function membership() {
  const queryFacts=readComparisonTargetQueryFacts(db,[11,12,13])
  const identities=readComparisonTargetIdentities(db,[11,12,13])
  const candidate=selectCandidateTargetPage(db,{queryIds:[11,12,13],enterpriseId:2,identity:'U1',titleCode:'little_giant',event:false,page:1,pageSize:20})
  return {queryFacts,identities,candidate,summaries:[{}, {enterpriseId:1}, {titleCode:'specialized_sme'}, {uscc:'U1'}, {queryId:11,enterpriseId:2}].map(filter=>listPlatformQueries(db,{...filter,view:'summary'}))}
}
function corrupt(statement:string, check:()=>void) {
  const rollback=Symbol('corruption rollback')
  t.pragma('foreign_keys=OFF')
  try {db.transaction(()=>{
    for(const {name} of t.prepare("SELECT name FROM sqlite_schema WHERE type='trigger'").all() as {name:string}[])t.exec(`DROP TRIGGER "${name.replaceAll('"','""')}"`)
    t.exec(statement);check();throw rollback
  })}catch(error){if(error!==rollback)throw error}finally{t.pragma('foreign_keys=ON')}
}

it('returns old T04 metadata and original collection cell bytes including BLOB and NULL raw types',()=>{
  reopenNormal()
  const ids=(old.prepare('SELECT query_id FROM platform_query_legacy_provenance ORDER BY query_id').all() as {query_id:number}[]).map(row=>row.query_id)
  expect(ids.length).toBeGreaterThan(0)
  for(const queryId of ids) {
    const original=old.prepare('SELECT cast(collection as blob) bytes FROM platform_query_legacy_provenance WHERE query_id=?').get(queryId) as {bytes:Buffer}
    const parts:Buffer[]=[]
    for(let offset=0;;) {
      const actual=bytes(queryId,offset,11)
      expect(actual).toEqual(readPlatformQueryEvidence(oracle,{queryId,field:'legacyProvenance',offset,length:11}))
      parts.push(Buffer.from(actual.data,'base64'));offset+=actual.byteLength
      if(!actual.hasMore)break
    }
    expect(Buffer.concat(parts)).toEqual(original.bytes)
    const expected=listPlatformQueries(oracle,{queryId})
    expect(listPlatformQueries(db,{queryId})).toEqual(expected)
    for(const field of ['rawResponse','collectionEvidence'] as const)expect(readPlatformQueryEvidence(db,{queryId,field})).toEqual(readPlatformQueryEvidence(oracle,{queryId,field}))
  }
})
it('joins eleven byte supplement segments exactly and preserves original metadata remove rows and literal selected page positions',()=>{
  historicalDecisions()
  const before=frozen(),selection=membership()
  expect(selection.candidate).toEqual({total:1,ids:[2]})
  expect(bytes(11)).toMatchObject({isNull:true,totalBytes:0})
  supplement(t);oldSupplement()
  const chunks:Buffer[]=[]
  for(let offset=0;;) {
    const actual=bytes(11,offset,11)
    expect(actual).toEqual(readPlatformQueryEvidence(oracle,{queryId:11,field:'legacyProvenance',offset,length:11}))
    chunks.push(Buffer.from(actual.data,'base64'));offset+=actual.byteLength
    if(!actual.hasMore)break
  }
  expect(Buffer.concat(chunks)).toEqual(Buffer.from(literal))
  for(const offset of [0,1,11,Buffer.byteLength(literal),999999])expect(bytes(11,offset,3)).toEqual(readPlatformQueryEvidence(oracle,{queryId:11,field:'legacyProvenance',offset,length:3}))
  const actual=listPlatformQueries(db,{queryId:11})
  expect(actual).toEqual(listPlatformQueries(oracle,{queryId:11}))
  expect(actual.rows[0]!.query.legacyProvenance).toMatchObject({...metadata,queryId:11,kind:'legacy_pagination',collection:{status:'partial',fullRange:false,unfinished:[{page:3}]}})
  expect(actual.rows[0]!.query.legacyProvenance!.collection).not.toHaveProperty('rows')
  expect(actual.rows[0]!.query.collectionEvidence).toBeNull()
  expect(actual.rows[0]!.relations.map(row=>[row.id,row.sourceRdjb,row.sourcePage])).toEqual([[1,'2',1],[5,'3',2],[7,'3',2]])
  expect(readTargetRelationEvidenceDisplay(db,[{relationId:5,queryId:11}]).sources.get(5)).toMatchObject({id:5,sourceRdjb:'3',sourcePage:2,query:{legacyProvenance:{kind:'legacy_pagination'}}})
  expect(membership()).toEqual(selection)
  expect(frozen()).toEqual(before)
})
it('keeps exact relation DTO sequence aliases and query pairing independent of supplement display',()=>{
  const dto=readPlatformQueryEvidence(db,{queryId:11,field:'relation',relationId:1}),relations=readPlatformQueryEvidence(db,{queryId:11,field:'relations',page:2,pageSize:1})
  supplement(t)
  expect(readPlatformQueryEvidence(db,{queryId:11,field:'relation',relationId:1})).toEqual(dto)
  expect(readPlatformQueryEvidence(db,{queryId:11,field:'relations',page:2,pageSize:1})).toEqual(relations)
  expect(relations).toEqual({queryId:11,field:'relations',total:3,page:2,pageSize:1,rows:[{id:5,sequenceNo:2}]})
  expect(()=>readPlatformQueryEvidence(db,{queryId:12,field:'relation',relationId:1})).toThrowError(expect.objectContaining({statusCode:404}))
  expect(readTargetRelationDisplay(db,[{relationId:1,queryId:12}]).sources.get(1)).toBeNull()
  expect(()=>bytes(11,0,65537)).toThrowError(expect.objectContaining({statusCode:400}))
  expect(bytes(11,0,65536).byteLength).toBe(Buffer.byteLength(literal))
})
it('retains historical page NULL boolean number and text values with the original locator',()=>{
  const text=JSON.stringify({pages:[{status:'success',rdjb:null,page:null,fetchedCount:1},{status:'success',rdjb:false,page:'09',fetchedCount:1},{status:'success',rdjb:2,page:0,fetchedCount:1}],rows:[]})
  supplement(t,11,text);oldSupplement(11,text)
  expect(listPlatformQueries(db,{queryId:11})).toEqual(listPlatformQueries(oracle,{queryId:11}))
  expect(listPlatformQueries(db,{queryId:11}).rows[0]!.relations.map(row=>[row.sourceRdjb,row.sourcePage])).toEqual([[null,null],[false,'09'],[2,0]])
})
function emptyOwner(id:number,key:string,raw='') {
  const target=drizzle(t,{schema:s})
  target.transaction(tx=>{
    tx.insert(s.platformCollection).values({id,interface:'business_list',queryKey:key,rdjb:'2',queriedAt:`2030-${id}`,createdAt:'c',status:'no_record',completeness:'unknown',provenanceState:'unknown',parseState:'absent',ruleVersion:'t04-collection-v1'}).run()
    for(const [field,value] of [['rawResponse',raw],['collectionEvidence',null]] as const){
      const archiveId=insertArchiveValue(tx,value===null?{storageClass:'null',bytes:null,createdAt:'c'}:{storageClass:'text',bytes:Buffer.from(value),createdAt:'c'})
      bindArchive(tx,{kind:'collection',ownerId:id,field,archiveId})
    }
    sealArchiveOwner(tx,{kind:'collection',ownerId:id})
    tx.insert(s.platformLegacyQueryAlias).values({oldId:id+10000,collectionId:id}).run()
  })
  return id+10000
}
it('preserves complete empty supplements and original nonidentity aliases without fabricating collection evidence',()=>{
  const queryId=emptyOwner(101,'empty')
  const text=' { "source":"businessList", "status":"no_record", "pages":[{"status":"success","rdjb":"2","page":1,"fetchedCount":0}], "rows":[], "fullRange":true, "completeness":"complete" } '
  supplement(t,101,text)
  expect(bytes(queryId)).toMatchObject({queryId,isNull:false,data:Buffer.from(text).toString('base64')})
  expect(listPlatformQueries(db,{queryId}).rows[0]).toMatchObject({query:{id:10101,collectionEvidence:null,relationCount:0,legacyProvenance:{queryId:10101,collection:{fullRange:true,completeness:'complete'}}},relations:[]})
  expect(()=>bytes(101)).toThrowError(expect.objectContaining({statusCode:404}))
})
it('summary never hydrates provenance archives or raw rows and selected pages isolate giant nonselected archives',()=>{
  const queryId=emptyOwner(101,'giant')
  supplement(t,101,JSON.stringify({pages:[],rows:[],pad:'x'.repeat(9*1024*1024)}))
  statements.length=0
  const summary=listPlatformQueries(db,{view:'summary'})
  expect(summary.total).toBe(4)
  expect(statements.filter(q=>/\b(?:from|join)\s+["`]?platform_(?:collection_legacy_provenance|archive_value|collection_archive_ref|observation_archive_ref)\b/i.test(q))).toEqual([])
  expect(listPlatformQueries(db,{queryId:11})).toEqual(listPlatformQueries(oracle,{queryId:11}))
  expect(()=>listPlatformQueries(db,{queryId})).toThrowError(expect.objectContaining({statusCode:413}))
})
function padded(size:number) {
  const shell={pages:[],rows:['excluded'.repeat(100)],pad:''}
  const without=JSON.stringify({pages:[],pad:''})
  shell.pad='x'.repeat(size-Buffer.byteLength(without))
  return JSON.stringify(shell)
}
it('enforces SQL first query budgets below at and above 4MiB and page budgets at 8MiB plus one byte',()=>{
  const cap=4*1024*1024
  const below=emptyOwner(101,'below'),exact=emptyOwner(102,'page'),over=emptyOwner(103,'over'),exact2=emptyOwner(104,'page')
  supplement(t,101,padded(cap-1),1);supplement(t,102,padded(cap),2);supplement(t,103,padded(cap+1),3);supplement(t,104,padded(cap),4)
  expect(listPlatformQueries(db,{queryId:below}).total).toBe(1)
  expect(listPlatformQueries(db,{queryId:exact}).total).toBe(1)
  statements.length=0
  expect(()=>listPlatformQueries(db,{queryId:over})).toThrowError(expect.objectContaining({statusCode:413}))
  expect(statements.some(q=>/select[^;]*"platform_archive_value"\."bytes"/i.test(q))).toBe(false)
  expect(listPlatformQueries(db,{queryKey:'page',includeRawResponse:true}).rows.map(row=>row.query.id).sort()).toEqual([exact,exact2])
  emptyOwner(105,'page','x')
  expect(()=>listPlatformQueries(db,{queryKey:'page',includeRawResponse:true})).toThrowError(expect.objectContaining({statusCode:413}))
  expect(listPlatformQueries(db,{queryKey:'page',view:'summary'}).total).toBe(3)
})
it('deduplicates selected metadata and decodes each collection once with at most 400 SQL parameters',()=>{
  supplement(t)
  const owner=db.select().from(s.platformCollection).where(eq(s.platformCollection.id,11)).get()!
  for(let i=100;i<505;i++)emptyOwner(i,'batch-'+i)
  const owners=db.select().from(s.platformCollection).all().map(collection=>({collection,id:collection.id>=100?collection.id+10000:collection.id}))
  const prepare=vi.spyOn(t,'prepare')
  const selected=resolveSelectedLegacyProvenance(db,[...owners,...Array.from({length:1201},()=>({collection:owner,id:11}))])
  const value=selected.get(11)!
  const first=readResolvedLegacyDisplay(db,value)
  expect(readResolvedLegacyDisplay(db,value)).toBe(first)
  expect(selected.size).toBe(408)
  for(const [query] of prepare.mock.calls)expect((query.match(/\?/g)??[]).length).toBeLessThanOrEqual(400)
  expect(readTargetRelationDisplay(db,[{relationId:1},{relationId:5},{relationId:7}]).sources.get(7)).toMatchObject({sourcePage:2})
})
it.each([
  ['missing index',"DELETE FROM platform_collection_legacy_provenance WHERE collection_id=11"],
  ['metadata',"UPDATE platform_collection_legacy_provenance SET source_identity='drift' WHERE collection_id=11"],
  ['owner',"DELETE FROM platform_collection_legacy_provenance WHERE collection_id=12; UPDATE platform_collection_legacy_provenance SET archive_id=(SELECT archive_id FROM platform_collection_archive_ref WHERE owner_id=12 AND field='legacyProvenance') WHERE collection_id=11"],
  ['origin',"UPDATE platform_collection_legacy_provenance SET origin='supplement' WHERE collection_id=11"],
  ['extra sealed ref',"INSERT INTO platform_archive_value(storage_class,bytes,byte_length,sha256,created_at) VALUES('null',NULL,NULL,NULL,NULL); INSERT INTO platform_collection_archive_ref VALUES(11,'request',last_insert_rowid(),1)"],
] as const)('fails closed for T04 lifecycle %s instead of reporting absence',(_name,mutation)=>{
  reopenNormal()
  corrupt(mutation,()=>{expect(()=>bytes(11)).toThrow(/lifecycle|field set/);expect(()=>listPlatformQueries(db,{queryId:11})).toThrow(/lifecycle|field set/)})
})
it('rejects missing supplement archive wrong storage owner conflict and unfinished successor with no online repair',()=>{
  const archive=supplement(t)
  for(const mutation of [
    `DELETE FROM platform_archive_value WHERE id=${archive}`,
    `UPDATE platform_archive_value SET storage_class='blob' WHERE id=${archive}`,
    `UPDATE platform_version_archive_ref SET archive_id=${archive} WHERE owner_id=(SELECT min(owner_id) FROM platform_version_archive_ref)`,
    "UPDATE platform_migration_run SET state='running' WHERE transform_version='collection-legacy-provenance-v1'",
  ])corrupt(mutation,()=>expect(()=>bytes(11)).toThrow())
  expect(()=>assertExpandRuntime(t)).toThrow('Finalized/offline target')
})
it('retains one request snapshot during a concurrent supplement commit and exposes it on the next request',()=>{
  t.pragma('journal_mode=WAL')
  const writer=new Database(t.name);writer.pragma('foreign_keys=ON')
  let changed=false
  const snapshot=drizzle(t,{schema,logger:{logQuery(query){
    if(!changed && query.includes('from "platform_collection_legacy_provenance"')){changed=true;supplement(writer)}
  }}})
  try {
    expect(listPlatformQueries(snapshot,{queryId:11}).rows[0]!.query).not.toHaveProperty('legacyProvenance')
    expect(changed).toBe(true)
    expect(listPlatformQueries(db,{queryId:11}).rows[0]!.query).toHaveProperty('legacyProvenance')
  }finally{writer.close()}
})
it('invalidates the readonly summary observer on commit and preserves cache on rollback with transaction and no-store bypass',()=>{
  t.pragma('journal_mode=WAL')
  const cache=createPlatformSummaryCache()
  try {
    const original=cache.read(db,{view:'summary'})
    expect(cache.read(db,{view:'summary'})).toEqual(original)
    expect(cache.stats().hits).toBe(1)
    t.exec('BEGIN');supplement(t)
    expect(listPlatformQueries(db,{queryId:11}).rows[0]!.query).toHaveProperty('legacyProvenance')
    expect(cache.read(db,{view:'summary'})).toEqual(original)
    t.exec('ROLLBACK')
    expect(listPlatformQueries(db,{queryId:11}).rows[0]!.query).not.toHaveProperty('legacyProvenance')
    expect(cache.read(db,{view:'summary'})).toEqual(original)
    expect(cache.stats()).toMatchObject({hits:2,misses:1,bypasses:1})
    supplement(t)
    expect(cache.read(db,{view:'summary'})).toEqual(original)
    expect(cache.stats().misses).toBe(2)
    cache.read(db,{view:'summary'},{allowStore:false})
    expect(cache.stats().bypasses).toBe(2)
  }finally{cache.close()}
})
it('executes actual H3 list evidence and MCP handlers with no-store exact bytes and unchanged alias authorization',async()=>{
  supplement(t)
  for(const key of ['defineEventHandler','getQuery','createError'] as const)vi.stubGlobal(key,h3[key])
  const router=h3.createRouter()
  router.get('/api/platform/queries',(await import('../server/api/platform/queries.get')).default)
  router.get('/api/platform/queries/:queryId/evidence',(await import('../server/api/platform/queries/[queryId]/evidence.get')).default)
  const mcpList=(await import('../server/mcp/tools/list_platform_queries')).default
  const mcpEvidence=(await import('../server/mcp/tools/get_platform_query_evidence')).default
  const server=createServer(h3.toNodeListener(h3.createApp().use(router)))
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
  const address=server.address();if(!address||typeof address==='string')throw new Error('Expected local HTTP')
  const base=`http://127.0.0.1:${address.port}`
  try {
    const response=await fetch(base+'/api/platform/queries?queryId=11')
    expect(response.status).toBe(200)
    const body=await response.json()
    expect(body).toEqual(listPlatformQueries(db,{queryId:11}))
    expect(await mcpList.handler({queryId:11} as never,{} as never)).toEqual(body)
    const evidence=await fetch(base+'/api/platform/queries/11/evidence?field=legacyProvenance&offset=11&length=11')
    expect(evidence.status).toBe(200);expect(evidence.headers.get('cache-control')).toBe('no-store')
    const chunk=await evidence.json()
    expect(chunk).toEqual(bytes(11,11,11))
    expect(await mcpEvidence.handler({queryId:11,field:'legacyProvenance',offset:11,length:11} as never,{} as never)).toEqual(chunk)
    expect((await fetch(base+'/api/platform/queries/12/evidence?field=relation&relationId=1')).status).toBe(404)
    expect((await fetch(base+'/api/platform/queries/11/evidence?field=legacyProvenance&length=65537')).status).toBe(400)
    writeFileSync(join(root,'handler-evidence.json'),JSON.stringify({list:body,chunk,status:[200,404,400],compiledWire:'UNRUN'},null,2))
  }finally{platformSummaryCache.close();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()))}
})

it('caps actual evidence at 65536 bytes across UTF8 boundaries and retains original JSON errors',()=>{
  const queryId=emptyOwner(101,'chunk')
  const text='{"pad":"'+'x'.repeat(65527)+'😀尾","rows":[]}'
  supplement(t,101,text)
  const first=bytes(queryId),next=bytes(queryId,65536)
  expect(first).toMatchObject({byteLength:65536,hasMore:true,isNull:false})
  expect(next).toMatchObject({hasMore:false,isNull:false})
  expect(Buffer.concat([Buffer.from(first.data,'base64'),Buffer.from(next.data,'base64')])).toEqual(Buffer.from(text))
  expect(()=>bytes(queryId,0,65537)).toThrowError(expect.objectContaining({statusCode:400}))
  corrupt("UPDATE platform_archive_value SET bytes=cast('broken' as blob),byte_length=6 WHERE id=(SELECT archive_id FROM platform_collection_legacy_provenance WHERE collection_id=101)",()=>{
    expect(()=>listPlatformQueries(db,{queryId})).toThrow('malformed JSON')
  })
})
it('rejects oversized selected relation metadata before hydrating its payload archives',()=>{
  supplement(t,11,padded(4*1024*1024+1))
  statements.length=0
  expect(()=>readTargetRelationDisplay(db,[{relationId:1}])).toThrowError(expect.objectContaining({statusCode:413}))
  expect(statements.some(q=>/select[^;]*"platform_archive_value"\."bytes"/i.test(q))).toBe(false)
})
