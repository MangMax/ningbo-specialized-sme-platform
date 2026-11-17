import { afterAll, expect, it, vi } from 'vitest'
import * as platformQualification from '../../../lib/roster/platform-qualification'
import { qualificationExportFixture } from '../current-export/fixtures/qualification-export'
import { createCurrentQualificationAssessmentReader, PREVIOUS_QUALIFICATION_ASSESSMENT_VERSION } from '../../../lib/roster/current-qualification'
import { schema } from '../../../db/client'
const f = qualificationExportFixture()
afterAll(() => f.close())
const asOf = Date.parse('2026-11-05T12:00:00Z')
function read(id: number) { return createCurrentQualificationAssessmentReader(f.db.$client).read(id, asOf).snapshot.titles.find(t => t.titleCode === 'specialized_sme')! }
function fact(id: number, kind: string, status = 'confirmed', reference = 'official reference', effective = '2026-01-01') {
  f.db.insert(schema.enterpriseFactRevision).values({ enterpriseId:id,factId:1,revision:1,status:status as 'confirmed',fact:{kind,source:{reference,statement:'official statement'},effective:{precision:'day',value:effective},observed:{precision:'day',value:'2026-01-01'},city:null},action:'assert',actor:{type:'agent',id:'test478'},basis:'verified basis',createdAt:'2026-01-01T00:00:00Z' }).run()
}
it.each(['cancelled','moved_out'])('excludes only a complete confirmed %s fact', kind => {
 const c = f.candidate('complete-'+kind,[{eventType:'award',year:2025,batchSeq:1}]); fact(c.enterprise.id,kind)
 expect(read(c.enterprise.id)).toMatchObject({group:'excluded',effectiveQualification:{status:kind === 'cancelled' ? 'terminated' : 'moved_out'}})
})
it.each(['cancelled','moved_out'])('retains eligibility for incomplete or unconfirmed %s', kind => {
 for (const [status,reference,date] of [['pending','ref','2026-01-01'],['confirmed','','2026-01-01'],['confirmed','ref','2027-01-01']]) {
  const c=f.candidate('incomplete-'+kind+status+reference+date,[{eventType:'award',year:2025,batchSeq:1}]); fact(c.enterprise.id,kind,status,reference,date)
  expect(read(c.enterprise.id)).toMatchObject({group:'eligible',effectiveQualification:{status:'effective'}})
 }
})
it.each(['moved_in','registration_status'])('does not let %s establish eligibility', kind => {
 const c=f.candidate('nonaward-'+kind,[{eventType:'nurture',year:2025}]); fact(c.enterprise.id,kind)
 expect(read(c.enterprise.id)).toMatchObject({group:'excluded',effectiveQualification:{status:'unrecognized'}})
})
it('retains previous assessment behavior explicitly while source and identity gaps become notes', () => {
 const c=f.candidate('source-gap',[{eventType:'award',year:2025,batchSeq:1}])
 f.db.$client.prepare('delete from record_evidence where record_event_id in (select id from record_event where record_id=?)').run(c.record.id)
 expect(read(c.enterprise.id)).toMatchObject({group:'eligible',effectiveQualification:{status:'effective'}})
 const old=createCurrentQualificationAssessmentReader(f.db.$client).read(c.enterprise.id,asOf,{assessmentVersion:PREVIOUS_QUALIFICATION_ASSESSMENT_VERSION}).snapshot
 expect(old.titles.find(t=>t.titleCode==='specialized_sme')!.group).toBe('pending')
 expect(old.assessmentVersion).toBe('enterprise-qualification-407-v2')
})
it.each(['passed','failed',null] as const)('formal review-only %s preserves missing origin coordinates', outcome=>{
 const c=f.candidate('review-only-'+outcome,[{eventType:'review',year:null,decidedYear:2026,batchSeq:null,reviewOutcome:outcome}])
 const result=read(c.enterprise.id)
 expect(result.group).toBe(outcome==='passed'?'eligible':'excluded')
 expect(result.evidence[0]).toMatchObject({year:null,batchSeq:null,decidedYear:2026,reviewOutcome:outcome})
})
it.each(['cancelled','moved_out'])('still excludes an old giant with a confirmed %s boundary',kind=>{
 const c=f.candidate('old giant boundary '+kind,[{eventType:'award',year:2018,batchSeq:1}],'little_giant')
 fact(c.enterprise.id,kind)
 const result=createCurrentQualificationAssessmentReader(f.db.$client).read(c.enterprise.id,asOf).snapshot
 expect(result.titles.map(t=>t.group)).toEqual(['excluded','excluded','excluded'])
 expect(result.titles[0]!.effectiveQualification!.status).toBe(kind==='cancelled'?'terminated':'moved_out')
})

