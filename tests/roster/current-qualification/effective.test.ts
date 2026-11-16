import { afterAll, expect, it } from 'vitest'
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
 {name:'expired publication yields to later recognition',source:'queryBusList',events:[{eventType:'award',year:2020,batchSeq:1}],extra:{rdtime:'2025-01-01',rddqrq:'2028-01-01'},expected:'eligible',chosen:'recognized_list'},
 {name:'same-cycle failure blocks stale recognition',source:'queryBusList',events:[{eventType:'award',year:2023,batchSeq:1},{eventType:'review',year:2023,batchSeq:1,decidedYear:2026,reviewOutcome:'failed'}],extra:{rdtime:'2023-01-01',rddqrq:'2027-01-01'},expected:'excluded'},
 {name:'later independent recognition restores after old failure',source:'queryBusList',events:[{eventType:'award',year:2020,batchSeq:1},{eventType:'review',year:2020,batchSeq:1,decidedYear:2023,reviewOutcome:'failed'}],extra:{rdtime:'2025-01-01',rddqrq:'2028-01-01'},expected:'eligible',chosen:'recognized_list'},
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
  writeNewCollectionTarget(local.db,collectionCommand({id:'scenario-source',tyshxydm:'91310115MA1H7KUG93',qymc:'平台原名',rdjb:'2',sfyx:'1',szsmc:'宁波市',...scenario.extra},'2026-11-01T00:00:00Z',scenario.source))
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
