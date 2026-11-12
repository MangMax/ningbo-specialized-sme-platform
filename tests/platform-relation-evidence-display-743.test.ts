import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { eq } from 'drizzle-orm'
import { writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, afterAll, it, expect, vi } from 'vitest'
import * as schema from '../db/schema'
import { targetSchema as s } from '../lib/platform/target-schema'
import { processReaderFixture } from './helpers/process-target-734'
import { readSource, sanitizeEvidence } from '../server/utils/record-correspondence-read'
import { importReceiptRedactor, type ReceiptRedactor } from '../server/utils/import-receipt-redaction'
import { readTargetRelationEvidenceDisplay } from '../server/utils/platform-relation-evidence-display-target'
import { platformResultToImport } from '../lib/platform/recognized-evidence'
import { writeNewCollectionTarget, writeCollectionTarget } from '../lib/platform/collection-target-command'
import { writeApplyTarget } from '../lib/platform/apply-target-writer'
import { writeProcessTarget } from '../lib/platform/process-target-writer'
import { writeRecognizedTarget } from '../lib/platform/recognized-target-writer'
import { preflightRosterImport, commitRosterImport } from '../server/utils/roster-import'

let f: Awaited<ReturnType<typeof processReaderFixture>>
beforeAll(async () => {
  f = await processReaderFixture(true, old => {
    old.exec(`INSERT INTO platform_query(id,interface,query_key,rdjb,queried_at,status,failure_reason,created_at) VALUES
      (21,'apply_list','Q21','2','t','partial','token=failed-secret','c'),
      (22,'recognized_list','Q22','2','t','success',NULL,'c'),
      (23,'apply_list','Q23','','t','failed',NULL,'c'),(24,'apply_list','Q24','','t','no_record',NULL,'c');
      INSERT INTO platform_relation(id,query_id,sequence_no,name_raw,uscc_raw,alias_name_raw,source_text,raw_fields,created_at) VALUES
      (21,21,1,' Original ',' U ',' Alias ','cookie=source-secret','{"rdjb":"3","cszt":"pending","year":2024,"authorization":"raw-secret","note":"known-secret"}','c'),
      (22,22,1,'Directory','U22',NULL,NULL,'{"rdjb":"2","whpcyear":"2024","rddqrq":" date "}','c'),
      (23,23,1,'failed retained',NULL,NULL,NULL,NULL,'c'),
      (25,22,2,'NULL raw',NULL,NULL,NULL,NULL,'c'),
      (26,22,3,'malformed',NULL,NULL,NULL,'broken','c');`)
    old.prepare('UPDATE platform_query SET collection_evidence=? WHERE id=21').run(JSON.stringify({
      status: 'partial', pages: [{ status: 'success', rdjb: '2', page: 9, fetchedCount: 1 }], rows: [{ hidden: 'must-remove' }], note: 'known-secret', cookie: 'metadata-secret',
    }))
    const insert = old.prepare("INSERT INTO platform_relation(id,query_id,sequence_no,name_raw,raw_fields,created_at) VALUES(?,21,?,'Bulk',NULL,'c')")
    for (let i = 0; i < 305; i++) insert.run(1000 + i, 2 + i)
    const pages = [
      [{ status:'success', rdjb:' 2 ', page:0, fetchedCount:1 }],
      [{ status:'failed', rdjb:'3', page:7, fetchedCount:1 },{status:'success',rdjb:null,page:null,fetchedCount:1}],
      [{ status:'success', rdjb:false, page:'09', fetchedCount:1 }],
    ]
    for(const [index,value] of pages.entries()) {
      old.prepare("INSERT INTO platform_query(id,interface,query_key,rdjb,queried_at,status,collection_evidence,created_at) VALUES(?,'business_list',?,'2','t','success',?,'c')").run(30+index,'position-'+index,JSON.stringify({pages:value}))
      old.prepare("INSERT INTO platform_relation(id,query_id,sequence_no,name_raw,raw_fields,created_at) VALUES(?,?,1,'Position',NULL,'c')").run(30+index,30+index)
    }
  })
})
afterAll(() => f?.close())
function oracle(id: number, redactor?: ReceiptRedactor) {
  const dto = readSource(f.old, 'relation', id)
  if (!dto) return null
  const { correspondences: _links, ...source } = dto
  return sanitizeEvidence(source, redactor?.knownRedactors)
}
function display(ids: number[]) {
  return readTargetRelationEvidenceDisplay(f.db, ids.map(relationId => ({ relationId }))).sources
}
function archiveRows() { return f.t.prepare('SELECT id,storage_class,byte_length,sha256,hex(bytes) bytes FROM platform_archive_value ORDER BY id').all() }
function save(name: string, value: unknown) {
  if (process.env.H1B_WITNESS_DIR) writeFileSync(join(process.env.H1B_WITNESS_DIR, name), JSON.stringify(value, null, 2))
}
it('matches independent old DTOs for three sources, raw-only and not-indexed observations with conflicts and literal NULLs', () => {
  const ids = [1,2,3,4,5,6,7,8,21,22,23,25]
  const before = archiveRows(), result = display(ids)
  for (const id of ids) expect(result.get(id), `relation ${id}`).toEqual(oracle(id))
  expect(result.get(21)).toMatchObject({ id:21, queryId:21, nameRaw:' Original ', usccRaw:' U ', aliasNameRaw:' Alias ', sourceRdjb:'2', sourcePage:9, titleRaw:'3', status:'pending', year:2024, query:{interface:'apply_list',status:'partial'} })
  expect(result.get(23)).toMatchObject({ province:null,status:null,batch:null,declareKind:null,appliedAt:null,awardBatchLabel:null,year:null,normalizationConflicts:[],sourcePage:null,sourceRdjb:null,query:{status:'failed'} })
  expect(result.get(8)).toMatchObject({ titleRaw:{0:50,1:0,2:255} })
  expect(result.get(1)).not.toHaveProperty('correspondences')
  expect(archiveRows()).toEqual(before)
  save('three-source-oracle.json', { sources:[...result], expected:ids.map(id => [id,oracle(id)]) })
})
it('retains original malformed JSON errors instead of silently dropping the selected observation', () => {
  expect(() => oracle(26)).toThrow()
  expect(() => display([26])).toThrow()
})
it('retains exact legacy page precedence and anomalous source-position values without normalization', () => {
  const values=display([30,31,32])
  for(const id of [30,31,32])expect(values.get(id)).toEqual(oracle(id))
  expect(values.get(30)).toMatchObject({sourceRdjb:' 2 ',sourcePage:0})
  expect(values.get(31)).toMatchObject({sourceRdjb:null,sourcePage:null})
  expect(values.get(32)).toMatchObject({sourceRdjb:false,sourcePage:'09'})
})
it('uses external alias namespaces and query pairing, preserving old missing-row behavior', () => {
  expect(readTargetRelationEvidenceDisplay(f.db,[{relationId:1,queryId:12}]).sources.get(1)).toBeNull()
  expect(display([999999]).get(999999)).toBeNull()
  expect(readTargetRelationEvidenceDisplay(f.db,[]).sources.size).toBe(0)
  expect(() => readTargetRelationEvidenceDisplay(f.db,[{relationId:0}])).toThrow('Invalid evidence display alias')
  expect(() => readTargetRelationEvidenceDisplay(f.db,[{relationId:1,queryId:11},{relationId:1,queryId:12}])).toThrow('Conflicting evidence display alias pair')
  expect(readTargetRelationEvidenceDisplay(f.db,[{relationId:1},{relationId:1}]).sources.size).toBe(1)
})
it('sanitizes archived evidence and known credential echoes only at output without changing bytes or hashes', () => {
  const redactor = importReceiptRedactor(f.old,{additionalSecrets:['known-secret']})
  const before = archiveRows(), result = readTargetRelationEvidenceDisplay(f.db,[{relationId:21}],redactor).sources.get(21)
  expect(result).toEqual(oracle(21,redactor))
  const text = JSON.stringify(result)
  for (const secret of ['known-secret','source-secret','raw-secret','metadata-secret','failed-secret','must-remove']) expect(text).not.toContain(secret)
  expect(text).toContain('[REDACTED]')
  expect(archiveRows()).toEqual(before)
})
it('batches selected hydration with bounded SQL and no retired tables or archive business predicates', () => {
  const inspect = (ids: number[]) => {
    f.statements.length=0
    expect(display(ids).size).toBe(ids.length)
    const trace=[...f.statements]
    expect(trace.filter(q => /\b(?:from|join)\s+["`]?platform_(?:query|relation)["`]?(?:\s|$)/i.test(q))).toEqual([])
    expect(trace.filter(q => /\b(?:where|order by|join)\b[^;]*\b(?:json_extract|json_each|json_tree)\s*\(/i.test(q))).toEqual([])
    const firstArchive=trace.findIndex(q=>q.includes('from "platform_collection_archive_ref"'))
    const selectedOwner=trace.findIndex(q=>q.includes('from "platform_legacy_relation_alias"'))
    expect(selectedOwner).toBeGreaterThanOrEqual(0)
    expect(firstArchive).toBeGreaterThan(selectedOwner)
    expect(trace.filter(q=>q.includes('AS evidence')).length).toBe(1)
    return trace
  }
  const one=inspect([1000]), many=inspect(Array.from({length:305},(_,i)=>1000+i))
  expect(many.length).toBeLessThanOrEqual(22)
  expect(many.length-one.length).toBeLessThanOrEqual(9)
  save('batch-trace.json',{one,many,oneCount:one.length,manyCount:many.length})
})
it('keeps same-version observations separately attributed and shows only current assignment changes on the next request', () => {
  const first=f.db.select().from(s.platformBusinessObservation).where(eq(s.platformBusinessObservation.id,1)).get()!
  const second=f.db.select().from(s.platformBusinessObservation).where(eq(s.platformBusinessObservation.id,2)).get()!
  expect(first.versionId).not.toBeNull()
  expect(first.versionId).toBe(second.versionId)
  const before1=display([1]).get(1), before2=display([2]).get(2), archives=archiveRows()
  const a=f.db.select().from(s.platformObservationAssignment).where(eq(s.platformObservationAssignment.observationId,1)).get()!
  f.db.insert(s.platformObservationAssignment).values({...a,revision:2,enterpriseId:2,matchBasis:'manual',verificationStatus:'confirmed',nameRaw:'Changed current name',usccRaw:'Changed current USCC',origin:'command',actor:{type:'agent',id:'display-test'},basis:'explicit'}).run()
  expect(display([1]).get(1)).toEqual({...Object(before1),enterpriseId:2,matchBasis:'manual',verificationStatus:'confirmed'})
  expect(display([1]).get(1)).toMatchObject({nameRaw:'Source',usccRaw:'U1'})
  expect(display([2]).get(2)).toEqual(before2)
  expect(archiveRows()).toEqual(archives)
})
it('uses one SQLite snapshot when another connection commits an assignment during selected archive hydration', () => {
  f.t.pragma('journal_mode=WAL')
  const writer=new Database(f.target);writer.pragma('foreign_keys=ON')
  const before=display([2]).get(2)
  let changed=false
  const db=drizzle(f.t,{schema:s,logger:{logQuery(query){
    if (!changed && query.includes('from "platform_collection_archive_ref"')) {
      changed=true
      writer.exec(`INSERT INTO platform_observation_assignment(observation_id,revision,enterprise_id,match_basis,verification_status,name_raw,uscc_raw,origin,actor,basis)
        VALUES(2,2,1,'manual','confirmed','New','New','command','{"type":"agent","id":"other"}','explicit')`)
    }
  }}})
  try {
    expect(readTargetRelationEvidenceDisplay(db,[{relationId:2}]).sources.get(2)).toEqual(before)
    expect(changed).toBe(true)
    expect(display([2]).get(2)).toEqual({...Object(before),enterpriseId:1,matchBasis:'manual',verificationStatus:'confirmed'})
  } finally {writer.close(); f.t.pragma('wal_checkpoint(TRUNCATE)'); f.t.pragma('journal_mode=DELETE')}
})
it('rejects missing query aliases, assignments, required snapshots, source capture and unknown provenance lifecycle', () => {
  const mutations=[
    'PRAGMA user_version=71609',
    "DELETE FROM platform_legacy_query_alias WHERE old_id=21",
    "DELETE FROM platform_observation_assignment WHERE observation_id=21",
    "DELETE FROM platform_observation_archive_ref WHERE owner_id=21 AND field='legacyRowSnapshot'",
    "DELETE FROM platform_apply_projection WHERE observation_id=21",
    "UPDATE platform_collection SET rule_version='unknown' WHERE id=21",
    "UPDATE platform_collection_archive_ref SET sealed=0 WHERE owner_id=21",
    "UPDATE platform_apply_projection SET source_title_rule_version='unknown' WHERE observation_id=21",
    "UPDATE platform_archive_value SET bytes=zeroblob(byte_length) WHERE id=(SELECT archive_id FROM platform_observation_archive_ref WHERE owner_id=21 AND field='rawFields')",
  ]
  for(const mutation of mutations){
    const rollback=Symbol('rollback')
    try{f.db.transaction(()=>{
      const triggers=f.t.prepare("SELECT name FROM sqlite_schema WHERE type='trigger'").all()
      for(const row of triggers){const name=schemaName(row); f.t.exec('DROP TRIGGER "'+name.replaceAll('"','""')+'"')}
      // Deliberate corrupt-fixture probes only; all trigger/row changes roll back.
      f.t.exec(mutation)
      expect(()=>display([21])).toThrow()
      throw rollback
    })}catch(error){if(error!==rollback)throw error}
  }
})
function schemaName(value: unknown): string {
  if(!value || typeof value!=='object' || !('name' in value) || typeof value.name!=='string')throw new Error('Expected trigger')
  return value.name
}
it.each((['queryList','businessList','queryBusList'] as const).flatMap(source => [undefined, '  原文\t', ' \t '].map((sourceText,index)=>({source,sourceText,index}))))('matches independent public legacy insertion for new $source writer sourceText=$sourceText and full replay with divergent target aliases', ({source,sourceText,index}) => {
  const old=new Database(':memory:');migrate(drizzle(old),{migrationsFolder:'db/migrations'})
  const db=drizzle(old,{schema})
  old.exec("INSERT INTO title(code,name_zh,level,rank) VALUES('specialized_sme','专精特新中小企业','municipal',2)")
  const row={id:'fresh-'+source,qymc:'Original',tyshxydm:'91330200712345678A',rdjb:'2',cszt:'pending',year:'2024',whpc:'B',sblx:'申请'}
  const evidence={source,status:'success' as const,effectiveConditions:{uscc:'91330200712345678A',combination:'and' as const},titleScope:{mode:source==='queryList'?'source_default' as const:'selected' as const,rdjb:source==='queryList'?[]:['2']},queriedAt:`2026-11-12T00:00:0${index}Z`,completedAt:'2026-11-12T00:01:00Z',rows:[row],dataRows:[row],pages:[{source,rdjb:source==='queryList'?null:'2',page:1,maxPage:1,status:'success' as const,fetchedCount:1,declaredTotal:1,error:null}],fetchedCount:1,declaredTotal:1,completeness:'complete' as const,fullRange:true,unfinished:[],error:null,limits:{maxRequests:1,maxRows:50,maxDurationMs:1000,pageSize:50}}
  const q=platformResultToImport(evidence)
  if(sourceText!==undefined)q.relations![0]!.sourceText=sourceText
  const request={idempotencyKey:'new-'+source,sourceKind:'platform_archive' as const,sourceIdentity:'synthetic',payload:{platformQueries:[q]}}
  vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-11-12T01:02:03Z'))
  try{
    expect(preflightRosterImport(db,request).preflight.conflicts).toEqual([])
    expect(commitRosterImport(db,request,[],{deferCandidateTasks:true}).status).toBe('committed')
    f.t.exec("UPDATE platform_legacy_alias_sequence SET high_water=10000 WHERE namespace='query' AND high_water<10000")
    f.t.exec("UPDATE platform_legacy_alias_sequence SET high_water=10000 WHERE namespace='relation' AND high_water<10000")
    const input={queryText:JSON.stringify(q),evidenceText:JSON.stringify(evidence),createdAt:'2026-11-12T01:02:03.000Z',assignments:[{nameRaw:'Original',usccRaw:'91330200712345678A',origin:'command' as const,matchBasis:'none' as const,verificationStatus:'pending' as const,actor:{type:'agent' as const,id:'test'},basis:'explicit'}]}
    const result=writeNewCollectionTarget(f.db,input), observation=result.observations[0]!
    const oldRow=db.select().from(schema.platformRelation).get()!, oldSource=readSource(db,'relation',oldRow.id)
    if(!oldSource || !('query' in oldSource))throw new Error('Expected old relation DTO')
    const {correspondences:_links,...legacy}=oldSource
    const expected={...legacy,id:observation.relationAlias,queryId:result.queryAlias,query:{...legacy.query,id:result.queryAlias}}
    const selected=[{relationId:observation.relationAlias,queryId:result.queryAlias}]
    const before=archiveRows(), actual=readTargetRelationEvidenceDisplay(f.db,selected).sources.get(observation.relationAlias)
    expect(actual).toEqual(sanitizeEvidence(expected))
    expect(result.queryAlias).not.toBe(result.collectionId)
    expect(observation.relationAlias).not.toBe(observation.observationId)
    expect(writeCollectionTarget(f.db,input).reused).toBe(true)
    expect(readTargetRelationEvidenceDisplay(f.db,selected).sources.get(observation.relationAlias)).toEqual(actual)
    expect(archiveRows()).toEqual(before)
    expect(readTargetRelationEvidenceDisplay(f.db,[{relationId:observation.relationAlias,queryId:result.collectionId}]).sources.get(observation.relationAlias)).toBeNull()
    save('new-'+source+'-'+index+'.json',{actual,expected})
  }finally{vi.useRealTimers();old.close()}
})
it('has no production consumer and keeps explicit display-only exports separate from sourceReader', () => {
  const text=readFileSync('server/utils/platform-relation-evidence-display-target.ts','utf8')
  expect(text).toContain('platform_relation_evidence_display')
  expect(text).not.toContain('readTargetPlatformEvidence(')
  // This static boundary complements the actual SQL trace; it is not a business behavior oracle.
  expect(readFileSync('server/utils/record-correspondence-api.ts','utf8')).not.toContain('platform-relation-evidence-display-target')
})
it('displays the original source alias from direct writers independently of assignment provenance', () => {
  for(const [collectionId,writer] of [[21,writeApplyTarget],[11,writeProcessTarget],[22,writeRecognizedTarget]] as const){
    const row={sequenceNo:900,relationKey:'direct-alias',nameRaw:'Original',aliasNameRaw:' Historic ',rawFields:{id:'direct-alias',rdjb:'2'},sourceText:'Original source'}
    const result=writer(f.db,{collectionId,position:{sequenceNo:900,positionState:'unknown'},row,assignment:{nameRaw:'Original',aliasNameRaw:'Decision alias',origin:'command',matchBasis:'none',verificationStatus:'pending',actor:{type:'agent',id:'test'},basis:'explicit'}})
    expect(display([result.relationAlias]).get(result.relationAlias)).toMatchObject({aliasNameRaw:'Historic',nameRaw:'Original',sourceText:'Original source'})
  }
})
