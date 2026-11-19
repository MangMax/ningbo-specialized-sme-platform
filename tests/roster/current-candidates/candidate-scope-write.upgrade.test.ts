import { createRuntimeSchema } from '../../../db/create-runtime'
import * as nativeSchema from '../../../db/schema'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { candidateFixture } from '../../platform/fixtures/candidate-scope-upgrade'
import { finalizeCandidateScopes } from '../../../upgrade/candidate-scope'
import { writeNewCollectionTarget, writeCollectionTarget, type NewCollectionTargetCommand } from '../../../layers/sme-roster/lib/platform/collection-target-command'
import { candidateScopeObservation as o } from '../../../upgrade/frozen/candidate-scope-schema'
import { listTargetDeclarations } from '../../../layers/sme-roster/server/utils/platform-declarations-target'
import { targetSchema } from '../../../upgrade/target-schema'
import { platformResultToImport } from '../../../layers/sme-roster/lib/platform/recognized-evidence'
import type { PlatformQuerySource, PlatformLiveQueryResult } from '../../../layers/sme-roster/lib/platform/live-query'

function logicalBytes(t:Database.Database) {
  const bytes=t.serialize(); for(const offset of [24,92])bytes.fill(0,offset,offset+4); return bytes
}
function command(source: PlatformQuerySource): NewCollectionTargetCommand {
  const e:PlatformLiveQueryResult={source,status:'success',effectiveConditions:{name:'Example',combination:'and',...(source==='businessList'?{name:undefined,uscc:'91330200712345678A'}:{})},titleScope:{mode:source==='queryList'?'source_default':'selected',rdjb:source==='queryList'?[]:['2']},queriedAt:'2026-11-12T00:00:00Z',completedAt:'2026-11-12T00:01:00Z',rows:[{id:'A',qymc:'Example',rdjb:'3'}],pages:[{source,rdjb:source==='queryList'?null:'2',page:1,maxPage:1,status:'success',fetchedCount:1,declaredTotal:1,error:null}],fetchedCount:1,declaredTotal:1,completeness:'complete',fullRange:true,unfinished:[],error:null,limits:{maxRequests:100,maxRows:5000,maxDurationMs:60000,pageSize:50}}
  e.dataRows=[{id:'A',qymc:'Example',rdjb:'3'}]
  const query=platformResultToImport(e)
  return {queryText:JSON.stringify(query),evidenceText:JSON.stringify(e),createdAt:'c',assignments:[{enterpriseId:null,nameRaw:'Example',usccRaw:null,matchBasis:'none',verificationStatus:'pending',origin:'command',actor:{type:'agent',id:'731'},basis:'explicit synthetic'}]}
}
it('new collection transactions and replay retain three-source masks without changing row titles fingerprints or captures', async () => {
  const t=new Database(':memory:');t.pragma('foreign_keys=ON');createRuntimeSchema(t);const db=drizzle(t,{schema:nativeSchema})
  try {
    expect(()=>listTargetDeclarations({},db)).not.toThrow()
    for(const source of ['queryList','businessList','queryBusList'] as const){
      const input=command(source),result=writeNewCollectionTarget(db,input)
      const row=db.select().from(o).where(eq(o.id,result.observations[0]!.observationId)).get()!
      expect(row.candidateScopeState).toBe('captured')
      expect(row.candidateScopeMask).toBe(source==='queryList'?0:2)
      expect(row.candidateScopeArchiveId).not.toBeNull()
      const before=t.serialize()
      const replay=writeCollectionTarget(db,input)
      expect(replay.observations[0]!.observationId).toBe(row.id)
      expect(t.serialize().equals(before), 'database bytes remain unchanged').toBe(true)
    }
    expect(t.pragma('foreign_key_check')).toEqual([])
  } finally {t.close()}
},30000)

it('caller caught source failures roll back complete collection capture and all source writes',async()=>{
  const t=new Database(':memory:');t.pragma('foreign_keys=ON');createRuntimeSchema(t);const db=drizzle(t,{schema:nativeSchema})
  try {
    for(const source of ['queryList','businessList','queryBusList'] as const){
      t.exec("CREATE TRIGGER inject_candidate BEFORE INSERT ON platform_legacy_relation_alias BEGIN SELECT RAISE(ABORT,'injected after capture'); END")
      const before=logicalBytes(t)
      db.transaction(tx=>{expect(()=>writeNewCollectionTarget(tx,command(source))).toThrow('injected after capture')})
      expect(logicalBytes(t)).toEqual(before)
      t.exec('DROP TRIGGER inject_candidate')
    }
  } finally {t.close()}
},30000)

