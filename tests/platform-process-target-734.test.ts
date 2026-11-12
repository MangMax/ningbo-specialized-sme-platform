import { afterAll, beforeAll, expect, it } from 'vitest'
import { emptyProcessReaderFixture, processReaderFixture } from './helpers/process-target-734'
import { listPlatformBusinessProcesses, getPlatformBusinessProcess, readPlatformBusinessProcessFacts } from '../server/utils/platform-business-processes'
import { readPlatformFilterOptions } from '../server/utils/platform-filter-options'
import { listTargetBusinessProcesses, getTargetBusinessProcess, readTargetBusinessProcessOptions, readTargetBusinessProcessFacts } from '../server/utils/platform-business-processes-target'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import * as schema from '../db/schema'
import { targetSchema } from '../lib/platform/target-schema'
import { ensurePlatformObservation } from '../server/utils/platform-business-record'
import { assertExpandRuntime } from '../db/schema-phase'
import { writeProcessTarget } from '../lib/platform/process-target-writer'
import { projectionManifest } from '../upgrade/projections'

let f: Awaited<ReturnType<typeof processReaderFixture>>
beforeAll(async () => { f = await processReaderFixture() }, 120000)
afterAll(() => f?.close())

it('matches independent old process services for complete DTOs filters counts ordering and global options after every accepted migration', () => {
  const filters = [{}, ...['1','2','3'].map(rdjb => ({rdjb})), ...['1','2','3',' X '].map(titleRaw=>({titleRaw})), {platformKey:'A'}, {platformKey:'missing'}, {enterpriseId:1}, {enterpriseId:2}, {q:'Alpha'}, {q:'U2'}, {declareKind:'申请'}, {declareKind:'复核'}, {year:2024}, {year:2025}, {status:'pending'}, {batch:'B'}, {year:2024,batch:'C'}, {rdjb:'2',titleRaw:'2',year:2025,declareKind:'review',status:'done',batch:'C'}]
  for(const view of ['records','isolated'] as const) {
    for(const filter of filters) expect(listTargetBusinessProcesses({...filter,view},f.db),JSON.stringify({filter,view})).toEqual(listPlatformBusinessProcesses({...filter,view},f.old))
    for(const page of [1,2,3,100]) expect(listTargetBusinessProcesses({view,page,pageSize:1},f.db)).toEqual(listPlatformBusinessProcesses({view,page,pageSize:1},f.old))
    expect(readTargetBusinessProcessOptions(view,f.db)).toEqual(readPlatformFilterOptions({source:'business-processes',view},f.old))
  }
  for(const row of listPlatformBusinessProcesses({},f.old).rows) if(row.kind==='record') expect(getTargetBusinessProcess(f.db,row.record.id)).toEqual(getPlatformBusinessProcess(f.old,row.record.id))
  expect(readTargetBusinessProcessFacts(f.db,[1,2,3,4,5,6,7,8,999])).toEqual(readPlatformBusinessProcessFacts(f.old,[1,2,3,4,5,6,7,8,999]))
  writeFileSync(join(f.root,'OLD-TARGET-DTOS.json'),JSON.stringify({old:{records:listPlatformBusinessProcesses({},f.old),isolated:listPlatformBusinessProcesses({view:'isolated'},f.old),facts:[...readPlatformBusinessProcessFacts(f.old,[1,2,3,4,5,6,7,8])]},target:{records:listTargetBusinessProcesses({},f.db),isolated:listTargetBusinessProcesses({view:'isolated'},f.db),facts:[...readTargetBusinessProcessFacts(f.db,[1,2,3,4,5,6,7,8])]}},null,2))
})