import { eq } from 'drizzle-orm'
import { writeNewCollectionTarget, type NewCollectionTargetCommand } from '../../../lib/platform/collection-target-command'
import { platformResultToImport } from '../../../lib/platform/recognized-evidence'
import type { PlatformRawRow } from '../../../lib/platform/types'
import type { PlatformLiveQueryResult } from '../../../lib/platform/live-query'
import { processFactsFromRow } from '../../../lib/platform/identity'
function collectionCommand(row: PlatformRawRow, queriedAt: string, source: PlatformLiveQueryResult['source'] = 'queryBusList'): NewCollectionTargetCommand {
  const evidence: PlatformLiveQueryResult = {
    source, status: 'success', effectiveConditions: source === 'businessList' ? { uscc: String(row.tyshxydm), combination: 'and' } : { name: 'Example', combination: 'and' },
    titleScope: source === 'queryList' ? { mode: 'source_default', rdjb: [] } : { mode: 'selected', rdjb: [String(row.rdjb ?? '2')] }, queriedAt, completedAt: queriedAt,
    rows: [Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value)]))], dataRows: [row], pages: [{ source, rdjb: source === 'queryList' ? null : String(row.rdjb ?? '2'), page: 1, maxPage: 1, status: 'success', fetchedCount: 1, declaredTotal: 1, error: null }],
    fetchedCount: 1, declaredTotal: 1, completeness: 'complete', fullRange: true, unfinished: [], error: null,
    limits: { maxRequests: 100, maxRows: 5000, maxDurationMs: 60000, pageSize: 50 },
  }
  const query = platformResultToImport(evidence)
  if (source !== 'queryBusList') query.relations = query.relations?.map(r => ({ ...r, ...processFactsFromRow(evidence.rows[0]!) }))
  return { queryText: JSON.stringify(query), evidenceText: JSON.stringify(evidence), createdAt: queriedAt, assignments: (query.relations ?? []).map(r => ({ enterpriseId: null, matchBasis: 'none', verificationStatus: 'pending', nameRaw: r.nameRaw ?? null, usccRaw: r.usccRaw ?? null, origin: 'command', actor: { type: 'agent', id: 'fact-reader-test' }, basis: 'source capture', recordedAt: null })) }
}

it.each(['queryBusList','queryList'] as const)('presents the selected platform basis and its supported period for %s',async source=>{
 const local=qualificationExportFixture()
 try {
  const c=local.candidate('selected platform summary',[])
  local.db.update(schema.enterprise).set({usccNorm:'91310115MA1H7KUG93'}).where(eq(schema.enterprise.id,c.enterprise.id)).run()
  const fields: PlatformRawRow = source==='queryBusList'
   ? {rdtime:'2025-01-01',rddqrq:'2028-01-01',sfyx:'1'}
   : {sblx:'复核',cszt:'终审通过',year:'2024',sqsj:'2024-08-30 09:03:05'}
  writeNewCollectionTarget(local.db,collectionCommand({id:'selected-summary',tyshxydm:'91310115MA1H7KUG93',qymc:'平台摘要原名',rdjb:'2',szsmc:'宁波市',...fields},'2026-11-01T00:00:00Z',source))
  const own=createCurrentQualificationAssessmentReader(local.db.$client).read(c.enterprise.id,asOf).snapshot.titles.find(t=>t.titleCode==='specialized_sme')!
  expect(own.effectiveQualification?.status).toBe('effective')
  const basis=own.effectiveQualification?.presentationBasis?.join('\n')??''
  expect(basis).toContain(source==='queryBusList'?'认定目录':'申报记录')
  expect(basis).toContain('平台摘要原名')
  if(source==='queryBusList') {
   expect(basis).toContain('认定')
   expect(basis).toContain('2025-01-01')
   expect(basis).toContain('2028-01-01')
  } else {
   expect(basis).toContain('复核')
   expect(basis).toContain('业务年度：2024')
   expect(basis).toContain('2024–2027')
  }
  expect(basis).not.toMatch(/record:|version:|observation:/)
 } finally {await local.close()}
})

