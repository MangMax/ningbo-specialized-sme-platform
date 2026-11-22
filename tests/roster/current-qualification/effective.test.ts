import { beforeEach, expect, it } from 'vitest'
import { useIsolatedPostgresCases, singlePostgresFixtureRow as single } from '../../support/isolated-postgres-cases'
import type { Event } from '../current-export/fixtures/specialized-export'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { readPostgresCurrentDetailBatch } from '../../../layers/sme-roster/lib/roster/current-qualification-postgres'
import { seedPostgresPlatformQuery } from '../../platform/fixtures/postgres-query'
import * as schema from '../fixtures/postgres-tables'
const createDb = useIsolatedPostgresCases()
let db: NodePgDatabase
beforeEach(() => { db = createDb() })

async function candidate(name: string, events: Event[], titleCode = 'specialized_sme') {
  const enterprise = single(await db.insert(schema.enterprise).values({ name, nameNorm: name, city: '宁波市', district: '鄞州区' }).returning())
  const record = single(await db.insert(schema.record).values({ enterpriseId: enterprise.id, source: 'jxj', titleCode, nameRaw: name }).returning())
  for (const event of events) {
    const row = single(await db.insert(schema.recordEvent).values({ recordId: record.id, ...event }).returning())
    await db.insert(schema.recordEvidence).values({ recordEventId: row.id, sourceFile: 'synthetic/effective-qualification.pdf', listNo: enterprise.id })
  }
  return { enterprise, record }
}
const asOf = Date.parse('2026-11-05T12:00:00Z')
async function snapshot(db: NodePgDatabase, id: number, time = asOf) {
  const result = await db.transaction(async tx => (await readPostgresCurrentDetailBatch(tx, [id], 'specialized_sme', time)).get(id)?.snapshot, { isolationLevel: 'repeatable read', accessMode: 'read only' })
  if (!result) throw new Error('Missing qualification for seeded enterprise ' + id)
  return result
}
async function read(id: number) {
  return (await snapshot(db, id)).titles.find(t => t.titleCode === 'specialized_sme')!
}
async function fact(id: number, kind: string, status = 'confirmed', reference = 'official reference', effective = '2026-01-01') {
  await db.insert(schema.enterpriseFactRevision).values({ enterpriseId:id,factId:1,revision:1,status:status as 'confirmed',fact:JSON.stringify({kind,source:{reference,statement:'official statement'},effective:{precision:'day',value:effective},observed:{precision:'day',value:'2026-01-01'},city:null}),action:'assert',actor:JSON.stringify({type:'agent',id:'test478'}),basis:'verified basis',createdAt:'2026-01-01T00:00:00Z' })
}
it.each(['cancelled','moved_out'])('excludes only a complete confirmed %s fact', async kind => {
 const c = await candidate('complete-'+kind,[{eventType:'award',year:2025,batchSeq:1}]); await fact(c.enterprise.id,kind)
 expect(await read(c.enterprise.id)).toMatchObject({group:'excluded',effectiveQualification:{status:kind === 'cancelled' ? 'terminated' : 'moved_out'}})
})
it.each(['cancelled','moved_out'])('retains eligibility for incomplete or unconfirmed %s', async kind => {
 for (const [status,reference,date] of [['pending','ref','2026-01-01'],['confirmed','','2026-01-01'],['confirmed','ref','2027-01-01']]) {
  const c=await candidate('incomplete-'+kind+status+reference+date,[{eventType:'award',year:2025,batchSeq:1}]); await fact(c.enterprise.id,kind,status,reference,date)
  expect(await read(c.enterprise.id)).toMatchObject({group:'eligible',effectiveQualification:{status:'effective'}})
 }
})
it.each(['moved_in','registration_status'])('does not let %s establish eligibility', async kind => {
 const c=await candidate('nonaward-'+kind,[{eventType:'nurture',year:2025}]); await fact(c.enterprise.id,kind)
 expect(await read(c.enterprise.id)).toMatchObject({group:'excluded',effectiveQualification:{status:'unrecognized'}})
})
it.each(['passed','failed',null] as const)('formal review-only %s preserves missing origin coordinates', async outcome=>{
 const c=await candidate('review-only-'+outcome,[{eventType:'review',year:null,decidedYear:2026,batchSeq:null,reviewOutcome:outcome}])
 const result=await read(c.enterprise.id)
 expect(result.group).toBe(outcome==='passed'?'eligible':'excluded')
 expect(result.evidence[0]).toMatchObject({year:null,batchSeq:null,decidedYear:2026,reviewOutcome:outcome})
})
it.each(['cancelled','moved_out'])('still excludes an old giant with a confirmed %s boundary',async kind=>{
 const c=await candidate('old giant boundary '+kind,[{eventType:'award',year:2018,batchSeq:1}],'little_giant')
 await fact(c.enterprise.id,kind)
 const result=(await snapshot(db, c.enterprise.id))
 expect(result.titles.map(t=>t.group)).toEqual(['excluded','excluded','excluded'])
 expect(result.titles[0]!.effectiveQualification!.status).toBe(kind==='cancelled'?'terminated':'moved_out')
})

