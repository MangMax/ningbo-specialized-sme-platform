import { nativeImportDb } from '../../roster/imports/fixtures/native-import'
import { initializeDb } from '../../../db/client'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { copyFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import * as schema from '../../../db/schema'
import { targetSchema } from '../../../layers/sme-roster/lib/platform/target-schema'
import { reserveLegacyIds } from '../../../layers/sme-roster/lib/platform/target-archive'
import { platformResultToImport } from '../../../layers/sme-roster/lib/platform/recognized-evidence'
import type { PlatformLiveQueryResult } from '../../../layers/sme-roster/lib/platform/live-query'
import type { RosterImportRequest } from '../../../layers/sme-roster/lib/roster-import-client'
import { preflightRosterImport, commitRosterImport, replayRosterImport } from '../../../layers/sme-roster/server/utils/roster-import'

let f: {root:string;target:string;legacySource?:string}, t: Database.Database, db: ReturnType<typeof drizzle<typeof schema>>
let serial = 0
const trace: string[] = []
beforeAll(() => {
 const root=mkdtempSync(join(tmpdir(),'native-history752-')),target=join(root,'base.sqlite')
 const base=initializeDb({dbPath:target,create:true})
 base.$client.exec("INSERT INTO enterprise(id,name,name_norm,uscc_norm) VALUES(1,'Alpha','Alpha','91330200712345678A'),(2,'Beta','Beta','91330200712345678B')")
 base.$client.close();f={root,target}
})
beforeEach(() => {
  const p = join(f.root, `case-${++serial}.sqlite`); copyFileSync(f.target, p)
  t = new Database(p, { verbose: q => trace.push(String(q)) }); t.pragma('foreign_keys=ON')
  db = drizzle(t, { schema })
  reserveLegacyIds(drizzle(t, { schema: targetSchema }), { query: 8000, relation: 9000 })
  trace.length = 0
})

import { listPlatformQueries } from '../../../layers/sme-roster/lib/platform/read'
function collection(source: PlatformLiveQueryResult['source'] = 'businessList', time = '2026-11-13T00:00:00Z', rows: Record<string,string>[] = [{ id: 'NORMAL', rdjb: '2', qymc: 'Alpha', tyshxydm: '91330200712345678A', cszt: '终审通过', year: '2024', sblx: '申请' }]): PlatformLiveQueryResult {
  return { source, status: rows.length ? 'success' : 'no_record', effectiveConditions: { uscc: '91330200712345678A', combination: 'and' },
    titleScope: source === 'queryList' ? { mode: 'source_default', rdjb: [] } : { mode: 'selected', rdjb: ['2'] },
    queriedAt: time, completedAt: time, rows, dataRows: rows,
    pages: [{ source, rdjb: source === 'queryList' ? null : '2', page: 1, maxPage: 1, fetchedCount: rows.length, declaredTotal: rows.length, status: 'success', error: null }],
    fetchedCount: rows.length, declaredTotal: rows.length, completeness: 'complete', fullRange: true, unfinished: [], error: null,
    limits: { maxRequests: 10, maxRows: 100, maxDurationMs: 1000, pageSize: 50 } }
}
function request(sources = [collection()], key = 'normal'): RosterImportRequest {
  return { idempotencyKey: key, sourceKind: 'platform_archive', sourceIdentity: 'synthetic-751', payload: { platformQueries: sources.map(platformResultToImport) } }
}
function commit(input: RosterImportRequest) { return commitRosterImport(db,input,[],{deferCandidateTasks:true}) }
function noLegacy() {
  const root = process.env.CANDIDATE_SCOPE_EVIDENCE_DIR
  if (root) writeFileSync(join(root, `history752-sql-${serial}.json`), JSON.stringify(trace.filter(q => /^\s*(?:select|pragma)\b/i.test(q)), null, 2))
  expect(trace.filter(q => /\b(?:from|join|into|update)\s+["`]?platform_(?:query|relation)["`]?\b/i.test(q))).toEqual([])
  expect(t.pragma('foreign_key_check')).toEqual([])
}
const scope = { enterpriseId: 1, titleCode: 'specialized_sme' as const, direction: 'missing_in_miit' as const }

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); t?.close() })
afterAll(() => vi.unstubAllGlobals())
it('reads ordinary target imports through the generic history entry with literal public IDs and counts', () => {
 const input=request(); expect(preflightRosterImport(db,input).preflight.conflicts).toEqual([])
 expect(commit(input).status).toBe('committed'); expect(replayRosterImport(db,input).status).toBe('replayed')
 expect(listPlatformQueries(db,{view:'summary'})).toMatchObject({total:1,counts:{success:1},rows:[{relationsIncluded:false,query:{id:8001,relationCount:1},relations:[]}]})
})

import { readPlatformQueryEvidence } from '../../../layers/sme-roster/lib/platform/evidence-read'
import { eq } from 'drizzle-orm'
import type { PlatformQueryFilter } from '../../../layers/sme-roster/lib/platform/read'

// A second native DB exercises independently committed source inputs; literal assertions below
// own IDs, business fields, counts and budgets. Each fixture commits to a separate database.
function oldOracle() {
 const database=nativeImportDb(),connection=database.$client
 connection.exec("INSERT INTO enterprise(id,name,name_norm,uscc_norm) VALUES(1,'Alpha','Alpha','91330200712345678A'),(2,'Beta','Beta','91330200712345678B')")
 reserveLegacyIds(database,{query:8000,relation:9000})
 return {connection,db:database,close(){connection.close()}}
}
function frozen() {vi.useFakeTimers({toFake:['Date']});vi.setSystemTime('2026-11-13T00:00:00Z')}
it.each(['queryList','businessList','queryBusList'] as const)('matches independently imported native %s history and every evidence field through nonidentity public aliases', source => {
 frozen();const oracle=oldOracle()
 try {
  const input=request([collection(source,undefined,[{id:'NORMAL',rdjb:'2',qymc:'Alpha',tyshxydm:'91330200712345678A',cszt:'终审通过',year:'2024',sblx:'申请',whpc:'2024-1',sqsj:'2024-01-02',personuuid:'第二批',szsfmc:'浙江',note:'🙂尾'}])])
  input.payload.platformQueries![0]!.rawResponse='原文🙂尾'
  expect(commit(input).status).toBe('committed')
  expect(commitRosterImport(oracle.db,input,[],{deferCandidateTasks:true}).status).toBe('committed')
  const actual=listPlatformQueries(db,{includeRawResponse:true}),expected=listPlatformQueries(oracle.db,{includeRawResponse:true})
  expect(actual).toEqual(expected)
  expect(actual).toMatchObject({total:1,counts:{success:1},rows:[{query:{id:8001,relationCount:1,rawResponse:'原文🙂尾'},relations:[{id:9001,queryId:8001,nameRaw:'Alpha',matchedName:'Alpha',usccRaw:'91330200712345678A',normalizationConflicts:[]}]}]})
  expect(t.prepare('select id from platform_collection').get()).toEqual({id:1})
  for(const field of ['relations','rawResponse','collectionEvidence','legacyProvenance','relation'] as const)for(const offset of [0,1,4,7,100000]) {
   const args={queryId:8001,relationId:9001,field,offset,length:3}
   expect(readPlatformQueryEvidence(db,args)).toEqual(readPlatformQueryEvidence(oracle.db,args))
  }
  const literal=readPlatformQueryEvidence(db,{queryId:8001,field:'rawResponse',offset:7,length:2})
  expect(literal).toMatchObject({totalBytes:13,byteLength:2,data:Buffer.from('原文🙂尾').subarray(7,9).toString('base64')})
  for(const args of [{queryId:1,field:'rawResponse' as const},{queryId:8001,field:'relation' as const,relationId:1},{queryId:8002,field:'relation' as const,relationId:9001}])expect(()=>readPlatformQueryEvidence(db,args)).toThrowError(expect.objectContaining({statusCode:404}))
  noLegacy()
 }finally{oracle.close()}
})
it('keeps each shared-version observation and SQL filter intersection counts with stable ties deep and empty pages',()=>{
 frozen();const oracle=oldOracle()
 try {
  const inputs=[request(['queryList','businessList','queryBusList'].map(s=>collection(s as PlatformLiveQueryResult['source'])),'three'),request([collection('businessList','2026-11-14T00:00:00Z')],'repeat'),request([collection('businessList','2026-11-15T00:00:00Z',[])],'empty')]
  for(const input of inputs){expect(commit(input).status).toBe('committed');expect(commitRosterImport(oracle.db,input,[],{deferCandidateTasks:true}).status).toBe('committed')}
  expect(t.prepare('select count(*) n from platform_business_record_version').get()).toEqual({n:3})
  expect(t.prepare('select count(*) n from platform_business_observation').get()).toEqual({n:4})
  const cases: [PlatformQueryFilter,number[]][]=[
   [{},[8005,8004,8003,8002,8001]],[{queryId:8002},[8002]],[{queryId:1},[]],
   [{interface:'apply_list'},[8001]],[{interface:'recognized_list'},[8003]],[{interface:'business_list'},[8005,8004,8002]],
   [{queryKey:'91330200712345678A'},[8005,8004,8003,8002,8001]],[{queryKey:' 91330200712345678A '},[]],
   [{uscc:'91330200712345678A'},[8005,8004,8003,8002,8001]],[{uscc:'missing'},[]],
   [{enterpriseId:1},[8004,8003,8002,8001]],[{enterpriseId:2},[]],[{status:'no_record'},[8005]],
   [{titleCode:'specialized_sme'},[8005,8004,8003,8002]],[{titleCode:'little_giant'},[]],
   [{titleCode:'specialized_sme',interface:'business_list',enterpriseId:1,status:'success'},[8004,8002]],
   [{queryId:8003,uscc:'91330200712345678A',enterpriseId:1,titleCode:'specialized_sme'},[8003]],
   [{queryId:8003,interface:'business_list'},[]],[{pageSize:1,page:3},[8003]],[{pageSize:1,page:5},[8001]],[{page:99,pageSize:1},[]],
  ]
  for(const [filter,ids] of cases)for(const view of ['full','summary'] as const){
   const actual=listPlatformQueries(db,{...filter,view})
   expect(actual,JSON.stringify(filter)).toEqual(listPlatformQueries(oracle.db,{...filter,view}))
   expect(actual.rows.map(r=>r.query.id)).toEqual(ids)
  }
  expect(listPlatformQueries(db,{view:'summary'}).counts).toEqual({success:4,no_record:1})
  expect(listPlatformQueries(db,{pageSize:1}).total).toBe(5)
  noLegacy()
 }finally{oracle.close()}
})
it('uses current assignment for enterprise membership and matchedName while retaining original identity and immutable evidence bytes',()=>{
 expect(commit(request()).status).toBe('committed')
 const before=listPlatformQueries(db).rows[0]!.relations[0]!,archives=t.prepare('select id,sha256,byte_length from platform_archive_value order by id').all()
 const original=db.select().from(targetSchema.platformObservationAssignment).where(eq(targetSchema.platformObservationAssignment.observationId,1)).get()!
 db.insert(targetSchema.platformObservationAssignment).values({...original,revision:2,enterpriseId:2,nameRaw:'Changed',usccRaw:'changed',aliasNameRaw:'changed',matchBasis:'manual',verificationStatus:'confirmed',origin:'command',actor:{type:'agent',id:'752'},basis:'synthetic attribution'}).run()
 expect(listPlatformQueries(db,{enterpriseId:1}).total).toBe(0)
 const result=listPlatformQueries(db,{enterpriseId:2,uscc:'91330200712345678A'})
 expect(result.rows[0]!.relations[0]).toEqual({...before,enterpriseId:2,matchedName:'Beta',matchBasis:'manual',verificationStatus:'confirmed'})
 expect(listPlatformQueries(db,{uscc:'changed'}).total).toBe(0)
 expect(t.prepare('select id,sha256,byte_length from platform_archive_value order by id').all()).toEqual(archives)
 noLegacy()
})
it('summary reads no archive or relation payload and retains counts while summary plus raw and evidence parameters reject invalid boundaries',()=>{
 expect(commit(request()).status).toBe('committed');trace.length=0
 expect(listPlatformQueries(db,{view:'summary'})).toMatchObject({rows:[{relationsIncluded:false,relations:[],query:{id:8001,relationCount:1}}]})
 expect(trace.filter(q=>/\b(?:from|join)\s+["`]?platform_(?:archive_value|observation_archive_ref|collection_archive_ref|apply_projection|business_projection|recognized_projection)\b/i.test(q))).toEqual([])
 expect(()=>listPlatformQueries(db,{view:'summary',includeRawResponse:true})).toThrowError(expect.objectContaining({statusCode:400}))
 for(const invalid of [{queryId:0},{queryId:1.5},{length:65537},{length:0},{offset:-1},{page:0},{pageSize:201}])expect(()=>readPlatformQueryEvidence(db,{queryId:8001,field:'rawResponse',...invalid})).toThrowError(expect.objectContaining({statusCode:400}))
 expect(()=>readPlatformQueryEvidence(db,{queryId:8001,field:'relation'})).toThrowError(expect.objectContaining({statusCode:400}))
 noLegacy()
})

