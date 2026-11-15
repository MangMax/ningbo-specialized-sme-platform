import {beforeAll,afterAll,it,expect,vi} from 'vitest'
import Database from 'better-sqlite3'
import {writeFileSync} from 'node:fs'
import {nativeImportDb} from './helpers/native-import'
import {writeNewCollectionTarget} from '../lib/platform/collection-target-command'
import {readTargetPlatformEvidence} from '../lib/platform/target-evidence-read'
import {readPlatformQueryEvidence} from '../lib/platform/evidence-read'
import {preflightRosterImport,commitRosterImport} from '../server/utils/roster-import'
import {platformResultToImport} from '../lib/platform/recognized-evidence'
let f: {db:ReturnType<typeof nativeImportDb>; t:Database.Database}
beforeAll(()=>{const db=nativeImportDb();f={db,t:db.$client}})
afterAll(()=>f?.t.close())
it.each(['apply_list','business_list','recognized_list'])('formal new %s snapshot equals public native import including materialized fields',source=>{
 const db=nativeImportDb(),old=db.$client

 let q:any={interface:source,queryKey:'independent-'+source,rdjb:'2',queriedAt:'2026-11-12T00:00:00Z',status:'success',rawResponse:'raw',relations:[{sequenceNo:1,relationKey:'A',nameRaw:' Example ',sourceText:' source ',aliasNameRaw:' alias ',rawFields:{id:'A',rdjb:'2',cszt:'pending',year:2024}}]}
 if(source==='recognized_list') q=platformResultToImport({source:'queryBusList',status:'success',effectiveConditions:{name:'Example',combination:'and'},titleScope:{mode:'selected',rdjb:['2']},queriedAt:'2026-11-12T00:00:00Z',completedAt:'2026-11-12T00:01:00Z',rows:[{id:'A',qymc:' Example ',rdjb:'2'}],dataRows:[{id:'A',qymc:' Example ',rdjb:'2'}],pages:[{source:'queryBusList',rdjb:'2',page:1,maxPage:1,status:'success',fetchedCount:1,declaredTotal:1,error:null}],fetchedCount:1,declaredTotal:1,completeness:'complete',fullRange:true,unfinished:[],error:null,limits:{maxRequests:1,maxRows:50,maxDurationMs:1000,pageSize:50}} as any)
 const req={idempotencyKey:'independent-'+source,sourceKind:'platform_archive' as const,sourceIdentity:'synthetic',payload:{platformQueries:[q]}}
 vi.useFakeTimers();vi.setSystemTime(new Date('2026-11-12T01:02:03.000Z'))
 try {
  expect(preflightRosterImport(db,req as any).preflight.conflicts).toEqual([])
  expect(commitRosterImport(db,req as any,[],{deferCandidateTasks:true}).status).toBe('committed')
  const result=writeNewCollectionTarget(f.db,{queryText:JSON.stringify(q),evidenceText:q.collectionEvidence?JSON.stringify(q.collectionEvidence):null,createdAt:'2026-11-12T01:02:03.000Z',assignments:[{nameRaw:'Example',origin:'command',matchBasis:'none',verificationStatus:'pending',actor:{type:'agent',id:'independent'},basis:'independent'}]})
  const row=old.prepare('select r.old_id id,q.old_id query_id from platform_legacy_relation_alias r join platform_business_observation o on o.id=r.observation_id join platform_legacy_query_alias q on q.collection_id=o.collection_id').get() as any
  const legacy=readPlatformQueryEvidence(db,{queryId:row.query_id,relationId:row.id,field:'relation'})
  const target=readTargetPlatformEvidence(f.db,{queryId:result.queryAlias,relationId:result.observations[0]!.relationAlias,field:'relation'})
  if(!('data' in legacy)||!('data' in target))throw new Error('Expected relation byte response')
  const oldText=Buffer.from(legacy.data!,'base64').toString(),newText=Buffer.from(target.data!,'base64').toString()
  const mappedOld=oldText.replace(/^\{"id":\d+,"queryId":\d+,/,`{"id":${result.observations[0]!.relationAlias},"queryId":${result.queryAlias},`)
  if(process.env.CANDIDATE_SCOPE_EVIDENCE_DIR) writeFileSync(process.env.CANDIDATE_SCOPE_EVIDENCE_DIR+'/'+source+'.json',JSON.stringify({q,preflight:'no conflicts',commit:'committed',legacy:oldText,target:newText,mappedOld,targetPhase:f.t.pragma('user_version',{simple:true})},null,2))
  expect(newText).toBe(mappedOld)
  const snapshot=JSON.parse(newText)
  expect(snapshot).toMatchObject({sequenceNo:1,relationKey:'A',rawFields:q.relations[0].rawFields,nameRaw:'Example',matchBasis:'none',verificationStatus:'pending'})
  if(source!=='recognized_list')expect(snapshot).toMatchObject({sourceText:'source',aliasNameRaw:'alias',titleRaw:'2',status:'pending',year:2024})
  else expect(snapshot).toMatchObject({titleRaw:'2',status:null,year:null})
 }finally{vi.useRealTimers();old.close()}
})