import { eq } from 'drizzle-orm'
import { platformResultToImport } from '../../../layers/sme-roster/lib/platform/recognized-evidence'
import type { PlatformRawRow } from '../../../layers/sme-roster/lib/platform/types'
import type { PlatformLiveQueryResult } from '../../../layers/sme-roster/lib/platform/live-query'
import { processFactsFromRow } from '../../../layers/sme-roster/lib/platform/identity'
function collectionCommand(row: PlatformRawRow, queriedAt: string, source: PlatformLiveQueryResult['source'] = 'queryBusList') {
  const evidence: PlatformLiveQueryResult = {
    source, status: 'success', effectiveConditions: source === 'businessList' ? { uscc: String(row.tyshxydm), combination: 'and' } : { name: 'Example', combination: 'and' },
    titleScope: source === 'queryList' ? { mode: 'source_default', rdjb: [] } : { mode: 'selected', rdjb: [String(row.rdjb ?? '2')] }, queriedAt, completedAt: queriedAt,
    rows: [Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value)]))], dataRows: [row], pages: [{ source, rdjb: source === 'queryList' ? null : String(row.rdjb ?? '2'), page: 1, maxPage: 1, status: 'success', fetchedCount: 1, declaredTotal: 1, error: null }],
    fetchedCount: 1, declaredTotal: 1, completeness: 'complete', fullRange: true, unfinished: [], error: null,
    limits: { maxRequests: 100, maxRows: 5000, maxDurationMs: 60000, pageSize: 50 },
  }
  const query = platformResultToImport(evidence)
  if (source !== 'queryBusList') query.relations = query.relations?.map(r => ({ ...r, ...processFactsFromRow(evidence.rows[0]!) }))
  return query
}

it.each(['queryBusList','queryList'] as const)('presents the selected platform basis and its supported period for %s',async source=>{
  const c=await candidate('selected platform summary',[])
  await db.update(schema.enterprise).set({usccNorm:'91310115MA1H7KUG93'}).where(eq(schema.enterprise.id,c.enterprise.id))
  const fields: PlatformRawRow = source==='queryBusList'
   ? {rdtime:'2025-01-01',rddqrq:'2028-01-01',sfyx:'1'}
   : {sblx:'复核',cszt:'终审通过',year:'2024',sqsj:'2024-08-30 09:03:05'}
  await seedPostgresPlatformQuery(db,collectionCommand({id:'selected-summary',tyshxydm:'91310115MA1H7KUG93',qymc:'平台摘要原名',rdjb:'2',szsmc:'宁波市',...fields},'2026-11-01T00:00:00Z',source))
  const own=(await snapshot(db, c.enterprise.id)).titles.find(t=>t.titleCode==='specialized_sme')!
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
})