it('enforces exact 4MiB query and 8MiB page budgets before payload hydration and isolates giant nonselected archives',()=>{
 frozen();const oracle=oldOracle(),limit=4*1024*1024
 const save=(size:number,key:string,time:string,iface:'apply_list'|'business_list'='apply_list')=>{
  const input: RosterImportRequest={idempotencyKey:key,sourceKind:'platform_archive',sourceIdentity:'synthetic752',payload:{platformQueries:[{interface:iface,queryKey:key,rdjb:'',queriedAt:time,status:'no_record',rawResponse:'x'.repeat(size),relations:[]}]}}
  expect(commit(input).status).toBe('committed');expect(commitRosterImport(oracle.db,input,[],{deferCandidateTasks:true}).status).toBe('committed')
 }
 try{
  save(limit,'exact','2026-01-01');save(limit,'exact2','2026-01-02');save(1,'one','2026-01-03');save(limit+1,'over','2026-01-04','business_list')
  for(const queryId of [8001,8002]){
   expect(listPlatformQueries(db,{queryId,includeRawResponse:true})).toEqual(listPlatformQueries(oracle.db,{queryId,includeRawResponse:true}))
   expect(listPlatformQueries(db,{queryId,includeRawResponse:true}).rows[0]!.query.rawResponse?.length).toBe(limit)
  }
  trace.length=0
  expect(()=>listPlatformQueries(db,{queryId:8004,includeRawResponse:true})).toThrowError(expect.objectContaining({statusCode:413}))
  expect(trace.filter(q=>/select[^;]*(?:v\."bytes"|"platform_archive_value"\."bytes")/i.test(q))).toEqual([])
  expect(()=>listPlatformQueries(oracle.db,{queryId:8004,includeRawResponse:true})).toThrowError(expect.objectContaining({statusCode:413}))
  expect(listPlatformQueries(db,{includeRawResponse:true,page:2,pageSize:2})).toEqual(listPlatformQueries(oracle.db,{includeRawResponse:true,page:2,pageSize:2}))
  expect(()=>listPlatformQueries(db,{includeRawResponse:true,pageSize:4})).toThrowError(expect.objectContaining({statusCode:413}))
  expect(listPlatformQueries(db,{view:'summary'})).toEqual(listPlatformQueries(oracle.db,{view:'summary'}))
  expect(listPlatformQueries(db,{queryId:8003,includeRawResponse:true}).rows[0]!.query.rawResponse).toBe('x')
  // Three legal sub-query budgets exceed only the aggregate page budget by one byte.
  expect(()=>listPlatformQueries(db,{interface:'apply_list',includeRawResponse:true,pageSize:3})).toThrowError(expect.objectContaining({statusCode:413}))
  expect(()=>listPlatformQueries(oracle.db,{interface:'apply_list',includeRawResponse:true,pageSize:3})).toThrowError(expect.objectContaining({statusCode:413}))
  noLegacy()
 }finally{oracle.close()}
}, 30_000)