it('uses an ordinary same-code Ningbo recognized period despite stale Shanghai profile and no human gate', () => {
 const c=f.candidate('platform-only',[])
 f.db.update(schema.enterprise).set({usccNorm:'91330110MA2GMDFH58',city:'上海市',district:'上海市'}).where(eq(schema.enterprise.id,c.enterprise.id)).run()
 writeNewCollectionTarget(f.db,collectionCommand({id:'ordinary-platform',tyshxydm:'91330110MA2GMDFH58',qymc:'平台原名',rdjb:'2',rdtime:'2023-12-28 08:50:25',rddqrq:'2026-12-28',sfyx:'1',szsmc:'宁波市'},'2026-11-01T00:00:00Z'))
 expect(read(c.enterprise.id)).toMatchObject({group:'eligible',effectiveQualification:{status:'effective',source:{source:'recognized_list',period:{until:{raw:'2026-12-28',precision:'day'}}}}})
 writeNewCollectionTarget(f.db,collectionCommand({id:'ordinary-platform',tyshxydm:'91330110MA2GMDFH58',qymc:'平台原名',rdjb:'2',rdtime:'2023-12-28 08:50:25',rddqrq:'2026-12-28',sfyx:'0',sxsj:'2026-11-02',szsmc:'宁波市'},'2026-11-04T00:00:00Z'))
 expect(read(c.enterprise.id)).toMatchObject({group:'excluded'})
})

it.each([
 {name:'recognized explicit period overrides maintenance year',source:'queryBusList',events:[],extra:{rdtime:'2023-12-28 08:50:25',rddqrq:'2026-12-28',whpc:'2020-1'},expected:'eligible',chosen:'recognized_list'},
 {name:'expired publication remains authoritative over later recognition',source:'queryBusList',events:[{eventType:'award',year:2020,batchSeq:1}],extra:{rdtime:'2025-01-01',rddqrq:'2028-01-01'},expected:'excluded'},
 {name:'same-cycle failure blocks stale recognition',source:'queryBusList',events:[{eventType:'award',year:2023,batchSeq:1},{eventType:'review',year:2023,batchSeq:1,decidedYear:2026,reviewOutcome:'failed'}],extra:{rdtime:'2023-01-01',rddqrq:'2027-01-01'},expected:'excluded'},
 {name:'formal failure remains authoritative over later platform recognition',source:'queryBusList',events:[{eventType:'award',year:2020,batchSeq:1},{eventType:'review',year:2020,batchSeq:1,decidedYear:2023,reviewOutcome:'failed'}],extra:{rdtime:'2025-01-01',rddqrq:'2028-01-01'},expected:'excluded'},
 {name:'future recognition cannot grant today',source:'queryBusList',events:[],extra:{rdtime:'2027-01-01',rddqrq:'2030-01-01'},expected:'excluded'},
 {name:'business terminal application uses explicit year',source:'businessList',events:[],extra:{sblx:'申请',cszt:'终审通过',year:'2025'},expected:'eligible',chosen:'business_list'},
 {name:'declaration terminal application uses explicit year',source:'queryList',events:[],extra:{sblx:'申请',cszt:'终审通过',year:'2025'},expected:'eligible',chosen:'apply_list'},
 {name:'intermediate declaration cannot grant',source:'queryList',events:[],extra:{sblx:'申请',cszt:'省已审',year:'2025'},expected:'excluded'},
 {name:'update does not renew from business year',source:'queryList',events:[],extra:{sblx:'更新',cszt:'终审通过',year:'2025'},expected:'excluded'},
] as const)('$name', async scenario => {
 const local=qualificationExportFixture()
 try {
  const c=local.candidate(scenario.name,scenario.events.map(e=>({...e})))
  local.db.update(schema.enterprise).set({usccNorm:'91310115MA1H7KUG93'}).where(eq(schema.enterprise.id,c.enterprise.id)).run()
  const extra: PlatformRawRow = Object.fromEntries(Object.entries(scenario.extra))
  writeNewCollectionTarget(local.db,collectionCommand({id:'scenario-source',tyshxydm:'91310115MA1H7KUG93',qymc:'平台原名',rdjb:'2',sfyx:'1',szsmc:'宁波市',...extra},'2026-11-01T00:00:00Z',scenario.source))
  const result=createCurrentQualificationAssessmentReader(local.db.$client).read(c.enterprise.id,asOf).snapshot
  const own=result.titles.find(t=>t.titleCode==='specialized_sme')!
  expect(own.group).toBe(scenario.expected)
  if ('chosen' in scenario) expect(own.effectiveQualification?.source?.source).toBe(scenario.chosen)
 } finally {await local.close()}
})

