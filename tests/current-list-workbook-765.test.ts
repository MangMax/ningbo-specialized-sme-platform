import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import { chmodSync, copyFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as schema from '../db/schema'
import { targetSchema } from '../lib/platform/target-schema'
import { createTargetCurrentCandidateReader } from '../lib/roster/current-candidates-target'
import { createTargetRecognizedWitnessReader } from '../lib/roster/recognized-witness-target'
import { createCurrentQualificationAssessmentReader, createCurrentQualificationAssessmentReaderWithWitnesses } from '../lib/roster/current-qualification'
import { CURRENT_TITLES } from '../lib/roster/current-titles'
import { normalizeUscc } from '../lib/domain'
import { matrix408 } from './helpers/current-qualified-408'
import { commitRosterImport } from '../server/utils/roster-import'
import { platformResultToImport } from '../lib/platform/recognized-evidence'
import type { PlatformLiveQueryResult } from '../lib/platform/live-query'
import { preflightRecordCorrespondences, commitRecordCorrespondences } from '../server/utils/record-correspondence'
import { reserveLegacyIds } from '../lib/platform/target-archive'
import { createHash } from 'node:crypto'
import ExcelJS from 'exceljs'
import { readdirSync, createWriteStream } from 'node:fs'
import { tmpdir } from 'node:os'
import { Writable } from 'node:stream'
import { listCurrentQualified, type CurrentQualifiedFilter } from '../lib/roster/current-qualified-query'
import { writeCurrentWorkbook, CURRENT_HEADERS } from '../lib/roster/current-workbook'
import { currentWorkbookValues } from '../lib/roster/current-workbook-presentation'
import { CURRENT_STATUS_LABELS, type CurrentStatus } from '../lib/roster/current-status'
import { readIdentityKeyVariants, readTargetIdentityKeyVariants } from '../lib/roster/current-identity-keys'
import { getEnterpriseFacts, preflightEnterpriseFact, commitEnterpriseFact } from '../server/utils/enterprise-facts'
import { assertExpandRuntime } from '../db/schema-phase'

vi.mock('node:fs', async original => {
 const fs = await original<typeof import('node:fs')>()
 return { ...fs, createWriteStream: vi.fn(fs.createWriteStream) }
})

const fixtures=process.env.CURRENT_LIST_765_FIXTURES, evidence=process.env.CURRENT_LIST_765_EVIDENCE
if(!fixtures||!evidence)throw new Error('Set private CURRENT_LIST_765_FIXTURES and CURRENT_LIST_765_EVIDENCE')
const root=mkdtempSync(join(evidence,'consumers765-')), at=Date.parse('2026-12-01T00:00:00Z')
const targetBase=join(root,'target-base.sqlite'), oldBase=join(root,'old-base.sqlite')
function copy(from:string,to:string){copyFileSync(from,to);chmodSync(to,0o600)}
beforeAll(()=>{
 copy(join(fixtures,'baseline71613.sqlite'),targetBase);copy(join(fixtures,'baseline0.sqlite'),oldBase)
 const t=new Database(targetBase),old=new Database(oldBase)
 // Physical retirement is a test condition on this owned copy only. Runtime
 // readers have no DROP, migration, repair or schema-change responsibility.
 t.pragma('foreign_keys=OFF');t.exec('DROP TABLE platform_relation; DROP TABLE platform_query');t.pragma('foreign_keys=ON')
 // Enrich once through the real import/source writers on the completed chain,
 // then COPY this one baseline per case. No per-case migration or fake reader.
 reserveLegacyIds(drizzle(t,{schema:targetSchema}),{query:9000,relation:10000})
 old.prepare("update sqlite_sequence set seq=9000 where name='platform_query'").run()
 old.prepare("update sqlite_sequence set seq=10000 where name='platform_relation'").run()
 for(const connection of [t,old]){
  const m=matrix408(connection)
  m.formal('Alpha',[{eventType:'award',year:2025,decidedYear:2025,batchSeq:1}],{enterpriseId:760,title:'little_giant'})
  m.formal('Alpha',[{eventType:'award',year:2025,decidedYear:2025,batchSeq:1}],{enterpriseId:760,title:'innovative_sme'})
  connection.exec("insert into enterprise(id,name,name_norm,uscc_norm) values(761,'Other','Other','U761'),(762,'Duplicate','Duplicate',' u761 ')")
 }
 for(const [index,title] of CURRENT_TITLES.entries()){
  const rdjb=({little_giant:'3',specialized_sme:'2',innovative_sme:'1'} as const)[title]
  const raw={id:`recognized762-${title}`,rdjb,qymc:'Alpha',tyshxydm:'9133020078041158X6',rddqrq:'2028-12-31',whpcyear:'2026',whpc:'2026-2'}
  const result:PlatformLiveQueryResult={source:'queryBusList',status:'success',queriedAt:`2026-11-13T00:00:0${index}Z`,completedAt:'2026-11-13T00:01:00Z',effectiveConditions:{uscc:'9133020078041158X6',combination:'and'},titleScope:{mode:'selected',rdjb:[rdjb]},rows:[raw,raw],dataRows:[raw,raw],
   pages:[{source:'queryBusList',rdjb,page:1,maxPage:1,fetchedCount:2,declaredTotal:2,status:'success',error:null}],fetchedCount:2,declaredTotal:2,completeness:'complete',fullRange:true,unfinished:[],error:null,limits:{maxRequests:10,maxRows:100,maxDurationMs:1000,pageSize:50}}
  for(const connection of [t,old]){
   const db=drizzle(connection,{schema})
   const request={idempotencyKey:`762-${title}`,sourceKind:'platform_archive' as const,sourceIdentity:'synthetic762',payload:{platformQueries:[platformResultToImport(result)]}}
   expect(commitRosterImport(db,request,[],{deferCandidateTasks:true}).status).toBe('committed')
   const event=connection.prepare('select e.id from record_event e join record r on r.id=e.record_id where r.enterprise_id=760 and r.title_code=? and e.event_type=? order by e.id limit 1').get(title,'award') as {id:number}
   const relationId=10001+index*2
   const link={idempotencyKey:`762-link-${title}`,sourceIdentity:'synthetic762',actor:{type:'agent' as const,id:'762'},basis:'synthetic link',ruleId:'manual',ruleVersion:'1',operations:[{action:'create' as const,status:'confirmed' as const,edge:{type:'event_recognized' as const,eventId:event.id,relationId,role:'recognized_corrob' as const}}]}
   const plan=preflightRecordCorrespondences(db,link);commitRecordCorrespondences(db,link,plan.planHash)
  }
 }
 const mixedRows=[1,2].map(id=>({id:`mixed762-${id}`,rdjb:'1',qymc:'Alpha',tyshxydm:'9133020078041158X6',cszt:'终审通过',year:'2024'}))
 const mixed:PlatformLiveQueryResult={source:'businessList',status:'success',queriedAt:'2026-11-13T01:00:00Z',completedAt:'2026-11-13T01:01:00Z',effectiveConditions:{uscc:'9133020078041158X6',combination:'and'},titleScope:{mode:'selected',rdjb:['1','2','3']},rows:mixedRows,dataRows:mixedRows,
  pages:['1','2','3'].map(rdjb=>({source:'businessList',rdjb,page:1,maxPage:1,fetchedCount:rdjb==='1'?0:1,declaredTotal:rdjb==='1'?0:1,status:'success' as const,error:null})),fetchedCount:2,declaredTotal:2,completeness:'complete',fullRange:true,unfinished:[],error:null,limits:{maxRequests:10,maxRows:100,maxDurationMs:1000,pageSize:50}}
 for(const connection of [t,old])expect(commitRosterImport(drizzle(connection,{schema}),{idempotencyKey:'762-mixed',sourceKind:'platform_archive',sourceIdentity:'synthetic762',payload:{platformQueries:[platformResultToImport(mixed)]}},[],{deferCandidateTasks:true}).status).toBe('committed')
 enrich(t);enrich(old)
 t.close();old.close()
})
function fixture(onTrace?: (query: string) => void){
 const dir=mkdtempSync(join(root,'case-')),path=join(dir,'target.sqlite');copy(targetBase,path)
 const trace:string[]=[],t=new Database(path,{verbose:q=>{trace.push(String(q));onTrace?.(String(q))}}),oldPath=join(dir,'old.sqlite');copy(oldBase,oldPath);const old=new Database(oldPath)
 t.pragma('foreign_keys=ON');t.function('roster84_uscc',{deterministic:true},normalizeUscc);old.function('roster84_uscc',{deterministic:true},normalizeUscc)
 const db=drizzle(t,{schema:targetSchema})
 return {t,old,db,path,dir,trace,close(){old.close();t.close()}}
}

// Frozen exact-base consumer source, supplied by the owned runner. Its relative
// imports are rebound to this checkout; qualification/source owners are unchanged.
const legacyList: typeof import('../lib/roster/current-qualified-query') = await import(join(evidence!, 'legacy-list.ts'))
const legacyWorkbook: typeof import('../lib/roster/current-workbook') = await import(join(evidence!, 'legacy-workbook.ts'))
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllEnvs() })
function clock() { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(at) }
function enrich(connection: Database.Database) {
 const m=matrix408(connection)
 connection.exec("insert into enterprise(id,name,name_norm,uscc_norm,district,city) values(770,'Zulu','Zulu',NULL,'海曙区','宁波市'),(771,'same','same','','鄞州区','宁波市'),(772,'Same','Same','U772','鄞州区','宁波市'),(773,'Moved','Moved','U773','鄞州区','宁波市'),(774,'Nurture','Nurture',NULL,'鄞州区','宁波市')")
 for(const title of CURRENT_TITLES) {
  m.formal('unused',undefined,{enterpriseId:770,title})
  m.formal('unused',[{eventType:'award',year:2020,decidedYear:2020,batchSeq:1}],{enterpriseId:771,title})
  m.formal('unused',undefined,{enterpriseId:772,title})
  m.formal('unused',undefined,{enterpriseId:773,title})
  const db=drizzle(connection,{schema})
  const record=db.insert(schema.record).values({enterpriseId:774,titleCode:title,source:'jxj',nameRaw:'Nurture'}).returning().get()
  db.insert(schema.recordEvent).values({recordId:record.id,eventType:'nurture',year:2025,batchSeq:1}).run()
 }
 m.alias(770,'旧名检索','confirmed')
 const db=drizzle(connection,{schema})
 for(const [id,kind] of [[772,'cancelled'],[773,'moved_out']] as const) {
  const command=(change: object,suffix:string)=>{
   const request={expectedVersion:getEnterpriseFacts(db,id).version,idempotencyKey:`765-${id}-${suffix}`,actor:{type:'agent',id:'765'},basis:'合成正式来源逐项核实',...change}
   const plan=preflightEnterpriseFact(db,id,request)
   return commitEnterpriseFact(db,id,{request,planHash:plan.planHash})
  }
  const result=command({action:'assert',fact:{kind,source:{reference:`synthetic:765:${id}`,statement:'合成明确主体状态'},observed:{precision:'day',value:'2026-01-01'},effective:{precision:'day',value:'2026-01-01'},city:null}},'assert')
  command({action:'confirm',factId:result.factId},'confirm')
 }
 // Exercise the existing full-text appendix using actual source text.
 connection.prepare("update record_evidence set attachment=? where record_event_id in (select e.id from record_event e join record r on r.id=e.record_id where r.enterprise_id=770)").run('完整附件段落\n'.repeat(80))
}
const literalMembers: Record<CurrentStatus,number[]> = {effective:[760,770],expired:[771],terminated:[772],moved_out:[773],unrecognized:[774]}
function assertNoOld(trace:string[]) {
 expect(trace.join('\n')).not.toMatch(/\b(?:from|join)\s+["`]?platform_(?:query|relation)["`]?(?=\s|$)/i)
}
function enumeration(trace:string[]) {return trace.filter(q=>/\bunion\b/i.test(q)&&/current_candidates/.test(q))}

it.each(CURRENT_TITLES)('765 default list matches frozen schema0 and literal five states filters pages and full digests for %s',title=>{
 clock();const f=fixture()
 try {
  const changes=f.t.prepare('select total_changes() n').get()
  expect(f.t.prepare("select name from sqlite_schema where name in ('platform_query','platform_relation')").all()).toEqual([])
  for(const status of Object.keys(literalMembers) as CurrentStatus[]) {
   const filter={titleCode:title,status,pageSize:100}
   const actual=listCurrentQualified(f.t,filter),expected=legacyList.listCurrentQualified(f.old,filter)
   expect(actual).toEqual(expected)
   expect(actual.rows.map(r=>r.enterpriseId)).toEqual(literalMembers[status])
   expect(actual.total).toBe(literalMembers[status].length)
   for(const row of actual.rows)expect(row.qualificationAssessment.snapshotId).toMatch(/^[a-f0-9]{64}$/)
  }
  const filters: Omit<CurrentQualifiedFilter,'titleCode'>[]=[
   {district:'海曙区'},{q:'旧名检索'},{q:'9133020078041158x6'},{q:'missing'},
   {recognitionFrom:'2025-01-01',recognitionTo:'2025-12-31'},
   {recognitionFrom:'2025-02-01',recognitionTo:'2025-12-31'},
   {validYear:2028},{maintenanceYear:2026},{maintenanceBatch:2},
   {validYear:2028,maintenanceYear:2026,maintenanceBatch:2},
   {validYear:2029},{recognitionFrom:'2025-02-01',recognitionTo:'2025-12-31',maintenanceYear:2026},
   ...(['id_asc','name_asc','name_desc'] as const).flatMap(sort=>[1,2,3].map(page=>({sort,page,pageSize:1}))),
   {status:'expired',sort:'name_desc'},
  ]
  for(const filter of filters)expect(listCurrentQualified(f.t,{titleCode:title,...filter})).toEqual(legacyList.listCurrentQualified(f.old,{titleCode:title,...filter}))
  expect(listCurrentQualified(f.t,{titleCode:title,district:'海曙区'}).rows.map(r=>r.enterpriseId)).toEqual([770])
  expect(listCurrentQualified(f.t,{titleCode:title,q:'旧名检索'}).rows.map(r=>r.enterpriseId)).toEqual([770])
  expect(listCurrentQualified(f.t,{titleCode:title,recognitionFrom:'2025-02-01',recognitionTo:'2025-12-31'}).uncertainTotal).toBe(title==='specialized_sme'?1:2)
  f.trace.length=0
  const selected=listCurrentQualified(f.t,{titleCode:title,pageSize:1})
  expect(selected.rows).toHaveLength(1)
  assertNoOld(f.trace);expect(enumeration(f.trace)).toHaveLength(1)
  expect(f.trace.filter(q=>/^select distinct "query_key" as "key" from "platform_collection"/i.test(q))).toHaveLength(1)
  expect(f.trace.filter(q=>/^select distinct "uscc_raw" as "key" from "platform_observation_assignment"/i.test(q))).toHaveLength(1)
  expect(f.trace.filter(q=>/^SAVEPOINT /i.test(q))).toHaveLength(1)
  writeFileSync(join(f.dir,`${title}-list-trace.json`),JSON.stringify(f.trace,null,2))
  expect(f.t.inTransaction).toBe(false)
  expect(f.t.prepare('select total_changes() n').get()).toEqual(changes)
 }finally{f.close()}
})

function workbookShape(book:ExcelJS.Workbook) {
 return book.worksheets.map(sheet=>({
  name:sheet.name,views:sheet.views,autoFilter:sheet.autoFilter,columns:sheet.columns.map(c=>c.width),
  rows:Array.from({length:sheet.rowCount},(_,index)=>{
   const row=sheet.getRow(index+1)
   return {height:row.height,cells:Array.from({length:sheet.columnCount},(_,i)=>{
    const cell=row.getCell(i+1);return {value:cell.value,style:cell.style}
   })}
  }),
 }))
}
it.each(CURRENT_TITLES)('765 actual documonster workbook matches all schema0 cells styles appendix and independent serializer for %s',async title=>{
 clock();const f=fixture()
 try {
  const changes=f.t.prepare('select total_changes() n').get()
  const targetFile=join(f.dir,'target.xlsx'),oldFile=join(f.dir,'old.xlsx')
  const target=await writeCurrentWorkbook(f.t,title,targetFile,()=>{})
  const old=await legacyWorkbook.writeCurrentWorkbook(f.old,title,oldFile,()=>{})
  expect(target).toEqual(old)
  expect(target.statusCounts).toEqual({effective:2,expired:1,terminated:1,moved_out:1,unrecognized:1})
  const book=new ExcelJS.Workbook(),oldBook=new ExcelJS.Workbook()
  await book.xlsx.readFile(targetFile);await oldBook.xlsx.readFile(oldFile)
  expect(workbookShape(book)).toEqual(workbookShape(oldBook))
  expect(book.worksheets.map(s=>s.name)).toEqual([...Object.values(CURRENT_STATUS_LABELS),'长文本全文','口径说明'])
  const hash=createHash('sha256').update(JSON.stringify(['current-export-assessment-409-v2','enterprise-qualification-687-v4','current-roster-116-v11',2026,title])+'\n')
  const assessment=createCurrentQualificationAssessmentReader(f.old)
  for(const [status,name] of Object.entries(CURRENT_STATUS_LABELS) as [CurrentStatus,string][]) {
   const sheet=book.getWorksheet(name)!
   expect(sheet.getRow(1).values).toEqual([undefined,...CURRENT_HEADERS])
   expect(sheet.getRow(1).height).toBe(34)
   expect(sheet.getCell('A1').font).toMatchObject({name:'Arial Unicode MS',bold:true,color:{argb:'FFFFFFFF'}})
   expect(sheet.rowCount).toBe(literalMembers[status].length+1)
   for(const [i,id] of literalMembers[status].entries()) {
    const {rows,snapshot,workbookPublished}=assessment.readWorkbook(id,at,title)
    const row=rows.find(r=>r.assessment!.titleCode===title)!
    const effective=row.assessment!.effectiveQualification!
    const values=[...currentWorkbookValues(title,row,i+1,workbookPublished),name,(effective.presentationBasis??[]).join('；'),effective.notes.join('；')]
    const {titles:_titles,snapshotId,...scope}=snapshot
    hash.update(JSON.stringify([status,id,scope,snapshotId,values])+'\n')
    expect(sheet.getCell(i+2,1).value).toBe(String(i+1))
    expect(sheet.getCell(i+2,2).value).toBe(row.name)
    for(const [column,value] of values.entries()) {
     const cell=sheet.getCell(i+2,column+1)
     const appendix=book.getWorksheet('长文本全文')!
     const parts:string[]=[]
     appendix.eachRow((appendixRow,n)=>{
      if(n>1&&appendixRow.getCell(1).value===name&&appendixRow.getCell(2).value===cell.address)parts.push(String(appendixRow.getCell(12).value))
     })
     if(parts.length)expect(parts.join('')).toBe(value)
     else expect(cell.value).toBe(value===''?null:value)
    }
    expect(sheet.getRow(i+2).height).toBeLessThanOrEqual(409)
   }
  }
  expect(target.dataVersion).toBe('sha256:'+hash.digest('hex'))
  expect(f.trace.filter(q=>/^SAVEPOINT /i.test(q))).toHaveLength(6)
  const typed=createCurrentQualificationAssessmentReaderWithWitnesses(f.t,createTargetRecognizedWitnessReader(f.db)).readCurrent(760,at,title)
  expect(typed.snapshot.titles[1]!.platform.observations.flatMap(o=>o.rows).find(r=>r.relationId===2004)?.status).toEqual(Buffer.from([0,255]))
  assertNoOld(f.trace);expect(enumeration(f.trace)).toHaveLength(1)
  expect(f.trace.filter(q=>/^select distinct "query_key" as "key" from "platform_collection"/i.test(q))).toHaveLength(1)
  expect(f.t.inTransaction).toBe(false)
  expect(f.t.prepare('select total_changes() n').get()).toEqual(changes)
  writeFileSync(join(f.dir,`${title}-workbook-trace.json`),JSON.stringify(f.trace,null,2))
 }finally{f.close()}
})

function appendAssignment(db:Database.Database,observationId:number,revision:number,enterpriseId:number|null,uscc:string|null=null) {
 db.prepare("insert into platform_observation_assignment(observation_id,revision,enterprise_id,uscc_raw,match_basis,verification_status,origin,basis) values(?,?,?,?,'manual','pending','command','765 owned control')").run(observationId,revision,enterpriseId,uscc)
}
function observationIds(result:ReturnType<typeof listCurrentQualified>,id=760) {
 return result.rows.find(r=>r.enterpriseId===id)!.qualificationAssessment.titles[1]!.platform.observations.flatMap(o=>o.rows).map(r=>r.relationId)
}
function spools(){return readdirSync(tmpdir()).filter(n=>n.startsWith('current-export-full-text-')).sort()}

it('765 default list pins enumeration filters and selected full hydration across a real concurrent assignment then refreshes',()=>{
 clock()
 let writer:Database.Database|undefined,injected=false
 const f=fixture(query=>{
  if(!injected&&writer&&/^select id,name,name_norm,uscc_norm,district,city from enterprise where id=760(?:\.0)?$/i.test(query)) {
   injected=true;appendAssignment(writer,2004,2,761)
  }
 })
 f.t.pragma('journal_mode=WAL');writer=new Database(f.path)
 try {
  const first=listCurrentQualified(f.t,{titleCode:'specialized_sme',pageSize:100})
  expect(injected).toBe(true)
  expect(first).toEqual(legacyList.listCurrentQualified(f.old,{titleCode:'specialized_sme',pageSize:100}))
  expect(observationIds(first)).toContain(2004)
  const next=listCurrentQualified(f.t,{titleCode:'specialized_sme',pageSize:100})
  expect(observationIds(next)).not.toContain(2004)
  expect(next.rows[0]!.qualificationAssessment.snapshotId).not.toBe(first.rows[0]!.qualificationAssessment.snapshotId)
  expect(listCurrentQualified(f.t,{titleCode:'specialized_sme',status:'unrecognized',pageSize:100}).rows.map(r=>r.enterpriseId)).toEqual([761,774])
  assertNoOld(f.trace);expect(f.t.inTransaction).toBe(false)
 }finally{writer.close();f.close()}
})

it('765 actual asynchronous drain keeps one snapshot through documonster commit and next workbook sees assignment',async()=>{
 clock();const f=fixture();f.t.pragma('journal_mode=WAL');const writer=new Database(f.path)
 const file=join(f.dir,'concurrent.xlsx'),sink=createWriteStream(file,{highWaterMark:1})
 let injected=false
 sink.on('drain',()=>{
  if(!injected) {
   expect(f.t.inTransaction).toBe(true);injected=true
   appendAssignment(writer,2004,2,761)
  }
 })
 vi.mocked(createWriteStream).mockReturnValueOnce(sink)
 try {
  const first=await writeCurrentWorkbook(f.t,'specialized_sme',file,()=>{})
  expect(injected).toBe(true);expect(sink.closed).toBe(true);expect(f.t.inTransaction).toBe(false)
  const reference=await legacyWorkbook.writeCurrentWorkbook(f.old,'specialized_sme',join(f.dir,'reference.xlsx'),()=>{})
  expect(first).toEqual(reference)
  const next=await writeCurrentWorkbook(f.t,'specialized_sme',join(f.dir,'next.xlsx'),()=>{})
  expect(next.total).toBe(first.total+1)
  expect(next.dataVersion).not.toBe(first.dataVersion)
  expect(next.statusCounts.unrecognized).toBe(2)
  assertNoOld(f.trace)
 }finally{sink.destroy();writer.close();f.close()}
})

it('765 structured request keys preserve raw normalization name NULL blank and maximum current revision',async()=>{
 clock();const f=fixture()
 try {
  // These are controlled identity-only changes on synthetic copies. No source
  // business fields, capture columns or original-cell archives are rewritten.
  for(const connection of [f.t,f.old])connection.exec("update enterprise set uscc_norm='U761' where id=761;update enterprise set uscc_norm=' u761 ' where id=762")
  f.t.prepare("update platform_collection set query_key=' u761 ' where id=(select collection_id from platform_legacy_query_alias where old_id=100)").run()
  f.old.prepare("update platform_query set query_key=' u761 ' where id=100").run()
  appendAssignment(f.t,1100,2,760);appendAssignment(f.t,1100,3,761);appendAssignment(f.t,1100,4,null,' U761 ')
  f.old.prepare("update platform_relation set enterprise_id=null,uscc_raw=' U761 ',verification_status='pending',match_basis='manual' where id=1100").run()
  f.t.exec('BEGIN')
  const queryKeys=readTargetIdentityKeyVariants(f.t,'queries'),relationKeys=readTargetIdentityKeyVariants(f.t,'unassignedRelations')
  expect(queryKeys).toEqual(readIdentityKeyVariants(f.old,'queries'))
  expect(relationKeys).toEqual(readIdentityKeyVariants(f.old,'unassignedRelations'))
  expect(queryKeys.get('U761')).toContain(' u761 ')
  expect(relationKeys.get('U761')).toContain(' U761 ')
  f.t.exec('ROLLBACK')
  for(const status of Object.keys(literalMembers) as CurrentStatus[])expect(listCurrentQualified(f.t,{titleCode:'specialized_sme',status,pageSize:100})).toEqual(legacyList.listCurrentQualified(f.old,{titleCode:'specialized_sme',status,pageSize:100}))
  expect(listCurrentQualified(f.t,{titleCode:'specialized_sme',status:'unrecognized',pageSize:100}).rows.map(r=>r.enterpriseId)).toEqual([761,762,774])
  expect(await writeCurrentWorkbook(f.t,'specialized_sme',join(f.dir,'keys.xlsx'),()=>{})).toEqual(await legacyWorkbook.writeCurrentWorkbook(f.old,'specialized_sme',join(f.dir,'old-keys.xlsx'),()=>{}))
  appendAssignment(f.t,1100,5,760)
  expect(listCurrentQualified(f.t,{titleCode:'specialized_sme',status:'unrecognized',pageSize:100}).rows.map(r=>r.enterpriseId)).toEqual([774])
 }finally{if(f.t.inTransaction)f.t.exec('ROLLBACK');f.close()}
})

it('765 source selectors retain schema0 legacy and typed semantics and do not silently fallback on retired target',async()=>{
 clock();const f=fixture()
 try {
  for(const recognizedFactSource of ['typed','legacy'] as const) {
   const options={recognizedFactSource}
   expect(listCurrentQualified(f.old,{titleCode:'innovative_sme'},options)).toEqual(legacyList.listCurrentQualified(f.old,{titleCode:'innovative_sme'},options))
   expect(await writeCurrentWorkbook(f.old,'innovative_sme',join(f.dir,recognizedFactSource+'.xlsx'),()=>{},undefined,undefined,options)).toEqual(await legacyWorkbook.writeCurrentWorkbook(f.old,'innovative_sme',join(f.dir,'old-'+recognizedFactSource+'.xlsx'),()=>{},undefined,undefined,options))
  }
  expect(()=>listCurrentQualified(f.t,{titleCode:'innovative_sme'},{recognizedFactSource:'legacy'})).toThrow(/no such table/)
  await expect(writeCurrentWorkbook(f.t,'innovative_sme',join(f.dir,'legacy-target.xlsx'),()=>{},undefined,undefined,{recognizedFactSource:'legacy'})).rejects.toThrow(/no such table/)
  vi.stubEnv('ROSTER_RECOGNIZED_FILTER_SOURCE','legacy')
  expect(()=>listCurrentQualified(f.t,{titleCode:'innovative_sme'})).toThrow(/no such table/)
  expect(listCurrentQualified(f.t,{titleCode:'innovative_sme'},{recognizedFactSource:'typed'}).total).toBe(2)
  expect(f.t.inTransaction).toBe(false)
 }finally{f.close()}
})

it('765 preserves687 expired lower-title inheritance and exact full snapshot versions',()=>{
 clock();const f=fixture()
 try {
  for(const connection of [f.t,f.old])connection.exec("update record_event set year=2020,decided_year=2020 where record_id in(select id from record where enterprise_id=760 and title_code='innovative_sme')")
  const actual=listCurrentQualified(f.t,{titleCode:'innovative_sme'})
  expect(actual).toEqual(legacyList.listCurrentQualified(f.old,{titleCode:'innovative_sme'}))
  const assessed=actual.rows[0]!.qualificationAssessment
  expect(assessed.assessmentVersion).toBe('enterprise-qualification-687-v4')
  expect(assessed.ruleVersion).toBe('current-roster-116-v11')
  expect(assessed.titles[2]!.effectiveQualification!.localRuleBasis!.join('\n')).toContain('按有效小巨人资格计入')
 }finally{f.close()}
})

it('765 rejects caller transactions without committing or rolling back caller writes in either consumer',async()=>{
 clock();const f=fixture();const before=spools()
 try {
  f.t.exec("BEGIN;update enterprise set name='caller-owned' where id=761")
  expect(()=>listCurrentQualified(f.t,{titleCode:'little_giant'})).toThrow(/within a transaction/)
  expect(f.t.inTransaction).toBe(true)
  await expect(writeCurrentWorkbook(f.t,'little_giant',join(f.dir,'caller.xlsx'),()=>{})).rejects.toThrow(/within a transaction/)
  expect(f.t.inTransaction).toBe(true)
  expect(f.t.prepare('select name from enterprise where id=761').pluck().get()).toBe('caller-owned')
  f.t.exec('ROLLBACK')
  expect(f.t.prepare('select name from enterprise where id=761').pluck().get()).toBe('Other')
  expect(spools()).toEqual(before)
 }finally{if(f.t.inTransaction)f.t.exec('ROLLBACK');f.close()}
})

it.each(['error','abort','progress','cell-limit'] as const)('765 actual writer releases owned transaction statements and overflow TMP after %s',async mode=>{
 clock();const f=fixture(),before=spools(),file=join(f.dir,mode+'.xlsx')
 let sink:Writable|undefined
 try {
  if(mode==='error'||mode==='abort') {
   const actual=createWriteStream(file,{highWaterMark:1})
   sink=actual
   if(mode==='error')actual.once('open',()=>actual.destroy(new Error('765 actual output failure')))
   else actual.once('drain',()=>actual.destroy(new Error('765 actual output abort')))
   vi.mocked(createWriteStream).mockReturnValueOnce(actual)
  }
  if(mode==='cell-limit')f.t.prepare("update enterprise set name=? where id=770").run('长'.repeat(32768))
  await expect(writeCurrentWorkbook(f.t,'little_giant',file,()=>{
   if(mode==='progress')throw new Error('765 cancellation')
  })).rejects.toThrow(mode==='cell-limit'?/32767/:mode==='progress'?/765 cancellation/:/765 actual output/)
  expect(f.t.inTransaction).toBe(false);expect(spools()).toEqual(before)
  expect(f.t.prepare('select 17 n').get()).toEqual({n:17})
  if(sink)expect(sink.destroyed).toBe(true)
  if(mode==='cell-limit')f.t.prepare("update enterprise set name='Zulu' where id=770").run()
  expect((await writeCurrentWorkbook(f.t,'little_giant',join(f.dir,'recovered.xlsx'),()=>{})).total).toBe(6)
 }finally{sink?.destroy();f.close()}
})

it('765 target iterator break throw and default list failure release statements and owned transaction',()=>{
 clock();const f=fixture()
 try {
  const candidate=createTargetCurrentCandidateReader(f.db)
  for(const row of candidate.iterate('little_giant')){expect(row.id).toBe(760);break}
  expect(f.t.inTransaction).toBe(false)
  expect(()=>{for(const _ of candidate.iterate('little_giant'))throw new Error('765 consumer throw')}).toThrow('765 consumer throw')
  expect(f.t.inTransaction).toBe(false)
  const prepare=f.t.prepare.bind(f.t)
  const spy=vi.spyOn(f.t,'prepare').mockImplementation(text=>{
   if(text.startsWith('select id,name,name_norm,uscc_norm,district,city from enterprise'))throw new Error('765 filter failure')
   return prepare(text)
  })
  expect(()=>listCurrentQualified(f.t,{titleCode:'little_giant'})).toThrow('765 filter failure')
  spy.mockRestore()
  expect(f.t.inTransaction).toBe(false)
  expect(listCurrentQualified(f.t,{titleCode:'little_giant'}).total).toBe(2)
 }finally{f.close()}
})

it('765 equal NOCASE names keep stable primary key order across pages in both directions',()=>{
 clock();const f=fixture()
 try {
  for(const connection of [f.t,f.old])connection.exec("update enterprise set name='alpha' where id=770")
  for(const sort of ['id_asc','name_asc','name_desc'] as const) {
   const ids:number[]=[]
   for(const page of [1,2,3]) {
    const filter={titleCode:'little_giant' as const,page,pageSize:1,sort}
    const actual=listCurrentQualified(f.t,filter)
    expect(actual).toEqual(legacyList.listCurrentQualified(f.old,filter))
    ids.push(...actual.rows.map(r=>r.enterpriseId))
   }
   expect(ids).toEqual([760,770])
  }
 }finally{f.close()}
})

it.each([
 ['candidate',"update platform_migration_run set state='running' where transform_version='candidate-scope-offline-v1'",/Candidate migration incomplete/],
 ['witness',"update platform_migration_run set state='running' where transform_version='recognized-witness-offline-v1'",/Witness migration incomplete/],
 ['successor',"update platform_migration_run set state='running' where transform_version='collection-legacy-provenance-v1'",/migration incomplete/],
] as const)('765 default consumers reject incomplete %s readiness and release their own scope',async(_label,mutation,error)=>{
 clock();const f=fixture(),before=spools()
 try {
  f.t.exec(mutation)
  expect(()=>listCurrentQualified(f.t,{titleCode:'little_giant'})).toThrow(error)
  expect(f.t.inTransaction).toBe(false)
  await expect(writeCurrentWorkbook(f.t,'little_giant',join(f.dir,'incomplete.xlsx'),()=>{})).rejects.toThrow(error)
  expect(f.t.inTransaction).toBe(false);expect(spools()).toEqual(before)
  expect(enumeration(f.trace)).toHaveLength(0)
  assertNoOld(f.trace)
 }finally{f.close()}
})

it.each([71610,71612])('765 retains preexisting consumer failures at intermediate phase %i and leaves the global runtime closed',async phase=>{
 clock();const f=fixture()
 function failure(action:()=>unknown) {
  try {action()} catch(error) {
   if (!(error instanceof Error)) throw error
   return error.message
  }
  throw new Error('expected rejection')
 }
 try {
  expect(()=>assertExpandRuntime(f.t)).toThrow('W/R cutover required')
  f.t.pragma(`user_version=${phase}`)
  const filter={titleCode:'little_giant' as const}
  expect(failure(()=>listCurrentQualified(f.t,filter))).toBe(failure(()=>legacyList.listCurrentQualified(f.t,filter)))
  const actual=await writeCurrentWorkbook(f.t,'little_giant',join(f.dir,'intermediate.xlsx'),()=>{}).catch((error:Error)=>error.message)
  const old=await legacyWorkbook.writeCurrentWorkbook(f.t,'little_giant',join(f.dir,'old-intermediate.xlsx'),()=>{}).catch((error:Error)=>error.message)
  expect(typeof actual).toBe('string');expect(actual).toBe(old)
  expect(f.t.inTransaction).toBe(false)
 }finally{f.close()}
})