it('uses an ordinary same-code Ningbo recognized period despite stale Shanghai profile and no human gate', async () => {
 const c=await candidate('platform-only',[])
 await db.update(schema.enterprise).set({usccNorm:'91330110MA2GMDFH58',city:'上海市',district:'上海市'}).where(eq(schema.enterprise.id,c.enterprise.id))
 await seedPostgresPlatformQuery(db,collectionCommand({id:'ordinary-platform',tyshxydm:'91330110MA2GMDFH58',qymc:'平台原名',rdjb:'2',rdtime:'2023-12-28 08:50:25',rddqrq:'2026-12-28',sfyx:'1',szsmc:'宁波市'},'2026-11-01T00:00:00Z'))
 expect(await read(c.enterprise.id)).toMatchObject({group:'eligible',effectiveQualification:{status:'effective',source:{source:'recognized_list',period:{until:{raw:'2026-12-28',precision:'day'}}}}})
 await seedPostgresPlatformQuery(db,collectionCommand({id:'ordinary-platform',tyshxydm:'91330110MA2GMDFH58',qymc:'平台原名',rdjb:'2',rdtime:'2023-12-28 08:50:25',rddqrq:'2026-12-28',sfyx:'0',sxsj:'2026-11-02',szsmc:'宁波市'},'2026-11-04T00:00:00Z'))
 expect(await read(c.enterprise.id)).toMatchObject({group:'excluded'})
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
  const c=await candidate(scenario.name,scenario.events.map(e=>({...e})))
  await db.update(schema.enterprise).set({usccNorm:'91310115MA1H7KUG93'}).where(eq(schema.enterprise.id,c.enterprise.id))
  const extra: PlatformRawRow = Object.fromEntries(Object.entries(scenario.extra))
  await seedPostgresPlatformQuery(db,collectionCommand({id:'scenario-source',tyshxydm:'91310115MA1H7KUG93',qymc:'平台原名',rdjb:'2',sfyx:'1',szsmc:'宁波市',...extra},'2026-11-01T00:00:00Z',scenario.source))
  const result=(await snapshot(db, c.enterprise.id))
  const own=result.titles.find(t=>t.titleCode==='specialized_sme')!
  expect(own.group).toBe(scenario.expected)
  if ('chosen' in scenario) expect(own.effectiveQualification?.source?.source).toBe(scenario.chosen)
})

it.each([
 ['91310115MA1H7KUG93','2026-03-06 00:00:00','2029-03-05 23:59:59'],
 ['91310114MA1GYDE2XE','2024-02-19 00:00:00','2027-02-18 23:59:59'],
 ['91440300MA5G2DGE3R','2024-01-17 16:01:06','2027-01-17'],
 ['91330110MA2GMDFH58','2023-12-28 08:50:25','2026-12-28'],
])('uses the archived period for %s including its final business day',async (code,from,until)=>{
  const c=await candidate(code,[])
  await db.update(schema.enterprise).set({usccNorm:code}).where(eq(schema.enterprise.id,c.enterprise.id))
  await seedPostgresPlatformQuery(db,collectionCommand({id:'period',tyshxydm:code,qymc:'原平台名称',rdjb:'2',sfyx:'1',rdtime:from,rddqrq:until,szsmc:'宁波市'},'2026-11-01T00:00:00Z'))
  const last=Date.parse(until.slice(0,10)+'T15:59:59Z')
  expect((await snapshot(db, c.enterprise.id, last)).titles.find(t=>t.titleCode==='specialized_sme')).toMatchObject({group:'eligible',effectiveQualification:{source:{period:{from:{raw:from},until:{raw:until}}}}})
  expect((await snapshot(db, c.enterprise.id, last+1000)).titles.find(t=>t.titleCode==='specialized_sme')!.group).toBe('excluded')
  expect((await snapshot(db, c.enterprise.id, asOf)).titles.find(t=>t.titleCode==='innovative_sme')!.group).toBe('eligible')
})
it('keeps current publication before platform sources and retains real subject exclusions',async()=>{
  const c=await candidate('publication first',[{eventType:'award',year:2025,batchSeq:1}])
  await db.update(schema.enterprise).set({usccNorm:'91310115MA1H7KUG93'}).where(eq(schema.enterprise.id,c.enterprise.id))
  await seedPostgresPlatformQuery(db,collectionCommand({id:'negative',tyshxydm:'91310115MA1H7KUG93',rdjb:'2',sfyx:'0',rdtime:'2024-01-01',rddqrq:'2027-01-01',szsmc:'宁波市'},'2026-11-01T00:00:00Z'))
  expect((await snapshot(db, c.enterprise.id, asOf)).titles.find(t=>t.titleCode==='specialized_sme')).toMatchObject({group:'eligible'})
  await db.insert(schema.enterpriseFactRevision).values({enterpriseId:c.enterprise.id,factId:1,revision:1,status:'confirmed',fact:JSON.stringify({kind:'moved_out',source:{reference:'official relocation',statement:'effective relocation'},effective:{precision:'day',value:'2026-01-01'},observed:{precision:'day',value:'2026-01-01'},city:null}),action:'assert',actor:JSON.stringify({type:'agent',id:'qualification'}),basis:'official relocation',createdAt:'2026-01-01T00:00:00Z'})
  expect((await snapshot(db, c.enterprise.id, asOf)).titles.find(t=>t.titleCode==='specialized_sme')).toMatchObject({group:'excluded',effectiveQualification:{status:'moved_out'}})
})
it('selects recognized then business then application among currently usable sources',async()=>{
  const c=await candidate('source order',[])
  const code='91310115MA1H7KUG93'
  await db.update(schema.enterprise).set({usccNorm:code}).where(eq(schema.enterprise.id,c.enterprise.id))
  const selected=async()=>(await snapshot(db, c.enterprise.id, asOf)).titles.find(t=>t.titleCode==='specialized_sme')!.effectiveQualification?.source?.source
  const process={tyshxydm:code,qymc:'原名',rdjb:'2',sblx:'申请',cszt:'终审通过',year:'2025'}
  await seedPostgresPlatformQuery(db,collectionCommand({...process,id:'apply'},'2026-11-01T00:00:00Z','queryList'))
  expect(await selected()).toBe('apply_list')
  await seedPostgresPlatformQuery(db,collectionCommand({...process,id:'business'},'2026-11-01T01:00:00Z','businessList'))
  expect(await selected()).toBe('business_list')
  await seedPostgresPlatformQuery(db,collectionCommand({id:'recognized',tyshxydm:code,qymc:'原名',rdjb:'2',sfyx:'1',rdtime:'2024-01-01',rddqrq:'2027-01-01',szsmc:'宁波市'},'2026-11-01T02:00:00Z'))
  expect(await selected()).toBe('recognized_list')
})