it('absent original archive is uncaptured while an actual SQL null archive captures fallback without supplement substitution',async()=>{
  const f=await candidateFixture(s=>{
    s.exec("INSERT INTO platform_query(id,interface,query_key,rdjb,queried_at,status,created_at) VALUES(1,'recognized_list','Q','1,2','t','success','c'); INSERT INTO platform_relation(id,query_id,sequence_no,raw_fields,created_at) VALUES(1,1,1,'{}','c')")
    s.exec("INSERT INTO platform_query(id,interface,query_key,rdjb,queried_at,status,collection_evidence,created_at) VALUES(2,'recognized_list','ERR','1,2','t','success','{\"pages\":[\"oops\"]}','c'); INSERT INTO platform_relation(id,query_id,sequence_no,raw_fields,created_at) VALUES(2,2,1,'{}','c')")
    s.exec("INSERT INTO import_batch(id,idempotency_key,source_kind,source_identity,created_at) VALUES(1,'supplement','platform_archive','synthetic','c'); INSERT INTO platform_query_legacy_provenance(query_id,source_identity,source_sha256,segment_index,collection,input_fingerprint,import_batch_id,created_at) VALUES(1,'synthetic','hash',0,'{\"pages\":[{\"status\":\"success\",\"rdjb\":\"2\",\"fetchedCount\":1}]}','fingerprint',1,'c')")
  },t=>{
    t.exec("INSERT INTO platform_collection(id,interface,query_key,rdjb,queried_at,created_at,status,completeness,provenance_state,parse_state,rule_version) VALUES(3,'recognized_list','M','1,2','t','c','success','unknown','unknown','absent','synthetic'); INSERT INTO platform_business_observation(id,collection_id,sequence_no,position_state,identity_state,content_state,indexed_at) VALUES(3,3,1,'unknown','not_indexed','not_indexed',NULL); INSERT INTO platform_business_observation(id,collection_id,sequence_no,position_state,identity_state,content_state,indexed_at) VALUES(4,1,2,'unknown','not_indexed','not_indexed',NULL)")
  })
  expect(finalizeCandidateScopes(f)).toEqual({state:'complete',captured:2,uncaptured:1,errors:1})
  const t=new Database(f.target)
  try {
    const db=drizzle(t)
    const rows=db.select().from(o).all()
    expect(rows[0]).toMatchObject({candidateScopeState:'captured',candidateScopeMask:3})
    expect(rows[0]!.candidateScopeArchiveId).not.toBeNull()
    expect(rows[1]).toMatchObject({candidateScopeState:'error',candidateScopeMask:null,candidateScopeRule:'current-candidate-scope-v1',candidateScopeError:'malformed JSON'})
    expect(rows[2]).toMatchObject({candidateScopeState:'uncaptured',candidateScopeMask:null,candidateScopeArchiveId:null,candidateScopeRule:null,candidateScopeError:'missing_original_collection_evidence'})
    expect(rows[3]).toMatchObject({id:4,recordId:null,versionId:null,candidateScopeState:'captured',candidateScopeMask:3})
    expect(t.prepare('SELECT id FROM platform_recognized_projection WHERE observation_id=4').all()).toEqual([])
    const nullArchive=t.prepare("SELECT a.storage_class FROM platform_archive_value a JOIN platform_collection_archive_ref r ON r.archive_id=a.id WHERE r.owner_id=1 AND r.field='collectionEvidence'").get()
    expect(nullArchive).toEqual({storage_class:'null'})
  } finally {t.close()}
},30000)

it('schema distinguishes captured zero uncaptured and errors and enforces source context immutability',async()=>{
  const f=await candidateFixture(s=>s.exec("INSERT INTO platform_query(id,interface,query_key,rdjb,queried_at,status,created_at) VALUES(1,'recognized_list','Z','9','t','success','c'); INSERT INTO platform_relation(id,query_id,sequence_no,raw_fields,created_at) VALUES(1,1,1,'{}','c')"))
  finalizeCandidateScopes(f)
  const t=new Database(f.target);t.pragma('foreign_keys=ON')
  try{
    expect(t.prepare('SELECT candidate_scope_state,candidate_scope_mask FROM platform_business_observation').get()).toEqual({candidate_scope_state:'captured',candidate_scope_mask:0})
    const columns=(t.pragma('table_info(platform_business_observation)') as {name:string}[]).map(c=>c.name)
    for(const invalid of [
      {candidate_scope_mask:'8'}, {candidate_scope_mask:'NULL'}, {candidate_scope_rule:"'wrong'"},
      {candidate_scope_state:"'uncaptured'"}, {candidate_scope_rdjb:"'1,2'"}, {candidate_scope_sequence_no:'2'},
      {candidate_scope_state:"'error'",candidate_scope_mask:'NULL',candidate_scope_error:'NULL'},
      {candidate_scope_archive_id:'999999'},
    ]){
      const values:Record<string,string|undefined>={id:'100',sequence_no:'100',candidate_scope_sequence_no:'100',...invalid}
      expect(()=>t.exec(`INSERT INTO platform_business_observation(${columns.join(',')}) SELECT ${columns.map(c=>values[c]??c).join(',')} FROM platform_business_observation WHERE id=1`)).toThrow()
    }
    const before=t.serialize()
    for(const sql of [
      "UPDATE platform_business_observation SET candidate_scope_mask=1", "UPDATE platform_business_observation SET sequence_no=2",
      "UPDATE platform_collection SET rdjb='1'", "UPDATE platform_collection SET title_code='innovative_sme'",
      'DELETE FROM platform_business_observation','INSERT OR REPLACE INTO platform_business_observation SELECT * FROM platform_business_observation',
    ])expect(()=>t.exec(sql)).toThrow()
    expect(t.serialize().equals(before), 'database bytes remain unchanged').toBe(true)
    t.prepare("UPDATE platform_collection SET last_collected_at='later'").run()
    expect(t.prepare('SELECT candidate_scope_mask FROM platform_business_observation').get()).toEqual({candidate_scope_mask:0})
  }finally{t.close()}
},30000)