it.each([
 ['91310115MA1H7KUG93','2026-03-06 00:00:00','2029-03-05 23:59:59'],
 ['91310114MA1GYDE2XE','2024-02-19 00:00:00','2027-02-18 23:59:59'],
 ['91440300MA5G2DGE3R','2024-01-17 16:01:06','2027-01-17'],
 ['91330110MA2GMDFH58','2023-12-28 08:50:25','2026-12-28'],
])('uses the archived period for %s including its final business day',async (code,from,until)=>{
 const local=qualificationExportFixture()
 try {
  const c=local.candidate(code,[])
  local.db.update(schema.enterprise).set({usccNorm:code}).where(eq(schema.enterprise.id,c.enterprise.id)).run()
  writeNewCollectionTarget(local.db,collectionCommand({id:'period',tyshxydm:code,qymc:'原平台名称',rdjb:'2',sfyx:'1',rdtime:from,rddqrq:until,szsmc:'宁波市'},'2026-11-01T00:00:00Z'))
  const reader=createCurrentQualificationAssessmentReader(local.db.$client)
  const last=Date.parse(until.slice(0,10)+'T15:59:59Z')
  expect(reader.read(c.enterprise.id,last).snapshot.titles.find(t=>t.titleCode==='specialized_sme')).toMatchObject({group:'eligible',effectiveQualification:{source:{period:{from:{raw:from},until:{raw:until}}}}})
  expect(reader.read(c.enterprise.id,last+1000).snapshot.titles.find(t=>t.titleCode==='specialized_sme')!.group).toBe('excluded')
  expect(reader.read(c.enterprise.id,asOf).snapshot.titles.find(t=>t.titleCode==='innovative_sme')!.group).toBe('eligible')
 } finally {await local.close()}
})
it('keeps current publication before platform sources and retains real subject exclusions',async()=>{
 const local=qualificationExportFixture()
 try {
  const c=local.candidate('publication first',[{eventType:'award',year:2025,batchSeq:1}])
  local.db.update(schema.enterprise).set({usccNorm:'91310115MA1H7KUG93'}).where(eq(schema.enterprise.id,c.enterprise.id)).run()
  writeNewCollectionTarget(local.db,collectionCommand({id:'negative',tyshxydm:'91310115MA1H7KUG93',rdjb:'2',sfyx:'0',rdtime:'2024-01-01',rddqrq:'2027-01-01',szsmc:'宁波市'},'2026-11-01T00:00:00Z'))
  const reader=createCurrentQualificationAssessmentReader(local.db.$client)
  expect(reader.read(c.enterprise.id,asOf).snapshot.titles.find(t=>t.titleCode==='specialized_sme')).toMatchObject({group:'eligible'})
  local.db.insert(schema.enterpriseFactRevision).values({enterpriseId:c.enterprise.id,factId:1,revision:1,status:'confirmed',fact:{kind:'moved_out',source:{reference:'official relocation',statement:'effective relocation'},effective:{precision:'day',value:'2026-01-01'},observed:{precision:'day',value:'2026-01-01'},city:null},action:'assert',actor:{type:'agent',id:'qualification'},basis:'official relocation',createdAt:'2026-01-01T00:00:00Z'}).run()
  expect(reader.read(c.enterprise.id,asOf).snapshot.titles.find(t=>t.titleCode==='specialized_sme')).toMatchObject({group:'excluded',effectiveQualification:{status:'moved_out'}})
 } finally {await local.close()}
})
it('selects recognized then business then application among currently usable sources',async()=>{
 const local=qualificationExportFixture()
 try {
  const c=local.candidate('source order',[])
  const code='91310115MA1H7KUG93'
  local.db.update(schema.enterprise).set({usccNorm:code}).where(eq(schema.enterprise.id,c.enterprise.id)).run()
  const reader=createCurrentQualificationAssessmentReader(local.db.$client)
  const selected=()=>reader.read(c.enterprise.id,asOf).snapshot.titles.find(t=>t.titleCode==='specialized_sme')!.effectiveQualification?.source?.source
  const process={tyshxydm:code,qymc:'原名',rdjb:'2',sblx:'申请',cszt:'终审通过',year:'2025'}
  writeNewCollectionTarget(local.db,collectionCommand({...process,id:'apply'},'2026-11-01T00:00:00Z','queryList'))
  expect(selected()).toBe('apply_list')
  writeNewCollectionTarget(local.db,collectionCommand({...process,id:'business'},'2026-11-01T01:00:00Z','businessList'))
  expect(selected()).toBe('business_list')
  writeNewCollectionTarget(local.db,collectionCommand({id:'recognized',tyshxydm:code,qymc:'原名',rdjb:'2',sfyx:'1',rdtime:'2024-01-01',rddqrq:'2027-01-01',szsmc:'宁波市'},'2026-11-01T02:00:00Z'))
  expect(selected()).toBe('recognized_list')
 } finally {await local.close()}
})