it('keeps one SQL request snapshot across an external commit and exposes it on the next request',()=>{
 t.pragma('journal_mode=WAL');expect(commit(request()).status).toBe('committed')
 const external=new Database(t.name),externalDb=drizzle(external,{schema});let injected=false
 const snapshotDb=drizzle(t,{schema,logger:{logQuery(query){
  if(!injected&&query.includes('order by')&&query.includes('platform_collection')){
   injected=true
   expect(commitRosterImport(externalDb,request([collection('businessList','2026-11-17T00:00:00Z')],'during-read'),[],{deferCandidateTasks:true}).status).toBe('committed')
  }
 }}})
 try{
  expect(listPlatformQueries(snapshotDb,{view:'summary'})).toMatchObject({total:1,rows:[{query:{id:8001}}]})
  expect(injected).toBe(true)
  expect(listPlatformQueries(db,{view:'summary'})).toMatchObject({total:2,rows:[{query:{id:8002}},{query:{id:8001}}]})
 }finally{external.close()}
})

it('selects a small page before a giant source and batches many observations without archive SQL business selection',()=>{
 const huge=collection('businessList','2026-01-01T00:00:00Z',[{id:'giant',rdjb:'2',qymc:'Alpha',tyshxydm:'91330200712345678A',note:'x'.repeat(1536*1024)}])
 expect(commit(request([huge],'giant')).status).toBe('committed')
 const rows=Array.from({length:30},(_,i)=>({id:`row-${i}`,rdjb:'2',qymc:'Alpha',tyshxydm:'91330200712345678A',cszt:'终审通过'}))
 expect(commit(request([collection('businessList','2026-02-01T00:00:00Z',rows)],'many')).status).toBe('committed')
 trace.length=0
 const page=listPlatformQueries(db,{pageSize:1})
 expect(page.total).toBe(2)
 expect(page.rows[0]!.query).toMatchObject({id:8002,relationCount:30})
 expect(page.rows[0]!.relations.map(r=>r.id)).toEqual(Array.from({length:30},(_,i)=>9002+i))
 const archiveReads=trace.filter(q=>/\b(?:from|join)\s+["`]?platform_(?:collection_archive_ref|observation_archive_ref)\b/i.test(q))
 expect(archiveReads.length).toBeLessThanOrEqual(9)
 if(process.env.CANDIDATE_SCOPE_EVIDENCE_DIR)writeFileSync(join(process.env.CANDIDATE_SCOPE_EVIDENCE_DIR,'history752-batch-trace.json'),JSON.stringify({archiveReadCount:archiveReads.length,queries:trace},null,2))
 const business=trace.filter(q=>/\b(?:group by|order by)\b/i.test(q)&&/platform_collection/.test(q)&&!q.includes('UNION ALL'))
 expect(business.length).toBeGreaterThanOrEqual(2)
 expect(business.every(q=>!/(?:json_|archive_value|\."bytes")/i.test(q))).toBe(true)
 trace.length=0
 expect(()=>listPlatformQueries(db,{queryId:8001})).toThrowError(expect.objectContaining({statusCode:413}))
 expect(trace.filter(q=>/select[^;]*(?:"platform_archive_value"\."bytes")/i.test(q))).toEqual([])
 trace.length=0
 expect(listPlatformQueries(db,{view:'summary'})).toMatchObject({total:2,rows:[{query:{id:8002,relationCount:30}},{query:{id:8001,relationCount:1}}]})
 expect(trace.filter(q=>/\b(?:from|join)\s+["`]?platform_archive_value\b/i.test(q))).toEqual([])
 noLegacy()
}, 30_000)

it.each([
 ...(['queryList','businessList','queryBusList'] as const).flatMap(source=>(['complete','partial','failed'] as const).map(state=>[source,state] as const)),
 ['businessList','unknown'] as const,
])('retains ordinary %s %s empty import status scope and zero relation count in the public history', (source,state)=>{
 frozen();const oracle=oldOracle()
 try{
  const evidence=collection(source,undefined,[]),unfinished={source,rdjb:source==='queryList'?null:'2',page:1}
  if(state==='partial'){evidence.status='partial';evidence.completeness='partial';evidence.fullRange=false;evidence.pages=[];evidence.declaredTotal=null;evidence.unfinished=[unfinished]}
  if(state==='failed'){evidence.status='failed';evidence.completeness='partial';evidence.fullRange=false;evidence.pages[0]!.status='failed';evidence.pages[0]!.error={code:'upstream_failed',message:'ordinary failure'};evidence.unfinished=[unfinished]}
  const input=request([evidence])
  if(state==='unknown')input.payload.platformQueries=[{interface:'business_list',queryKey:'91330200712345678A',rdjb:'2',queriedAt:evidence.queriedAt,status:'no_record',rawResponse:'original unknown response',relations:[]}]
  expect(preflightRosterImport(db,input).preflight.conflicts).toEqual([])
  expect(commit(input).status).toBe('committed');expect(commitRosterImport(oracle.db,input,[],{deferCandidateTasks:true}).status).toBe('committed')
  for(const view of ['full','summary'] as const)expect(listPlatformQueries(db,{view,includeRawResponse:view==='full'})).toEqual(listPlatformQueries(oracle.db,{view,includeRawResponse:view==='full'}))
  const status=state==='complete'||state==='unknown'?'no_record':state
  expect(listPlatformQueries(db,{view:'summary'})).toMatchObject({total:1,counts:{[status]:1},rows:[{relationsIncluded:false,query:{id:8001,status,relationCount:0},relations:[]}]})
  expect(listPlatformQueries(db,{titleCode:'specialized_sme',view:'summary'}).total).toBe(source==='queryList'||state==='unknown'?0:1)
  expect(readPlatformQueryEvidence(db,{queryId:8001,field:'relations',page:2,pageSize:1})).toEqual({queryId:8001,field:'relations',total:0,page:2,pageSize:1,rows:[]})
  noLegacy()
 }finally{oracle.close()}
})
