import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { qualificationExportFixture } from '../current-export/fixtures/qualification-export'
import { getPostgresComparison } from '../../../layers/sme-roster/lib/comparison'
import { CURRENT_TITLES } from '../../../layers/sme-roster/lib/roster/current-titles'
import { readPostgresCurrentQualification, readPostgresDifferenceQualifications } from '../../../layers/sme-roster/lib/roster/current-qualification-postgres'
import { listPostgresRosterDifferences } from '../../../layers/sme-roster/lib/roster/difference-list-postgres'
import { readPostgresRosterEnterpriseDetail } from '../../../layers/sme-roster/lib/roster/enterprise-detail-postgres'
import { listPostgresRosterEnterprises } from '../../../layers/sme-roster/lib/roster/enterprise-list-postgres'
import { listPostgresDifferences } from '../../../layers/sme-roster/server/utils/mcp-roster-postgres'
import * as schema from '../fixtures/postgres-tables'
import { seedPostgresPlatformQuery } from '../../platform/fixtures/postgres-query'
import { singlePostgresFixtureRow } from '../../support/isolated-postgres-cases'

const f = qualificationExportFixture()
beforeAll(() => f.prepare(), 60_000)
afterAll(() => { vi.useRealTimers(); return f.close() })
it('retains raw extras alongside effective inherited qualification and stored history through expiry', async () => {
 vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-06-01T00:00:00Z'))
 const c=await f.candidate('current-overlay',[{eventType:'award',year:2025,batchSeq:1}],'specialized_sme')
 await f.db.insert(schema.rosterLegacyMember).values({enterpriseId:c.enterprise.id})
 await f.db.insert(schema.record).values({enterpriseId:c.enterprise.id,titleCode:'innovative_sme',source:'miit',nameRaw:'current-overlay'})
 const scope={title:['innovative_sme'],direction:['extra_in_miit'] as ['extra_in_miit']}
 expect((await getPostgresComparison(f.db)).rows).toContainEqual(expect.objectContaining({enterpriseId:c.enterprise.id,titleCode:'innovative_sme',direction:'extra_in_miit'}))
 expect(await listPostgresRosterDifferences(f.db,scope)).toMatchObject({total:1,rows:[{inCurrentDifference:true,qualification:{status:'effective'},suggestedAction:'none'}]})
 expect((await listPostgresRosterEnterprises(f.db,{page:1,pageSize:50})).rows.find(r=>r.enterpriseId===c.enterprise.id)!.difference.count).toBe(2)
 const head=singlePostgresFixtureRow(await f.db.insert(schema.differenceReason).values({enterpriseId:c.enterprise.id,titleCode:'innovative_sme',direction:'extra_in_miit',status:'needs_review',createdAt:'2026-01-01',recordedAt:'2026-01-01'}).returning())
 expect(await listPostgresRosterDifferences(f.db,scope)).toMatchObject({total:1,counts:{innovative_sme:{extra_in_miit:1}},rows:[{inCurrentDifference:true,status:'needs_review'}]})
 const stored=await listPostgresDifferences(f.db,{title:'innovative_sme'})
 expect(stored.rows).toMatchObject([{enterpriseId:c.enterprise.id,status:'needs_review'}])
 expect((await readPostgresRosterEnterpriseDetail(f.db,c.enterprise.id))!.differences.find(r=>r.titleCode==='innovative_sme')).toMatchObject({inCurrentDifference:true})
 expect((await listPostgresRosterEnterprises(f.db,{page:1,pageSize:50})).rows.find(r=>r.enterpriseId===c.enterprise.id)!.difference.count).toBe(2)
 vi.setSystemTime(new Date('2029-06-01T00:00:00Z'))
 expect((await listPostgresRosterDifferences(f.db,scope)).rows[0]).toMatchObject({inCurrentDifference:true})
 expect(await listPostgresDifferences(f.db,{title:'innovative_sme'})).toEqual(stored)
 expect(singlePostgresFixtureRow(await f.db.select().from(schema.differenceReason).where(eq(schema.differenceReason.id,head.id)))).toEqual(head)
})