it.each(['queryBusList', 'queryList'] as const)('renews an independent platform grant without publication through %s', async source => {
 const local=qualificationExportFixture()
 try {
  const c=local.candidate('platform independent cycle',[])
  local.db.update(schema.enterprise).set({usccNorm:'91310115MA1H7KUG93'}).where(eq(schema.enterprise.id,c.enterprise.id)).run()
  const grant: PlatformRawRow = source === 'queryBusList'
   ? {rdtime:'2023-01-01',rddqrq:'2026-01-01',sfyx:'1'}
   : {sblx:'申请',cszt:'终审通过',year:'2023'}
  writeNewCollectionTarget(local.db,collectionCommand({id:'independent-platform-grant',tyshxydm:'91310115MA1H7KUG93',qymc:'原名',rdjb:'2',szsmc:'宁波市',...grant},'2026-10-01T00:00:00Z',source))
  writeNewCollectionTarget(local.db,collectionCommand({id:'platform-renewal',tyshxydm:'91310115MA1H7KUG93',qymc:'原名',rdjb:'2',sblx:'复核',cszt:'终审通过',year:'2026'},'2026-11-01T00:00:00Z','businessList'))
  const result=createCurrentQualificationAssessmentReader(local.db.$client).read(c.enterprise.id,asOf).snapshot.titles.find(t=>t.titleCode==='specialized_sme')!
  expect(result).toMatchObject({group:'eligible',effectiveQualification:{status:'effective',source:{source:'business_list',matter:'review',businessYear:2026}}})
 } finally {await local.close()}
})

it.each([
 {source:'queryBusList',grantYear:2023,expected:'eligible'},
 {source:'queryList',grantYear:2023,expected:'eligible'},
 {source:'queryBusList',grantYear:2019,expected:'excluded'},
 {source:'queryBusList',grantYear:2027,expected:'excluded'},
 {source:'queryBusList',grantYear:null,expected:'excluded'},
] as const)('scopes a retained directory invalidation to its old cycle: $source $grantYear', async ({source,grantYear,expected}) => {
 const local=qualificationExportFixture()
 try {
  const c=local.candidate('retained directory invalidation',[])
  const identity={tyshxydm:'91310115MA1H7KUG93',qymc:'原名',rdjb:'2',szsmc:'宁波市'}
  local.db.update(schema.enterprise).set({usccNorm:identity.tyshxydm}).where(eq(schema.enterprise.id,c.enterprise.id)).run()
  writeNewCollectionTarget(local.db,collectionCommand({...identity,id:'old-invalid-cycle',rdtime:'2019-01-01',rddqrq:'2022-12-31',sfyx:'0',sxsj:'2022-06-01'},'2026-09-01T00:00:00Z'))
  if(grantYear != null) {
   const grant: PlatformRawRow = source === 'queryBusList'
    ? {rdtime:`${grantYear}-01-01`,rddqrq:`${grantYear+3}-01-01`,sfyx:'1'}
    : {sblx:'申请',cszt:'终审通过',year:String(grantYear)}
   writeNewCollectionTarget(local.db,collectionCommand({...identity,id:'separate-independent-grant',...grant},'2026-10-01T00:00:00Z',source))
  }
  writeNewCollectionTarget(local.db,collectionCommand({...identity,id:'later-platform-review',sblx:'复核',cszt:'终审通过',year:'2026'},'2026-11-01T00:00:00Z','businessList'))
  const own=createCurrentQualificationAssessmentReader(local.db.$client).read(c.enterprise.id,asOf).snapshot.titles.find(t=>t.titleCode==='specialized_sme')!
  expect(own.group).toBe(expected)
  if(expected==='eligible')expect(own.effectiveQualification?.source).toMatchObject({source:'business_list',matter:'review',businessYear:2026})
 } finally {await local.close()}
})