it('keeps representative applied date order whole-record counts same-version predicates and query CSV versus display scopes separate', () => {
  expect(listTargetBusinessProcesses({platformKey:'A'},f.db)).toMatchObject({total:1,rows:[{record:{platformKey:'A'},matchedVersion:{titleRaw:'1',businessYear:2024,declareKind:'apply',appliedAt:'2025-03-01',batch:'B',awardBatchLabel:'Award'},matchedVersionCount:2,versionCount:2,observationCount:3,enterpriseIds:[1,2],enterpriseNames:['Alpha','Beta'],titleScopes:['1','2','3'],conflicts:['enterprise_assignment_conflict']}]})
  expect(listTargetBusinessProcesses({platformKey:'A',year:2024,batch:'C'},f.db).total).toBe(0)
  expect(listTargetBusinessProcesses({platformKey:'A',year:2025,rdjb:'2'},f.db).total).toBe(0)
  expect(listTargetBusinessProcesses({platformKey:'A',year:2024,rdjb:'2',enterpriseId:2},f.db)).toMatchObject({total:1,rows:[{matchedVersionCount:1,versionCount:2,observationCount:3}]})
  const row=listTargetBusinessProcesses({platformKey:'A'},f.db).rows[0]!
  if(row.kind!=='record') throw new Error('Expected record')
  const d=getTargetBusinessProcess(f.db,row.record.id)
  expect(d.versions.map(v=>[v.businessYear,v.observationCount,v.titleScopes])).toEqual([[2025,1,['1','2','3']],[2024,2,['2','3']]])
  expect(listTargetBusinessProcesses({platformKey:'A',year:2025,rdjb:'3'},f.db).total).toBe(1)
  expect(d.observations.map(o=>[o.relationId,o.queryId,o.correspondenceRefs])).toEqual([[2,12,[]],[1,11,[{id:1,status:'rejected',revision:1}]],[3,13,[]]])
  expect(d.counts).toEqual({versions:2,observations:3,versionsTruncated:false,observationsTruncated:false})
})

it('keeps eight exact original cells and SQLite options distinct from normalized facts business year whpc and personuuid', () => {
  expect(listTargetBusinessProcesses({view:'isolated',titleRaw:' X '},f.db)).toMatchObject({total:1,rows:[{relationId:5,queryId:11,titleRaw:' X ',nameRaw:' Original ',usccRaw:' U ',declareKind:'申请',businessYear:2024,status:' pending ',batch:' B ',appliedAt:' D ',awardBatchLabel:' Award ',province:' P '}]})
  expect(listTargetBusinessProcesses({view:'isolated',declareKind:'申请',titleRaw:' X '},f.db).total).toBe(0)
  expect(listTargetBusinessProcesses({view:'isolated',batch:'B',titleRaw:' X '},f.db).total).toBe(0)
  const facts=readTargetBusinessProcessFacts(f.db,[5,7,8])
  expect(facts.get(5)).toMatchObject({titleRaw:'1',year:2024,declareKind:'apply',batch:'B',awardBatchLabel:'Award',province:'P',archiveProcessFacts:{batch:'B',awardBatchLabel:'Award'}})
  expect(facts.get(8)).toMatchObject({titleRaw:null,year:null,status:null,projectionVersionId:null,modeledFields:[]})
  expect(readTargetBusinessProcessFacts(f.db,[4]).get(4)).toMatchObject({year:null,archiveProcessFacts:{year:2000},batch:'B',awardBatchLabel:'Award'})
  expect(readTargetBusinessProcessFacts(f.db,[1,2]).get(1)).toMatchObject({projectionVersionId:1,status:'pending',archiveProcessFacts:{status:'pending'},normalizationConflicts:[]})
  expect(readTargetBusinessProcessFacts(f.db,[1,2]).get(2)).toMatchObject({projectionVersionId:1,status:'pending',archiveProcessFacts:{status:null},normalizationConflicts:[{field:'status',storedValue:'other',rawValue:'pending'}]})
  const conflict=readTargetBusinessProcessFacts(f.db,[6]).get(6)!
  expect(conflict.normalizationConflicts).toEqual([{field:'province',storedValue:'other',rawValue:'P'},{field:'status',storedValue:'other',rawValue:'pending'},{field:'batch',storedValue:'other',rawValue:'B'},{field:'declareKind',storedValue:'review',rawValue:'apply'},{field:'appliedAt',storedValue:'other',rawValue:'2025-03-01'},{field:'awardBatchLabel',storedValue:'other',rawValue:'Award'},{field:'year',storedValue:2020,rawValue:2024}])
  expect(conflict.archiveProcessFacts).toEqual({province:null,status:null,batch:null,declareKind:null,appliedAt:null,awardBatchLabel:null,year:null})
  expect(readTargetBusinessProcessOptions('isolated',f.db).statuses).toContain('\t')
  expect(readTargetBusinessProcessOptions('isolated',f.db).titles).toContainEqual(Buffer.from('3200ff','hex'))
})