it.each(['queryBusList', 'queryList'] as const)('renews an independent platform grant without publication through %s', async source => {
  const c=await candidate('platform independent cycle',[])
  await db.update(schema.enterprise).set({usccNorm:'91310115MA1H7KUG93'}).where(eq(schema.enterprise.id,c.enterprise.id))
  const grant: PlatformRawRow = source === 'queryBusList'
   ? {rdtime:'2023-01-01',rddqrq:'2026-01-01',sfyx:'1'}
   : {sblx:'申请',cszt:'终审通过',year:'2023'}
  await seedPostgresPlatformQuery(db,collectionCommand({id:'independent-platform-grant',tyshxydm:'91310115MA1H7KUG93',qymc:'原名',rdjb:'2',szsmc:'宁波市',...grant},'2026-10-01T00:00:00Z',source))
  await seedPostgresPlatformQuery(db,collectionCommand({id:'platform-renewal',tyshxydm:'91310115MA1H7KUG93',qymc:'原名',rdjb:'2',sblx:'复核',cszt:'终审通过',year:'2026'},'2026-11-01T00:00:00Z','businessList'))
  const result=(await snapshot(db, c.enterprise.id)).titles.find(t=>t.titleCode==='specialized_sme')!
  expect(result).toMatchObject({group:'eligible',effectiveQualification:{status:'effective',source:{source:'business_list',matter:'review',businessYear:2026}}})
})

it.each([
 {source:'queryBusList',grantYear:2023,expected:'eligible'},
 {source:'queryList',grantYear:2023,expected:'eligible'},
 {source:'queryBusList',grantYear:2019,expected:'excluded'},
 {source:'queryBusList',grantYear:2027,expected:'excluded'},
 {source:'queryBusList',grantYear:null,expected:'excluded'},
] as const)('scopes a retained directory invalidation to its old cycle: $source $grantYear', async ({source,grantYear,expected}) => {
  const c=await candidate('retained directory invalidation',[])
  const identity={tyshxydm:'91310115MA1H7KUG93',qymc:'原名',rdjb:'2',szsmc:'宁波市'}
  await db.update(schema.enterprise).set({usccNorm:identity.tyshxydm}).where(eq(schema.enterprise.id,c.enterprise.id))
  await seedPostgresPlatformQuery(db,collectionCommand({...identity,id:'old-invalid-cycle',rdtime:'2019-01-01',rddqrq:'2022-12-31',sfyx:'0',sxsj:'2022-06-01'},'2026-09-01T00:00:00Z'))
  if(grantYear != null) {
   const grant: PlatformRawRow = source === 'queryBusList'
    ? {rdtime:`${grantYear}-01-01`,rddqrq:`${grantYear+3}-01-01`,sfyx:'1'}
    : {sblx:'申请',cszt:'终审通过',year:String(grantYear)}
   await seedPostgresPlatformQuery(db,collectionCommand({...identity,id:'separate-independent-grant',...grant},'2026-10-01T00:00:00Z',source))
  }
  await seedPostgresPlatformQuery(db,collectionCommand({...identity,id:'later-platform-review',sblx:'复核',cszt:'终审通过',year:'2026'},'2026-11-01T00:00:00Z','businessList'))
  const own=(await snapshot(db, c.enterprise.id)).titles.find(t=>t.titleCode==='specialized_sme')!
  expect(own.group).toBe(expected)
  if(expected==='eligible')expect(own.effectiveQualification?.source).toMatchObject({source:'business_list',matter:'review',businessYear:2026})
})