it('uses a later platform application business year without inventing a submission date',async()=>{
 const local=qualificationExportFixture()
 try {
  const c=local.candidate('later platform application',[])
  const identity={tyshxydm:'91310115MA1H7KUG93',qymc:'原名',rdjb:'2',szsmc:'宁波市'}
  local.db.update(schema.enterprise).set({usccNorm:identity.tyshxydm}).where(eq(schema.enterprise.id,c.enterprise.id)).run()
  writeNewCollectionTarget(local.db,collectionCommand({...identity,id:'expired-invalid-directory',rdtime:'2019-01-01',rddqrq:'2022-12-31',sfyx:'0'},'2026-09-01T00:00:00Z'))
  writeNewCollectionTarget(local.db,collectionCommand({...identity,id:'later-application',sblx:'申请',cszt:'终审通过',year:'2025'},'2026-10-01T00:00:00Z','queryList'))
  const own=createCurrentQualificationAssessmentReader(local.db.$client).read(c.enterprise.id,asOf).snapshot.titles.find(t=>t.titleCode==='specialized_sme')!
  expect(own).toMatchObject({group:'eligible',effectiveQualification:{source:{source:'apply_list',matter:'apply',businessYear:2025}}})
 } finally {await local.close()}
})

function publishedInterval(local: ReturnType<typeof qualificationExportFixture>, recordId: number, interval: {validFrom:string;validThrough:string}, publishedOn?: string) {
 const event=local.db.select().from(schema.recordEvent).where(eq(schema.recordEvent.recordId,recordId)).all().find(e=>e.eventType==='award')!
 const evidence=local.db.select().from(schema.recordEvidence).where(eq(schema.recordEvidence.recordEventId,event.id)).get()!
 const sha='a'.repeat(64)
 local.db.insert(schema.storedFile).values({relPath:evidence.sourceFile,filename:'official.xlsx',ext:'xlsx',bytes:1,sha256:sha}).run()
 local.db.update(schema.recordEvent).set({formalValidity:{evidenceId:evidence.id,sourceSha256:sha,statementPages:[1],interval,...(publishedOn?{publishedOn}:{})}}).where(eq(schema.recordEvent.id,event.id)).run()
}


it.each(['queryBusList','businessList','queryList'] as const)('uses published interval boundaries despite platform success from %s',async source=>{
 const local=qualificationExportFixture()
 try {
  const c=local.candidate('publication governs boundaries',[{eventType:'award',year:2023,batchSeq:1}])
  publishedInterval(local,c.record.id,{validFrom:'2023-11-01',validThrough:'2026-10-31'})
  const code='91310115MA1H7KUG93'
  local.db.update(schema.enterprise).set({usccNorm:code}).where(eq(schema.enterprise.id,c.enterprise.id)).run()
  const fields:PlatformRawRow=source==='queryBusList'?{sfyx:'1',rdtime:'2022-01-01',rddqrq:'2029-12-31'}:{sblx:source==='businessList'?'申请':'复核',cszt:'终审通过',year:'2025'}
  writeNewCollectionTarget(local.db,collectionCommand({id:'platform-success',tyshxydm:code,rdjb:'2',szsmc:'宁波市',...fields},'2026-11-01T00:00:00Z',source))
  const reader=createCurrentQualificationAssessmentReader(local.db.$client)
  for(const [instant,group] of [['2023-10-31T15:59:59Z','excluded'],['2023-10-31T16:00:00Z','eligible'],['2026-10-31T15:59:59Z','eligible'],['2026-10-31T16:00:00Z','excluded']] as const) {
   const own=reader.read(c.enterprise.id,Date.parse(instant)).snapshot.titles.find(t=>t.titleCode==='specialized_sme')!
   expect(own.group,instant).toBe(group)
   expect(own.effectiveQualification?.source,instant).toBeUndefined()
  }
 } finally {await local.close()}
})