it('retains not-indexed raw-only real NULL and anomalous exact cells using independent literal expectations', async () => {
  const x=await processReaderFixture(true)
  try {
    const r=listTargetBusinessProcesses({view:'isolated'},x.db)
    expect(r.total).toBe(4)
    expect(r.rows.find(r=>r.kind==='observation'&&r.relationId===7)).toEqual({kind:'observation',relationId:7,queryId:11,queriedAt:'2026-01-01',queryKey:'Q1',queryStatus:'success',sequenceNo:3,enterpriseId:null,enterpriseName:null,identityState:'not_indexed',contentState:'not_indexed',titleRaw:null,nameRaw:' Raw only ',usccRaw:null,declareKind:null,businessYear:null,status:null,batch:null,appliedAt:null,awardBatchLabel:null,province:null,titleScopes:['2','3']})
    expect(r.rows.find(r=>r.kind==='observation'&&r.relationId===8)).toMatchObject({identityState:'not_indexed',contentState:'not_indexed',titleRaw:Buffer.from('3200ff','hex'),status:'\t',batch:'',nameRaw:' No raw '})
    expect(readTargetBusinessProcessFacts(x.db,[7,8])).toEqual(readPlatformBusinessProcessFacts(x.old,[7,8]))
  } finally {x.close()}
})

it('preserves SQL first duplicate-key and BOM fact-title independently of version and exact stored titles', async () => {
  const x=await processReaderFixture(false,source=>{
    const insert=source.prepare("INSERT INTO platform_relation(id,query_id,sequence_no,name_raw,raw_fields,title_raw,created_at) VALUES(?,13,?,'Syntax',?,'Stored','c')")
    for(const [i,raw] of ['{"rdjb":"2","rdjb":"3"}','{"rdjb":false,"rdjb":"3"}','{"rd\\u006ab":" 2 ","rdjb":"3"}','\uFEFF{"rdjb":"2"}','{"rdjb":0}','{"rdjb":"  "}'].entries()) insert.run(i+20,i+3,raw)
    source.exec("UPDATE platform_relation SET title_raw='Stored' WHERE id BETWEEN 20 AND 25")
  })
  try {
    const facts=readTargetBusinessProcessFacts(x.db,[20,21,22,23,24,25])
    expect([...facts.values()].map(v=>[v.relationId,v.titleRaw])).toEqual([[20,'2'],[21,null],[22,'2'],[23,null],[24,null],[25,null]])
    expect(facts).toEqual(readPlatformBusinessProcessFacts(x.old,[20,21,22,23,24,25]))
    expect(listTargetBusinessProcesses({view:'isolated',titleRaw:'Stored'},x.db)).toMatchObject({total:6})
  } finally{x.close()}
})