it('uses a later platform application business year without inventing a submission date',async()=>{
  const c=await candidate('later platform application',[])
  const identity={tyshxydm:'91310115MA1H7KUG93',qymc:'原名',rdjb:'2',szsmc:'宁波市'}
  await db.update(schema.enterprise).set({usccNorm:identity.tyshxydm}).where(eq(schema.enterprise.id,c.enterprise.id))
  await seedPostgresPlatformQuery(db,collectionCommand({...identity,id:'expired-invalid-directory',rdtime:'2019-01-01',rddqrq:'2022-12-31',sfyx:'0'},'2026-09-01T00:00:00Z'))
  await seedPostgresPlatformQuery(db,collectionCommand({...identity,id:'later-application',sblx:'申请',cszt:'终审通过',year:'2025'},'2026-10-01T00:00:00Z','queryList'))
  const own=(await snapshot(db, c.enterprise.id)).titles.find(t=>t.titleCode==='specialized_sme')!
  expect(own).toMatchObject({group:'eligible',effectiveQualification:{source:{source:'apply_list',matter:'apply',businessYear:2025}}})
})

async function publishedInterval(recordId: number, interval: {validFrom:string;validThrough:string}, publishedOn?: string) {
 const event=(await db.select().from(schema.recordEvent).where(eq(schema.recordEvent.recordId,recordId))).find(e=>e.eventType==='award')!
 const evidence=(await db.select().from(schema.recordEvidence).where(eq(schema.recordEvidence.recordEventId,event.id)))[0]!
 const sha='a'.repeat(64)
 await db.insert(schema.storedFile).values({createdAt:'2026-01-01T00:00:00Z',relPath:evidence.sourceFile,filename:'official.xlsx',ext:'xlsx',bytes: 1n,sha256:sha})
 await db.update(schema.recordEvent).set({formalValidity:JSON.stringify({evidenceId:evidence.id,sourceSha256:sha,statementPages:[1],interval,...(publishedOn?{publishedOn}:{})})}).where(eq(schema.recordEvent.id,event.id))
}


it.each(['queryBusList','businessList','queryList'] as const)('uses published interval boundaries despite platform success from %s',async source=>{
  const c=await candidate('publication governs boundaries',[{eventType:'award',year:2023,batchSeq:1}])
  await publishedInterval(c.record.id,{validFrom:'2023-11-01',validThrough:'2026-10-31'})
  const code='91310115MA1H7KUG93'
  await db.update(schema.enterprise).set({usccNorm:code}).where(eq(schema.enterprise.id,c.enterprise.id))
  const fields:PlatformRawRow=source==='queryBusList'?{sfyx:'1',rdtime:'2022-01-01',rddqrq:'2029-12-31'}:{sblx:source==='businessList'?'申请':'复核',cszt:'终审通过',year:'2025'}
  await seedPostgresPlatformQuery(db,collectionCommand({id:'platform-success',tyshxydm:code,rdjb:'2',szsmc:'宁波市',...fields},'2026-11-01T00:00:00Z',source))
  for(const [instant,group] of [['2023-10-31T15:59:59Z','excluded'],['2023-10-31T16:00:00Z','eligible'],['2026-10-31T15:59:59Z','eligible'],['2026-10-31T16:00:00Z','excluded']] as const) {
   const own=(await snapshot(db, c.enterprise.id, Date.parse(instant))).titles.find(t=>t.titleCode==='specialized_sme')!
   expect(own.group,instant).toBe(group)
   expect(own.effectiveQualification?.source,instant).toBeUndefined()
  }
})