it('retains raw extras when a same-cycle failure changes qualification and suggested action', async () => {
 vi.setSystemTime(new Date('2026-06-01T00:00:00Z'))
 const c=await f.candidate('source-withdrawal',[{eventType:'award',year:2025,batchSeq:1}],'little_giant')
 await f.db.insert(schema.record).values({enterpriseId:c.enterprise.id,titleCode:'innovative_sme',source:'miit',nameRaw:'source-withdrawal'})
 const read=()=>listPostgresRosterDifferences(f.db,{q:'source-withdrawal',title:['innovative_sme'],direction:['extra_in_miit'],pageSize:1})
 expect(await read()).toMatchObject({total:1,rows:[{qualification:{status:'effective'},suggestedAction:'none'}],counts:{innovative_sme:{extra_in_miit:1}}})
 const failure=singlePostgresFixtureRow(await f.db.insert(schema.recordEvent).values({ recordId:c.record.id,eventType:'review',year:2025,decidedYear:2026,batchSeq:1,reviewOutcome:'failed' }).returning())
 await f.db.insert(schema.recordEvidence).values({recordEventId:failure.id,sourceFile:'synthetic/formal-failed-review.pdf',page:1})
 expect(await read()).toMatchObject({total:1,rows:[{enterpriseId:c.enterprise.id,inCurrentDifference:true,qualification:{status:'unrecognized'},suggestedAction:'collect_source_facts'}],counts:{innovative_sme:{extra_in_miit:1}}})
})

it('retains an invalid own lower title as current extra without a higher basis', async () => {
 vi.setSystemTime(new Date('2026-06-01T00:00:00Z'))
 const c=await f.candidate('invalid-own',[{eventType:'award',year:2018,batchSeq:1}],'innovative_sme')
 await f.db.update(schema.enterprise).set({usccNorm:null}).where(eq(schema.enterprise.id,c.enterprise.id))
 await f.db.insert(schema.record).values({enterpriseId:c.enterprise.id,titleCode:'innovative_sme',source:'miit',nameRaw:'invalid-own'})
 expect(await listPostgresRosterDifferences(f.db,{q:'invalid-own',direction:['extra_in_miit']})).toMatchObject({total:1,rows:[{enterpriseId:c.enterprise.id,inCurrentDifference:true}]})
})