it('keeps original revision-one names and independently fresh current owners for shared versions and isolated observations', () => {
  expect(()=>f.db.transaction(tx=>{
    f.t.exec("INSERT INTO platform_observation_assignment(observation_id,revision,enterprise_id,match_basis,verification_status,name_raw,uscc_raw,origin) SELECT observation_id,2,1,'manual','pending','Changed','Changed','command' FROM platform_legacy_relation_alias WHERE old_id=2")
    expect(listTargetBusinessProcesses({enterpriseId:2,platformKey:'A'},tx).total).toBe(0)
    expect(listTargetBusinessProcesses({platformKey:'A'},tx)).toMatchObject({rows:[{enterpriseIds:[1],enterpriseNames:['Alpha'],conflicts:[]}]})
    f.t.exec("INSERT INTO platform_observation_assignment(observation_id,revision,enterprise_id,match_basis,verification_status,name_raw,uscc_raw,origin) SELECT observation_id,2,2,'manual','pending','Changed','Changed','command' FROM platform_legacy_relation_alias WHERE old_id=5")
    expect(listTargetBusinessProcesses({view:'isolated',enterpriseId:2},tx)).toMatchObject({total:1,rows:[{enterpriseId:2,enterpriseName:'Beta',nameRaw:' Original ',usccRaw:' U '}]})
    expect(readTargetBusinessProcessFacts(tx,[5]).get(5)).toMatchObject({nameRaw:' Original ',usccRaw:' U '})
    throw new Error('test rollback')
  })).toThrow('test rollback')
})

it('uses one request snapshot and sees committed assignment corrections on the next request', () => {
  f.t.pragma('journal_mode=WAL')
  const other=new Database(f.target)
  let fired=false
  const connection=new Database(f.target,{verbose:q=>{
    if(!fired&&String(q).startsWith('select count(distinct')) {
      fired=true
      other.exec("INSERT INTO platform_observation_assignment(observation_id,revision,enterprise_id,match_basis,verification_status,origin) SELECT observation_id,2,1,'manual','pending','command' FROM platform_legacy_relation_alias WHERE old_id=2")
    }
  }})
  try {
    other.pragma('foreign_keys=ON')
    connection.pragma('foreign_keys=ON')
    const db=drizzle(connection,{schema:targetSchema})
    expect(listTargetBusinessProcesses({enterpriseId:2,platformKey:'A'},db)).toMatchObject({total:1,rows:[{enterpriseIds:[1,2],enterpriseNames:['Alpha','Beta']}]})
    expect(fired).toBe(true)
    expect(listTargetBusinessProcesses({enterpriseId:2,platformKey:'A'},f.db).total).toBe(0)
    expect(getTargetBusinessProcess(f.db,1).observations.find(o=>o.relationId===2)?.enterpriseId).toBe(1)
  } finally {connection.close();other.close()}
})

it('rejects uncaptured missing projection aliases and original assignment globally before empty filters paging options or facts', () => {
  const before=projectionManifest(f.t)
  for(const [table,statement] of [
    ['platform_business_projection',"UPDATE platform_business_projection SET exact_stored_state='uncaptured',exact_title_raw=NULL,exact_declare_kind=NULL,exact_year=NULL,exact_status=NULL,exact_batch=NULL,exact_applied_at=NULL,exact_award_batch_label=NULL,exact_province=NULL,exact_stored_rule=NULL,exact_stored_origin=NULL,exact_stored_reason='test uncaptured' WHERE observation_id=(SELECT observation_id FROM platform_legacy_relation_alias WHERE old_id=5)"],
    ['platform_business_projection',"UPDATE platform_business_projection SET sql_fact_title_state='uncaptured',sql_fact_title=NULL,sql_fact_title_rule=NULL,sql_fact_title_reason='test uncaptured' WHERE observation_id=(SELECT observation_id FROM platform_legacy_relation_alias WHERE old_id=5)"],
    ['platform_business_projection',"DELETE FROM platform_business_projection WHERE observation_id=(SELECT observation_id FROM platform_legacy_relation_alias WHERE old_id=5)"],
    ['platform_legacy_relation_alias','DELETE FROM platform_legacy_relation_alias WHERE old_id=5'],
    ['platform_legacy_query_alias','DELETE FROM platform_legacy_query_alias WHERE old_id=11'],
    ['platform_observation_assignment','DELETE FROM platform_observation_assignment WHERE observation_id=(SELECT observation_id FROM platform_legacy_relation_alias WHERE old_id=5) AND revision=1'],
  ]) {
    expect(()=>f.db.transaction(tx=>{
      const triggers=f.t.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger' AND tbl_name=?").all(table) as {name:string,sql:string}[]
      for(const t of triggers) f.t.exec(`DROP TRIGGER "${t.name}"`)
      f.t.pragma('defer_foreign_keys=ON');f.t.exec(statement!)
      for(const t of triggers) f.t.exec(t.sql)
      for(const action of [()=>listTargetBusinessProcesses({platformKey:'missing',page:999},tx),()=>listTargetBusinessProcesses({view:'isolated',year:9999},tx),()=>readTargetBusinessProcessOptions('records',tx),()=>readTargetBusinessProcessOptions('isolated',tx),()=>getTargetBusinessProcess(tx,1),()=>readTargetBusinessProcessFacts(tx,[1]),()=>readTargetBusinessProcessFacts(tx,[])]) expect(action).toThrow(/uncaptured/)
      throw new Error('test rollback')
    }),statement).toThrow('test rollback')
    expect(projectionManifest(f.t)).toEqual(before)
  }
})