it.each([
 {title:'specialized_sme',award:2021,from:'2021-06-01',through:'2024-05-31',reviewYear:2024,submitted:'2024-08-30 09:03:05',rdjb:'2'},
 {title:'innovative_sme',award:2022,from:'2022-12-31',through:'2025-12-30',reviewYear:2026,submitted:'2026-04-01 11:44:05',rdjb:'1'},
])('does not renew a published $award award from a platform $reviewYear review',async scenario=>{
  const c=await candidate('expired publication with platform review',[{eventType:'award',year:scenario.award,batchSeq:1}],scenario.title)
  await publishedInterval(c.record.id,{validFrom:scenario.from,validThrough:scenario.through})
  const code='91310115MA1H7KUG93'
  await db.update(schema.enterprise).set({usccNorm:code}).where(eq(schema.enterprise.id,c.enterprise.id))
  await seedPostgresPlatformQuery(db,collectionCommand({id:'platform-review',tyshxydm:code,rdjb:scenario.rdjb,sblx:'复核',cszt:'终审通过',year:String(scenario.reviewYear),sqsj:scenario.submitted},'2026-11-01T00:00:00Z','queryList'))
  const own=(await snapshot(db, c.enterprise.id)).titles.find(t=>t.titleCode===scenario.title)!
  expect(own).toMatchObject({group:'excluded',effectiveQualification:{status:'expired'}})
  expect(own.effectiveQualification?.source).toBeUndefined()
})

it.each(['queryBusList','businessList','queryList'] as const)('does not apply a future publication before platform source %s',async source=>{
  const c=await candidate('future publication',[{eventType:'award',year:2023,batchSeq:1}])
  await publishedInterval(c.record.id,{validFrom:'2023-11-01',validThrough:'2026-10-31'},'2027-01-01')
  const code='91310115MA1H7KUG93'
  await db.update(schema.enterprise).set({usccNorm:code}).where(eq(schema.enterprise.id,c.enterprise.id))
  const fields:PlatformRawRow=source==='queryBusList'?{sfyx:'1',rdtime:'2024-02-04',rddqrq:'2027-02-04'}:{sblx:'申请',cszt:'终审通过',year:'2025'}
  await seedPostgresPlatformQuery(db,collectionCommand({id:'current-platform',tyshxydm:code,rdjb:'2',szsmc:'宁波市',...fields},'2026-11-01T00:00:00Z',source))
  expect((await snapshot(db, c.enterprise.id)).titles.find(t=>t.titleCode==='specialized_sme')).toMatchObject({group:'eligible',effectiveQualification:{source:{source:source==='queryBusList'?'recognized_list':source==='businessList'?'business_list':'apply_list'}}})
})

it('keeps an incomplete publication authoritative over a later eligible directory row', async () => {
  const record = await candidate('公布已导入但暂缺逐行出处', [{ eventType: 'award', year: 2021, batchSeq: 1 }])
  await db.update(schema.enterprise).set({ usccNorm: '91310115MA1H7KUG93' }).where(eq(schema.enterprise.id, record.enterprise.id))
  const events = await db.select({ id: schema.recordEvent.id }).from(schema.recordEvent).where(eq(schema.recordEvent.recordId, record.record.id))
  await db.delete(schema.recordEvidence).where(eq(schema.recordEvidence.recordEventId, events[0]!.id))
  await seedPostgresPlatformQuery(db, collectionCommand({
    id: 'later-valid-directory', tyshxydm: '91310115MA1H7KUG93', rdjb: '2', sfyx: '1',
    rdtime: '2026-01-01', rddqrq: '2029-01-01', szsmc: '宁波市',
  }, '2026-11-02T00:00:00Z'))
  const own = await read(record.enterprise.id)
  expect(own).toMatchObject({ group: 'excluded', effectiveQualification: { status: 'expired' }, evidence: [{ eventId: events[0]!.id, year: 2021, evidenceIds: [] }] })
  expect(own.effectiveQualification?.source).toBeUndefined()
  expect(own.completeness.gaps).toContain('missing_official_source')
})