it.each([
 {title:'specialized_sme',award:2021,from:'2021-06-01',through:'2024-05-31',reviewYear:2024,submitted:'2024-08-30 09:03:05',rdjb:'2'},
 {title:'innovative_sme',award:2022,from:'2022-12-31',through:'2025-12-30',reviewYear:2026,submitted:'2026-04-01 11:44:05',rdjb:'1'},
])('does not renew a published $award award from a platform $reviewYear review',async scenario=>{
 const local=qualificationExportFixture()
 try {
  const c=local.candidate('expired publication with platform review',[{eventType:'award',year:scenario.award,batchSeq:1}],scenario.title)
  publishedInterval(local,c.record.id,{validFrom:scenario.from,validThrough:scenario.through})
  const code='91310115MA1H7KUG93'
  local.db.update(schema.enterprise).set({usccNorm:code}).where(eq(schema.enterprise.id,c.enterprise.id)).run()
  writeNewCollectionTarget(local.db,collectionCommand({id:'platform-review',tyshxydm:code,rdjb:scenario.rdjb,sblx:'复核',cszt:'终审通过',year:String(scenario.reviewYear),sqsj:scenario.submitted},'2026-11-01T00:00:00Z','queryList'))
  const own=createCurrentQualificationAssessmentReader(local.db.$client).read(c.enterprise.id,asOf).snapshot.titles.find(t=>t.titleCode===scenario.title)!
  expect(own).toMatchObject({group:'excluded',effectiveQualification:{status:'expired'}})
  expect(own.effectiveQualification?.source).toBeUndefined()
 } finally {await local.close()}
})

it.each(['queryBusList','businessList','queryList'] as const)('does not apply a future publication before platform source %s',async source=>{
 const local=qualificationExportFixture()
 try {
  const c=local.candidate('future publication',[{eventType:'award',year:2023,batchSeq:1}])
  publishedInterval(local,c.record.id,{validFrom:'2023-11-01',validThrough:'2026-10-31'},'2027-01-01')
  const code='91310115MA1H7KUG93'
  local.db.update(schema.enterprise).set({usccNorm:code}).where(eq(schema.enterprise.id,c.enterprise.id)).run()
  const fields:PlatformRawRow=source==='queryBusList'?{sfyx:'1',rdtime:'2024-02-04',rddqrq:'2027-02-04'}:{sblx:'申请',cszt:'终审通过',year:'2025'}
  writeNewCollectionTarget(local.db,collectionCommand({id:'current-platform',tyshxydm:code,rdjb:'2',szsmc:'宁波市',...fields},'2026-11-01T00:00:00Z',source))
  expect(createCurrentQualificationAssessmentReader(local.db.$client).read(c.enterprise.id,asOf).snapshot.titles.find(t=>t.titleCode==='specialized_sme')).toMatchObject({group:'eligible',effectiveQualification:{source:{source:source==='queryBusList'?'recognized_list':source==='businessList'?'business_list':'apply_list'}}})
 } finally {await local.close()}
})

import { preflightRosterImport, commitRosterImport } from '../../../server/utils/roster-import'
import { readImportReceipt } from '../../../server/utils/import-receipts'
import type { RosterImportRequest } from '../../../lib/roster-import-client'