it('preserves invalid filter and identifier errors and valid empty results without switching the runtime guard', () => {
  for(const input of [{unknown:true},{view:'wrong'},{year:0},{pageSize:501},{q:''}]) {
    let oldError:unknown;try{listPlatformBusinessProcesses(input,f.old)}catch(e){oldError=e}
    expect(()=>listTargetBusinessProcesses(input,f.db)).toThrowError(expect.objectContaining({message:(oldError as Error).message,statusCode:400,code:'invalid_business_process_filter'}))
  }
  for(const id of [0,-1,1.5,Number.MAX_SAFE_INTEGER+1,NaN]) expect(()=>getTargetBusinessProcess(f.db,id)).toThrowError(expect.objectContaining({statusCode:400,code:'invalid_business_process_id',message:'recordId must be a positive safe integer'}))
  expect(()=>getTargetBusinessProcess(f.db,999)).toThrowError(expect.objectContaining({statusCode:404,code:'business_process_not_found',message:'Business process record not found'}))
  expect(listTargetBusinessProcesses({platformKey:'missing',page:50},f.db)).toEqual({view:'records',rows:[],total:0,page:50,pageSize:25})
  expect(readTargetBusinessProcessFacts(f.db,[])).toEqual(new Map())
  expect(()=>assertExpandRuntime(f.t)).toThrow(/Finalized\/offline/)
})

it('preserves old left-join NULL fields and untyped facts when a version projection is absent', () => {
  expect(()=>f.db.transaction(tx=>{
    const barrier=f.t.prepare("SELECT sql FROM sqlite_schema WHERE name='platform_process_stored_no_delete'").get() as {sql:string}
    f.t.exec('DROP TRIGGER platform_process_stored_no_delete')
    f.t.exec('DELETE FROM platform_business_projection WHERE version_id=1')
    f.t.exec(barrier.sql)
    expect(listTargetBusinessProcesses({platformKey:'A'},tx)).toMatchObject({total:1,rows:[{matchedVersion:{businessYear:2025},versionCount:2,observationCount:3}]})
    expect(getTargetBusinessProcess(tx,1).versions.find(v=>v.versionId===1)).toMatchObject({versionId:1,titleRaw:null,declareKind:null,businessYear:null,appliedAt:null,status:null,batch:null,awardBatchLabel:null,province:null,nameRaw:null,usccRaw:null,ruleVersion:null,observationCount:2})
    expect(getTargetBusinessProcess(tx,1).observations.find(o=>o.relationId===1)?.version).toMatchObject({versionId:1,businessYear:null,status:null})
    expect(readTargetBusinessProcessFacts(tx,[1]).get(1)).toMatchObject({projectionVersionId:null,modeledFields:[],year:2024,status:'pending',batch:'B',awardBatchLabel:'Award'})
    throw new Error('test rollback')
  })).toThrow('test rollback')
}, 30000)

