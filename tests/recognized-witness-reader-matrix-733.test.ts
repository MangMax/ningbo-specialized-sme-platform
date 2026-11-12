import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { beforeAll,afterAll,expect,it } from 'vitest'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as s from '../db/schema'
import { normalizeUscc } from '../lib/domain'
import { ensurePlatformObservation } from '../server/utils/platform-business-record'
import { witnessReaderFixture } from './helpers/recognized-witness-target-733'
import { createTargetRecognizedWitnessReader,witnessPropertyKey } from '../lib/roster/recognized-witness-target'
import { createRecognizedFilterSourceReader } from '../lib/roster/recognized-filter-source'
import { sourcePositionForSequence } from '../lib/platform/recognized-evidence'
type Case={name:string;full?:unknown;omitFull?:boolean;owner?:number|null;usccRaw?:string|null;queryStatus?:string;conditions?:Record<string,unknown>;raw?:Record<string,unknown>;pages?:unknown;scope?:string;title?:string|null;pending?:boolean;unindexed?:boolean;uncaptured?:boolean;evidence?:string|null;sequence?:number}
const cases:Case[]=[
 ...[true,false,1,2,'1',null].map(full=>({name:'fullRange '+JSON.stringify(full),full})),
 {name:'fullRange missing',omitFull:true},
 {name:'assigned other owner',owner:2}, {name:'unassigned normalized USCC',owner:null}, {name:'unassigned missing USCC',owner:null,usccRaw:null},
 {name:'pending malformed',pending:true,evidence:'invalid'}, {name:'failed query malformed',queryStatus:'failed',evidence:'invalid'}, {name:'unindexed malformed',unindexed:true,evidence:'invalid'},
 {name:'and required',conditions:{combination:'or'}},
 ...[null,false,0,'',' ','2026',2026].map(v=>({name:'returned maintenance year '+JSON.stringify(v),raw:{whpcyear:v}})),
 ...['2028-12-31',' 2028-12-31 ','2028-02-30','2028'].map(v=>({name:'validity '+v,raw:{rddqrq:v}})),
 ...['2026-2','2026-15','2026-16',' 2026-2 ',false].map(v=>({name:'batch '+String(v),raw:{whpc:v}})),
 ...[null,false,1,'2028',' 2028 ',[],{}].map(v=>({name:'condition '+JSON.stringify(v),conditions:{rddqrq:v,whpcyear:v,whpc:v}})),
 {name:'specialized scope',scope:'2',title:'specialized_sme',pages:[{status:'success',fetchedCount:1,rdjb:'2'}]},
 {name:'giant scope',scope:'3',title:'little_giant',pages:[{status:'success',fetchedCount:1,rdjb:'3'}]},
 {name:'padded scope',scope:' 1 ',title:null,pages:[]},
 ...[[],false,'',1,'2',true,'toString','__proto__','\ud800','\udfff','\ud83d\ude00\u0000'].map(rdjb=>({name:'page key '+JSON.stringify(rdjb),pages:[{status:'success',fetchedCount:1,rdjb}]})),
 {name:'failed prefix',pages:[{status:'failed',fetchedCount:99,rdjb:'2'},{status:'success',fetchedCount:1,rdjb:'1'}]},
 {name:'REAL prefix',pages:[{status:'success',fetchedCount:0.5,rdjb:'2'},{status:'success',fetchedCount:0.5,rdjb:'1'}]},
 {name:'text prefix concatenation',sequence:3,pages:[{status:'success',fetchedCount:'1',rdjb:'2'},{status:'success',fetchedCount:1,rdjb:'1'}]},
 {name:'unmatched',pages:[]},{name:'pages parse rejection',pages:'oops'},{name:'pages TypeError',pages:[null]},
 {name:'unconfirmed',pending:true},{name:'unindexed',unindexed:true},{name:'uncaptured fidelity',uncaptured:true},
 {name:'SQL NULL evidence',evidence:null},{name:'SQL syntax error',evidence:'invalid'},
 {name:'JSON5 evidence',evidence:"{source:'queryBusList',status:'success',fullRange:1,completeness:'complete',effectiveConditions:{combination:'and'},pages:[{status:'success',fetchedCount:1,rdjb:'1'}]}"},
 {name:'duplicate SQLite first JS last',evidence:'{"source":"queryBusList","status":"success","fullRange":1,"completeness":"complete","effectiveConditions":{"combination":"and","rddqrq":"2028","rddqrq":"2029"},"pages":[{"status":"success","fetchedCount":1,"rdjb":"2","rdjb":"1"}],"pages":[]}'},
]
let f:Awaited<ReturnType<typeof witnessReaderFixture>>
beforeAll(async()=>{
 f=await witnessReaderFixture(old=>{
  const db=drizzle(old,{schema:s});db.insert(s.enterprise).values([{id:1,name:'Matrix',nameNorm:'Matrix',usccNorm:'U1'},{id:2,name:'Other',nameNorm:'Other',usccNorm:'U2'}]).run()
  for(const [index,c] of cases.entries()){
   const id=index+1,body={source:'queryBusList',status:'success',fullRange:c.omitFull?undefined:Object.hasOwn(c,'full')?c.full:true,completeness:'complete',effectiveConditions:{combination:'and',...c.conditions},pages:c.pages??[{status:'success',fetchedCount:1,rdjb:'1',page:1}]}
   old.prepare("INSERT INTO platform_query(id,interface,query_key,rdjb,title_code,queried_at,status,collection_evidence,created_at) VALUES(?,'recognized_list',?,?,?,'t',?,?,'c')").run(id,c.name,c.scope??'1,2,3',c.title??null,c.queryStatus??'success',Object.hasOwn(c,'evidence')?c.evidence:JSON.stringify(body))
   db.insert(s.platformRelation).values({id,queryId:id,sequenceNo:c.sequence??1,enterpriseId:Object.hasOwn(c,'owner')?c.owner:1,usccRaw:Object.hasOwn(c,'usccRaw')?c.usccRaw:' U1 ',verificationStatus:c.pending?'pending':'confirmed',relationKey:String(id),rawFields:{id:String(id),rdjb:'3',rddqrq:'2028-12-31',whpc:'2026-2',...c.raw}}).run()
   if(!c.unindexed){const o=ensurePlatformObservation(db,id);if(c.uncaptured)old.prepare('UPDATE platform_recognized_projection SET source_maintenance_year_absent=NULL WHERE version_id=(SELECT version_id FROM platform_business_observation WHERE relation_id=?)').run(id)}
  }
  // A dedicated control observation keeps the other literal cases immutable/order-independent.
  old.prepare("INSERT INTO platform_query(id,interface,query_key,rdjb,queried_at,status,collection_evidence,created_at) VALUES(1000,'recognized_list','freshness','1','t','success',?,'c')").run(JSON.stringify({source:'queryBusList',status:'success',fullRange:true,completeness:'complete',effectiveConditions:{combination:'and'},pages:[{status:'success',rdjb:'1',page:1,fetchedCount:1}]}))
  db.insert(s.platformRelation).values({id:1000,queryId:1000,sequenceNo:1,enterpriseId:1,usccRaw:'U1',verificationStatus:'confirmed',relationKey:'freshness',rawFields:{id:'freshness',rdjb:'1',rddqrq:'2028-12-31',whpc:'2026-2'}}).run();ensurePlatformObservation(db,1000)
 })
 f.old.function('roster84_uscc',{deterministic:true},(raw:unknown)=>normalizeUscc(raw)||null)
},30000)
afterAll(()=>f?.close())
it.each(cases)('matches complete independent old typed source fields and position: $name',c=>{
 const id=cases.indexOf(c)+1,params={relationId:id,enterpriseId:1,uscc:'U1'}
 const target=createTargetRecognizedWitnessReader(f.db)
 let old:ReturnType<ReturnType<typeof createRecognizedFilterSourceReader>['read']>
 try{old=createRecognizedFilterSourceReader(f.old,'typed').read(params)}catch(error){expect(()=>target.readMany({...params,relationIds:[id]})).toThrow(error instanceof Error?error.message:'malformed JSON');return}
 if(!old){
  const result=target.readMany({...params,relationIds:[id]}).get(id)
  expect(result?.kind).toBe('unavailable')
  if(c.name==='uncaptured fidelity')expect(result).toEqual({kind:'unavailable',reason:'fidelity_uncaptured'})
  if(c.name==='unindexed')expect(result).toEqual({kind:'unavailable',reason:'unverified'})
  if(c.name==='unconfirmed'||c.name==='pending malformed')expect(result).toEqual({kind:'unavailable',reason:'unconfirmed'})
  if(c.name==='fullRange false'||c.name==='SQL NULL evidence')expect(result).toEqual({kind:'unavailable',reason:'not_applicable'})
  return
 }
 let pages:unknown
 try{pages=old.pages?JSON.parse(old.pages):null}catch{expect(target.readMany({...params,relationIds:[id]}).get(id)).toEqual({kind:'unavailable',reason:'position_rejected'});return}
 let key:string|null=null
 if(Array.isArray(pages))try{const position=sourcePositionForSequence({pages},old.sequenceNo);key=position.sourceRdjb?String(position.sourceRdjb):null}catch(error){expect(()=>target.readMany({...params,relationIds:[id]})).toThrow(error instanceof Error?error.message:'');return}
 const result=target.readMany({...params,relationIds:[id]}).get(id)
 expect(result?.kind).toBe('available')
 if(result?.kind!=='available')throw new Error('Expected captured witness')
 const {pages:_pages,...fields}=old
 const {position,...actual}=result.source
 expect(actual).toEqual(fields)
 expect(position.state==='matched'?position.rdjbKey:null).toBe(key)
})
it('batches all requested witnesses with constant select count and no JSON raw bodies or legacy entities',()=>{
 const reader=createTargetRecognizedWitnessReader(f.db);f.trace.length=0
 // Exclude original error cases; this tests bounded acquisition, not exception short-circuit order.
 const ids=cases.flatMap((c,i)=>c.name==='SQL syntax error'||c.name==='unindexed malformed'||c.name==='pages TypeError'?[]:[i+1])
 const rows=reader.readMany({enterpriseId:1,uscc:'U1',relationIds:[...ids,...ids]})
 expect(rows.size).toBe(ids.length)
 const body=f.trace.filter(q=>/from "platform_legacy_relation_alias"/i.test(q))
 expect(body).toHaveLength(1)
 expect(f.trace.join('\n')).not.toMatch(/json_extract|json_each|witness_rdjb_value|witness_page_value|candidate_scope_mask|"validity_date_raw"|"maintenance_year"|"maintenance_batch"|"title_raw"|"bytes"|(?:from|join)\s+["`]?platform_(?:query|relation)["`]?\s/i)
 writeFileSync(join(f.root,'TARGET-TRACE.json'),JSON.stringify(f.trace,null,2))
 const sql=body[0]!
 writeFileSync(join(f.root,'TARGET-PLAN.json'),JSON.stringify(f.t.prepare('EXPLAIN QUERY PLAN '+sql).all(),null,2))
})
it('retains literal UTF16 code units NULL and empty keys without normalization',()=>{
 expect(witnessPropertyKey('3100')).toBe('1');expect(witnessPropertyKey('3200')).toBe('2');expect(witnessPropertyKey('3300')).toBe('3')
 expect(witnessPropertyKey('00d8').charCodeAt(0)).toBe(0xd800);expect(witnessPropertyKey('ffdf').charCodeAt(0)).toBe(0xdfff)
 expect([...Array(3)].map((_,i)=>witnessPropertyKey('3dd800de0000').charCodeAt(i))).toEqual([0xd83d,0xde00,0])
 expect(witnessPropertyKey('')).toBe('');expect(()=>witnessPropertyKey('D800')).toThrow(/property_key/)
})
it('pins current assignment within one WAL snapshot and observes later revisions on the next request without cached results',()=>{
 const id=1000
 f.t.pragma('journal_mode=WAL')
 const writer=new Database(f.target);writer.pragma('foreign_keys=ON');const w=drizzle(writer,{schema:targetSchema})
 const reader=createTargetRecognizedWitnessReader(f.db),input={enterpriseId:1,uscc:'U1',relationIds:[id]}
 f.t.exec('BEGIN')
 try{
  expect(reader.readMany(input).get(id)?.kind).toBe('available')
  w.insert(targetSchema.platformObservationAssignment).values({observationId:id,revision:2,enterpriseId:2,usccRaw:' U1 ',matchBasis:'manual',verificationStatus:'confirmed',origin:'command',actor:{type:'agent',id:'733'},basis:'synthetic revision',recordedAt:'2026-11-12'}).run()
  expect(reader.readMany(input).get(id)?.kind).toBe('available')
 }finally{f.t.exec('COMMIT');writer.close()}
 expect(reader.readMany(input).get(id)).toEqual({kind:'unavailable',reason:'owner'})
 expect(reader.readMany({...input,enterpriseId:2}).get(id)?.kind).toBe('available')
 const independent=new Database(f.old.serialize());independent.function('roster84_uscc',(v:unknown)=>normalizeUscc(v)||null)
 try{independent.prepare('UPDATE platform_relation SET enterprise_id=2 WHERE id=?').run(id);expect(createRecognizedFilterSourceReader(independent,'typed').read({relationId:id,enterpriseId:1,uscc:'U1'})).toBeUndefined();const old=createRecognizedFilterSourceReader(independent,'typed').read({relationId:id,enterpriseId:2,uscc:'U1'})!;const actual=reader.readMany({...input,enterpriseId:2}).get(id);if(actual?.kind!=='available')throw new Error('Expected corrected owner witness');const {pages,...fields}=old;const {position,...source}=actual.source;expect(source).toEqual(fields)}finally{independent.close()}
})
import { targetSchema as targetSchema } from '../lib/platform/target-schema'
it('chunks requested aliases rather than scanning all observations and resets snapshot certification after failure',()=>{
 const reader=createTargetRecognizedWitnessReader(f.db),id=cases.findIndex(c=>c.name==='fullRange 1')+1
 f.trace.length=0
 const ids=[id,...Array.from({length:513},(_,i)=>10000+i)]
 const result=reader.readMany({enterpriseId:1,uscc:'U1',relationIds:ids})
 expect(result.size).toBe(514);expect(result.get(id)?.kind).toBe('available');expect(result.get(10000)).toEqual({kind:'unavailable',reason:'missing'})
 expect(f.trace.filter(q=>/from "platform_legacy_relation_alias"/i.test(q))).toHaveLength(3)
 expect(()=>reader.withinSnapshot(()=>{reader.readMany({enterpriseId:1,uscc:'U1',relationIds:[id]});throw new Error('cancel synthetic request')})).toThrow('cancel synthetic request')
 expect(f.t.inTransaction).toBe(false)
 f.trace.length=0
 expect(reader.readMany({enterpriseId:1,uscc:'U1',relationIds:[id]}).get(id)?.kind).toBe('available')
 expect(f.trace.some(q=>/source_schema_hash/.test(q))).toBe(true)
})
import { reserveLegacyIds } from '../lib/platform/target-archive'
import { writeNewCollectionTarget } from '../lib/platform/collection-target-command'
import { platformResultToImport } from '../lib/platform/recognized-evidence'
import type { PlatformLiveQueryResult } from '../lib/platform/live-query'
it('resolves nonidentical future relation and query aliases to the complete target owners and original typed payload',()=>{
 const uscc='91330211B733000002',raw={id:'future-alias',rdjb:'1',qymc:'AliasFuture',tyshxydm:uscc,rddqrq:'2028-12-31',whpc:'2026-2'}
 f.db.insert(targetSchema.enterprise).values({id:1000,name:'AliasFuture',nameNorm:'AliasFuture',usccNorm:uscc}).run()
 reserveLegacyIds(f.db,{query:9000,relation:8000})
 const e:PlatformLiveQueryResult={source:'queryBusList',status:'success',effectiveConditions:{name:'AliasFuture',combination:'and'},titleScope:{mode:'selected',rdjb:['1']},queriedAt:'2026-11-12T00:00:00Z',completedAt:'2026-11-12T00:01:00Z',rows:[raw],dataRows:[raw],pages:[{source:'queryBusList',rdjb:'1',page:1,maxPage:1,status:'success',fetchedCount:1,declaredTotal:1,error:null}],fetchedCount:1,declaredTotal:1,completeness:'complete',fullRange:true,unfinished:[],error:null,limits:{maxRequests:10,maxRows:50,maxDurationMs:60000,pageSize:50}}
 const q=platformResultToImport(e),created=writeNewCollectionTarget(f.db,{queryText:JSON.stringify(q),evidenceText:JSON.stringify(e),createdAt:'c',assignments:[{enterpriseId:1000,usccRaw:uscc,nameRaw:'AliasFuture',verificationStatus:'confirmed',matchBasis:'uscc',origin:'command',actor:{type:'agent',id:'B733'},basis:'synthetic exact identity'}]})
 const observation=created.observations[0]!
 expect(created.queryAlias).toBe(9001);expect(observation.relationAlias).toBe(8001)
 expect(observation.observationId).not.toBe(observation.relationAlias);expect(created.collectionId).not.toBe(created.queryAlias)
 const result=createTargetRecognizedWitnessReader(f.db).readMany({enterpriseId:1000,uscc,relationIds:[observation.relationAlias,observation.observationId]})
 expect(result.get(observation.observationId)).toEqual({kind:'unavailable',reason:'missing'})
 const actual=result.get(observation.relationAlias)
 expect(actual).toMatchObject({kind:'available',source:{queryId:9001,position:{state:'matched',rdjbKey:'1'}}})
 const oracle=new Database(f.old.serialize()),old=drizzle(oracle,{schema:s})
 try{
  oracle.function('roster84_uscc',(v:unknown)=>normalizeUscc(v)||null)
  old.insert(s.enterprise).values({id:1000,name:'AliasFuture',nameNorm:'AliasFuture',usccNorm:uscc}).run()
  old.insert(s.platformQuery).values({id:9001,interface:'recognized_list',queryKey:q.queryKey,rdjb:'1',titleCode:'innovative_sme',queriedAt:e.queriedAt,status:'success',collectionEvidence:e}).run()
  old.insert(s.platformRelation).values({id:8001,queryId:9001,sequenceNo:1,relationKey:raw.id,enterpriseId:1000,usccRaw:uscc,verificationStatus:'confirmed',matchBasis:'uscc',rawFields:raw}).run();ensurePlatformObservation(old,8001)
  const source=createRecognizedFilterSourceReader(oracle,'typed').read({relationId:8001,enterpriseId:1000,uscc})!
  if(actual?.kind!=='available')throw new Error('Expected bound alias source')
  const {pages,...fields}=source;const {position,...selected}=actual.source;expect(selected).toEqual(fields)
 }finally{oracle.close()}
})
it('raises source failures in requested witness order after batched acquisition',()=>{
 const sql=cases.findIndex(c=>c.name==='SQL syntax error')+1,js=cases.findIndex(c=>c.name==='pages TypeError')+1,reader=createTargetRecognizedWitnessReader(f.db)
 expect(()=>reader.readMany({enterpriseId:1,uscc:'U1',relationIds:[sql,js]})).toThrow(Database.SqliteError)
 expect(()=>reader.readMany({enterpriseId:1,uscc:'U1',relationIds:[js,sql]})).toThrow(TypeError)
})