it('keeps an imported publication authoritative when event evidence is omitted',async()=>{
 const local=qualificationExportFixture()
 try {
  const code='91310115MA1H7KUG93'
  const request:RosterImportRequest={idempotencyKey:'publication-without-event-evidence',sourceKind:'announcement',sourceIdentity:'synthetic/2021-publication',payload:{announcement:{sourceDocument:{source:'jxj',title:'2021年专精特新中小企业公布名单'},records:[{enterprise:{name:'公布已导入但暂缺逐行出处',uscc:code},source:'jxj',titleCode:'specialized_sme',events:[{eventType:'award',year:2021,batchSeq:1}]}]}}}
  expect(preflightRosterImport(local.db,request).status).toBe('preflight')
  const committed=commitRosterImport(local.db,request,[],{deferCandidateTasks:true})
  expect(committed.status,JSON.stringify(committed)).toBe('committed')
  const enterprise=local.db.select().from(schema.enterprise).where(eq(schema.enterprise.usccNorm,code)).get()!
  const record=local.db.select().from(schema.record).where(eq(schema.record.enterpriseId,enterprise.id)).get()!
  const event=local.db.select().from(schema.recordEvent).where(eq(schema.recordEvent.recordId,record.id)).get()!
  expect(record).toMatchObject({source:'jxj',titleCode:'specialized_sme'})
  expect(event).toMatchObject({eventType:'award',year:2021})
  expect(local.db.select().from(schema.recordEvidence).where(eq(schema.recordEvidence.recordEventId,event.id)).all()).toEqual([])
  expect(local.db.select().from(schema.evidenceRevision113).where(eq(schema.evidenceRevision113.eventId,event.id)).all()).toHaveLength(1)
  const receipt=readImportReceipt(local.db,'get',{batchId:committed.batchId})
  expect(receipt).toMatchObject({batchId:committed.batchId,status:'committed'})
  writeNewCollectionTarget(local.db,collectionCommand({id:'later-valid-directory',tyshxydm:code,rdjb:'2',sfyx:'1',rdtime:'2026-01-01',rddqrq:'2029-01-01',szsmc:'宁波市'},'2026-11-01T00:00:00Z'))
  const own=createCurrentQualificationAssessmentReader(local.db.$client).read(enterprise.id,asOf).snapshot.titles.find(t=>t.titleCode==='specialized_sme')!
  expect(own).toMatchObject({group:'excluded',effectiveQualification:{status:'expired'},evidence:[{eventId:event.id,year:2021,evidenceIds:[]}]})
  expect(own.effectiveQualification?.source).toBeUndefined()
  expect(own.completeness.gaps).toContain('missing_official_source')
  expect(readImportReceipt(local.db,'get',{batchId:committed.batchId})).toEqual(receipt)
 } finally {await local.close()}
})


it('stops source eligibility evaluation after the first valid directory while retaining fallback behavior', () => {
 const c=f.candidate('ordered source evaluation',[{eventType:'nurture',year:2025}]),code='913302125705899102'
 f.db.update(schema.enterprise).set({usccNorm:code,city:'宁波市'}).where(eq(schema.enterprise.id,c.enterprise.id)).run()
 for(const source of ['queryBusList','businessList','queryList'] as const)writeNewCollectionTarget(f.db,collectionCommand({id:'ordered-source-'+source,tyshxydm:code,qymc:c.enterprise.name,rdjb:'2',sfyx:'1',rdtime:'2025-02-01',rddqrq:'2028-02-01',szsmc:'宁波市',sblx:'申请',cszt:'终审通过',year:'2025'},'2026-10-01T00:00:00Z',source))
 const contains=vi.spyOn(platformQualification,'periodContains')
 const reader=createCurrentQualificationAssessmentReader(f.db.$client)
 f.db.$client.exec('BEGIN')
 try {
  expect(reader.readEffectiveTitles([c.enterprise.id],asOf,'specialized_sme')).toEqual(new Map([[c.enterprise.id,'effective']]))
  expect(contains).toHaveBeenCalledTimes(1)
  expect(contains.mock.calls[0]![0].raw).toBe('2025-02-01')
 }finally{f.db.$client.exec('ROLLBACK');contains.mockRestore()}
 // The latest directory row is not a grant; a complete lower-priority application remains usable.
 writeNewCollectionTarget(f.db,collectionCommand({id:'ordered-source-queryBusList',tyshxydm:code,qymc:c.enterprise.name,rdjb:'2',sfyx:'',szsmc:'宁波市'},'2026-10-02T00:00:00Z'))
 expect(reader.readCurrent(c.enterprise.id,asOf,'specialized_sme').snapshot.titles.find(t=>t.titleCode==='specialized_sme')).toMatchObject({effectiveQualification:{status:'effective',source:{source:'business_list'}}})
})