it('matches old detail at actual one-hundred version and two-hundred observation truncation boundaries', async () => {
  const x=await processReaderFixture(false,source=>{
    const db=drizzle(source,{schema})
    const raw={id:'A',rdjb:'1',sblx:'申请',year:2024,sqsj:'2025-03-01',cszt:'pending',whpc:'B',personuuid:'Award',szsfmc:'P'}
    for(let i=0;i<200;i++) {
      const id=1000+i
      db.insert(schema.platformRelation).values({id,queryId:11,sequenceNo:10+i,enterpriseId:1,relationKey:'A',nameRaw:'Source',usccRaw:'U1',rawFields:i<100?{...raw,marker:i,...(i===99?{sqsj:null}:{})}:raw,createdAt:'c'}).run()
      ensurePlatformObservation(db,id)
    }
  })
  try {
    const detail=getTargetBusinessProcess(x.db,1)
    expect(detail).toEqual(getPlatformBusinessProcess(x.old,1))
    expect(detail.counts).toEqual({versions:102,observations:203,versionsTruncated:true,observationsTruncated:true})
    expect(detail.versions).toHaveLength(100);expect(detail.observations).toHaveLength(200)
    expect(listTargetBusinessProcesses({platformKey:'A',pageSize:1},x.db)).toMatchObject({rows:[{versionCount:102,observationCount:203,matchedVersionCount:102,matchedVersion:{versionId:103,appliedAt:'2025-03-01'}}]})
  } finally{x.close()}
}, 30000)

it('uses external relation and query aliases for authenticated command observations and exact correspondence owners', () => {
  expect(()=>f.db.transaction(tx=>{
    f.t.exec("UPDATE platform_legacy_alias_sequence SET high_water=1000 WHERE namespace='relation'")
    const collection=f.t.prepare('SELECT collection_id id FROM platform_legacy_query_alias WHERE old_id=11').get() as {id:number}
    const written=writeProcessTarget(tx,{collectionId:collection.id,position:{sequenceNo:4,positionState:'unknown'},row:{sequenceNo:4,relationKey:'A',nameRaw:'Command',rawFields:{id:'A',rdjb:'1',sblx:'申请',year:2024,sqsj:'2025-03-01',cszt:'pending',whpc:'B',personuuid:'Award',szsfmc:'P'}},assignment:{enterpriseId:1,nameRaw:'Command',matchBasis:'manual',verificationStatus:'pending',origin:'command',actor:{type:'agent',id:'reader-test'},basis:'explicit synthetic command'}})
    expect(written.relationAlias).toBe(1001);expect(written.observationId).not.toBe(written.relationAlias)
    expect(readTargetBusinessProcessFacts(tx,[written.observationId])).toEqual(new Map())
    expect(readTargetBusinessProcessFacts(tx,[1001]).get(1001)).toMatchObject({relationId:1001,interface:'business_list',year:2024,titleRaw:'1',batch:'B',awardBatchLabel:'Award'})
    const edge=tx.insert(schema.recordCorrespondence).values({enterpriseId:1,titleCode:'specialized_sme',relationId:1001,edgeKey:'new-edge',type:'event_process',role:'candidate',status:'rejected',revision:1,targetIdentity:{},provenance:{},sourceFingerprint:'f',ruleId:'r',ruleVersion:'v',createdAt:'c'}).returning({id:schema.recordCorrespondence.id}).get()
    const detail=getTargetBusinessProcess(tx,written.recordId!)
    expect(detail.observations.find(o=>o.relationId===1001)).toMatchObject({relationId:1001,queryId:11,sequenceNo:4,enterpriseId:1,correspondenceRefs:[{id:edge.id,status:'rejected',revision:1}]})
    expect(detail.observations.find(o=>o.relationId===2)?.correspondenceRefs).toEqual([])
    throw new Error('test rollback')
  })).toThrow('test rollback')
})