it('keeps historical moved-in qualification readable without granting ordinary qualification', async () => {
 vi.setSystemTime(new Date('2026-06-01T00:00:00Z'))
 const c=await f.candidate('historical-explanation',[])
 await f.db.insert(schema.record).values({enterpriseId:c.enterprise.id,titleCode:'innovative_sme',source:'miit',nameRaw:'historical-explanation'})
 await f.decision(c.enterprise.id,'moved_in',{titleCode:'innovative_sme',currentQualification:JSON.stringify({titleCode:'innovative_sme',validFrom:'2025-01-01',validUntil:'2028-01-01',basis:'Historical explanation only',publicationCheck:{status:'not_found',scope:'historical search'}})})
 const row=(await listPostgresRosterDifferences(f.db,{q:'historical-explanation',title:['innovative_sme']})).rows[0]!
 expect(row).toMatchObject({inCurrentDifference:true,reasonCode:'moved_in',qualification:{status:'unrecognized'},suggestedAction:'collect_source_facts'})
 expect(row.currentDecision.current).toMatchObject({currentQualification:{basis:'Historical explanation only'}})
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

it('retains platform-only source differences as targeted facts arrive and change', async () => {
 vi.setSystemTime(new Date('2026-06-01T00:00:00Z'))
 const c=await f.candidate('targeted-platform',[])
 await f.db.update(schema.enterprise).set({usccNorm:'91330110MA2GMDFH58'}).where(eq(schema.enterprise.id,c.enterprise.id))
 await f.db.insert(schema.record).values({enterpriseId:c.enterprise.id,titleCode:'innovative_sme',source:'miit',nameRaw:'targeted-platform'})
 const read=()=>listPostgresRosterDifferences(f.db,{q:'targeted-platform',title:['innovative_sme']})
 expect(await read()).toMatchObject({total:1,rows:[{qualification:{status:'unrecognized'}}]})
 const row={id:'targeted-recognition',tyshxydm:'91330110MA2GMDFH58',qymc:'targeted-platform',rdjb:'1',rdtime:'2025-01-01',rddqrq:'2028-01-01',sfyx:'1',szsmc:'宁波市'}
 await seedPostgresPlatformQuery(f.db,collectionCommand(row,'2026-05-01T00:00:00Z'))
 expect(await read()).toMatchObject({total:1,rows:[{inCurrentDifference:true,qualification:{status:'effective',source:{source:'recognized_list'}},suggestedAction:'none'}]})
 await seedPostgresPlatformQuery(f.db,collectionCommand({...row,sfyx:'0',sxsj:'2026-05-10'},'2026-05-11T00:00:00Z'))
 // A captured explicit invalidation is already a source conclusion, not a collection gap.
 expect(await read()).toMatchObject({total:1,rows:[{inCurrentDifference:true,qualification:{status:'unrecognized'},suggestedAction:'none'}]})
 // The two comparison sides align when a published row arrives; stored history remains.
 await f.decision(c.enterprise.id,'other',{titleCode:'innovative_sme',reasonNote:'Retained source explanation'})
 await f.addRecord(c.enterprise.id,'targeted-platform',[{eventType:'award',year:2025,batchSeq:1}],'innovative_sme')
 expect(await read()).toMatchObject({total:1,rows:[{inCurrentDifference:false,reasonNote:'Retained source explanation',qualification:{status:'effective'},suggestedAction:'none'}]})
})

it('retains missing-platform coordinates and counts before pagination independently of qualification', async () => {
 vi.setSystemTime(new Date('2026-06-01T00:00:00Z'))
 await f.candidate('page-source-A',[{eventType:'award',year:2025,batchSeq:1}])
 await f.candidate('page-source-B',[{eventType:'award',year:2025,batchSeq:1}])
 const result=await listPostgresRosterDifferences(f.db,{q:'page-source-',title:['specialized_sme'],page:2,pageSize:1})
 expect(result).toMatchObject({total:2,page:2,pageSize:1,counts:{specialized_sme:{missing_in_miit:2,extra_in_miit:0}},rows:[{name:'page-source-B',direction:'missing_in_miit',inCurrentDifference:true,qualification:{status:'effective'},suggestedAction:'none'}]})
})

it.each([
 { name:'expired', events:[{eventType:'award' as const,year:2020,batchSeq:1}], fact:null, status:'expired' },
 { name:'terminated', events:[], fact:'cancelled', status:'terminated' },
 { name:'moved-out', events:[], fact:'moved_out', status:'moved_out' },
])('does not request collection for the established $name conclusion', async ({name,events,fact,status}) => {
 vi.setSystemTime(new Date('2026-06-01T00:00:00Z'))
 const c=await f.candidate('settled-'+name,events,'specialized_sme')
 if(fact) await f.db.insert(schema.enterpriseFactRevision).values({enterpriseId:c.enterprise.id,factId:1,revision:1,status:'confirmed',fact:JSON.stringify({kind:fact,source:{reference:'official/settled-subject',statement:'Published subject conclusion'},effective:{precision:'day',value:'2026-01-01'},observed:{precision:'day',value:'2026-01-01'},city:null}),action:'assert',actor:JSON.stringify({type:'agent',id:'comparison-fixture'}),basis:'Verified subject fact',createdAt:'2026-01-01T00:00:00Z'})
 await f.decision(c.enterprise.id,'other',{direction:'missing_in_miit',reasonNote:'Retained explanation for settled conclusion'})
 const read=()=>listPostgresRosterDifferences(f.db,{q:'settled-'+name,title:['specialized_sme']})
 // A known end of qualification is a conclusion, not a missing source to collect.
 expect(await read()).toMatchObject({total:1,rows:[{inCurrentDifference:true,reasonNote:'Retained explanation for settled conclusion',qualification:{status},suggestedAction:'none'}]})
})

it('suggests source collection for a missing directory period and clears advice when the period is supplied', async () => {
 vi.setSystemTime(new Date('2026-06-01T00:00:00Z'))
 const c=await f.candidate('period-gap',[])
 await f.db.update(schema.enterprise).set({usccNorm:'91330201753252106U'}).where(eq(schema.enterprise.id,c.enterprise.id))
 await f.db.insert(schema.record).values({enterpriseId:c.enterprise.id,titleCode:'innovative_sme',source:'miit',nameRaw:'period-gap'})
 const row={id:'missing-period',tyshxydm:'91330201753252106U',qymc:'period-gap',rdjb:'1',sfyx:'1',szsmc:'宁波市'}
 const read=()=>listPostgresRosterDifferences(f.db,{q:'period-gap',title:['innovative_sme']})
 await seedPostgresPlatformQuery(f.db,collectionCommand(row,'2026-05-03T00:00:00Z'))
 // sfyx alone cannot establish a period: the missing source fields justify collection.
 expect(await read()).toMatchObject({total:1,rows:[{inCurrentDifference:true,qualification:{status:'unrecognized'},suggestedAction:'collect_source_facts'}]})
 await seedPostgresPlatformQuery(f.db,collectionCommand({...row,rdtime:'2025-01-01',rddqrq:'2028-01-01'},'2026-05-04T00:00:00Z'))
 expect(await read()).toMatchObject({total:1,rows:[{inCurrentDifference:true,qualification:{status:'effective'},suggestedAction:'none'}]})
})

it.each(['终审通过','未知状态'])('does not recollect a settled directory invalidation because an older process has %s',async status=>{
 vi.setSystemTime(new Date('2026-06-01T00:00:00Z'))
 const local=qualificationExportFixture()
 await local.prepare()
 try {
  const c=await local.candidate('settled-directory',[])
  const identity={tyshxydm:'91310115MA1H7KUG93',qymc:'settled-directory',rdjb:'1',szsmc:'宁波市'}
  await local.db.update(schema.enterprise).set({usccNorm:identity.tyshxydm}).where(eq(schema.enterprise.id,c.enterprise.id))
  await local.db.insert(schema.record).values({enterpriseId:c.enterprise.id,titleCode:'innovative_sme',source:'miit',nameRaw:'settled-directory'})
  await seedPostgresPlatformQuery(local.db,collectionCommand({...identity,id:'older-process',sblx:'申请',cszt:status},'2026-05-01T00:00:00Z','businessList'))
  await seedPostgresPlatformQuery(local.db,collectionCommand({...identity,id:'settled-invalid-directory',rdtime:'2025-01-01',rddqrq:'2028-01-01',sfyx:'0',sxsj:'2026-05-10'},'2026-05-12T00:00:00Z'))
  const filter={q:'settled-directory',title:['innovative_sme']}
  const result=await listPostgresRosterDifferences(local.db,filter)
  expect(result).toMatchObject({total:1,rows:[{enterpriseId:c.enterprise.id,inCurrentDifference:true,qualification:{status:'unrecognized'},suggestedAction:'none'}]})
 } finally {await local.close()}
})

it('retains higher-title qualification when loading difference assessments', async () => {
  const c = await f.candidate('page-dependencies', [{ eventType: 'award', year: 2025, batchSeq: 1 }], 'little_giant')
  const asOf = Date.parse('2026-06-01T00:00:00Z')
  await f.db.transaction(async tx => {
    const full = await readPostgresCurrentQualification(tx, c.enterprise.id, asOf)
    expect(full?.titles.map(row => row.titleCode)).toEqual([...CURRENT_TITLES])
    const page = await readPostgresDifferenceQualifications(tx, [c.enterprise.id], asOf)
    expect(page.assessed).toHaveLength(3)
    expect(page.assessed.map(row => row.assessment.titleCode)).toEqual([...CURRENT_TITLES])
    expect(page.assessed.every(row => row.assessment.effectiveQualification?.status === 'effective')).toBe(true)
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' })
})