it('bounds hydration to selected records and detail limits and records actual SQL plans without legacy or archive business reads', () => {
  f.statements.length=0
  const result=listTargetBusinessProcesses({pageSize:1},f.db),list=[...f.statements]
  getTargetBusinessProcess(f.db,1);readTargetBusinessProcessOptions('records',f.db);readTargetBusinessProcessOptions('isolated',f.db);readTargetBusinessProcessFacts(f.db,[1,5,7,8]);listTargetBusinessProcesses({year:2024,rdjb:'2',pageSize:1},f.db);listTargetBusinessProcesses({view:'isolated',titleRaw:' X ',pageSize:1},f.db)
  const statements=[...f.statements],text=statements.join('\n')
  expect(text).not.toMatch(/\b(?:from|join)\s+["`]?platform_(?:query|relation)["`]?\s/i)
  expect(text).not.toMatch(/\b(?:from|join)\s+["`]?platform_archive_value|\bjson_\w*\s*\(|canonical_raw_json|legacyRowSnapshot/i)
  const page=list.findIndex(q=>q.startsWith('with "matched"')&&q.includes('limit 1'))
  expect(page).toBeGreaterThan(0)
  const row=result.rows[0]!;if(row.kind!=='record')throw new Error('Expected record')
  const hydration=list.slice(page+1).filter(q=>/^select/i.test(q)&&/from "platform_business_observation"|from "platform_business_record_version"/.test(q))
  expect(hydration.length).toBeGreaterThan(0)
  expect(hydration.filter(q=>!new RegExp('\\bin \\('+row.record.id+'(?:\\.0)?\\)|record_id" = '+row.record.id+'(?:\\.0)?').test(q))).toEqual([])
  const plans=statements.filter(q=>q.startsWith('with "matched"')||/^select distinct/i.test(q)&&q.includes('exact_title_raw')).map(query=>({query,plan:f.t.prepare('EXPLAIN QUERY PLAN '+query).all()}))
  expect(plans.length).toBeGreaterThan(1)
  expect(text).toContain('limit 100');expect(text).toContain('limit 200')
  writeFileSync(join(f.root,'READER-SQL.json'),JSON.stringify({statements,plans,hydration,rowCounts:{observations:f.t.prepare('SELECT count(*) n FROM platform_business_observation').get(),versions:f.t.prepare('SELECT count(*) n FROM platform_business_record_version').get()}},null,2))
})

it('returns genuinely empty migrated process views options and facts without confusing NULL and unknown capture', async () => {
  const x=await emptyProcessReaderFixture()
  try {
    for(const view of ['records','isolated'] as const) {
      expect(listTargetBusinessProcesses({view},x.db)).toEqual({view,rows:[],total:0,page:1,pageSize:25})
      expect(readTargetBusinessProcessOptions(view,x.db)).toEqual({titles:[],declareKinds:[],years:[],statuses:[],batches:[],districts:[],validityDates:[]})
    }
    expect(readTargetBusinessProcessFacts(x.db,[1])).toEqual(new Map())
    expect(()=>getTargetBusinessProcess(x.db,1)).toThrowError(expect.objectContaining({statusCode:404,code:'business_process_not_found'}))
  } finally{x.close()}
})

it('batches facts at four-hundred external aliases without materializing unrelated payloads or changing missing-id behavior', () => {
  const ids=Array.from({length:1001},(_,i)=>i+1)
  f.statements.length=0
  expect(readTargetBusinessProcessFacts(f.db,ids)).toEqual(readPlatformBusinessProcessFacts(f.old,ids))
  const queries=f.statements.filter(q=>q.startsWith('select')&&q.includes('from "platform_legacy_relation_alias"'))
  expect(queries).toHaveLength(3)
  expect(queries.join('\n')).not.toMatch(/platform_archive_value|"bytes"|json_extract|canonical_raw_json/)
})
