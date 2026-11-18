import { afterAll, expect, it, vi } from 'vitest'
import { qualificationExportFixture } from '../current-export/fixtures/qualification-export'
import { createCurrentQualificationAssessmentReader, CURRENT_TITLES } from '../../../lib/roster/current-qualification'
import { getComparison } from '../../../lib/comparison'
import { listRosterDifferences } from '../../../lib/roster/difference-list'
import { getRosterEnterpriseDetail } from '../../../layers/sme-roster/lib/roster/enterprise-roster'
import { selectEnterpriseCoordinates } from '../../../layers/sme-roster/lib/roster/enterprise-list-selection'
import { listRosterDifferences as legacyDifferences } from '../../../layers/sme-roster/lib/roster/enterprise-roster'
import { listDifferences } from '../../../server/utils/mcp-roster'
const f = qualificationExportFixture()
afterAll(() => { vi.useRealTimers(); return f.close() })
it('retains raw extras alongside effective inherited qualification and stored history through expiry', () => {
 vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-06-01T00:00:00Z'))
 const c=f.candidate('current-overlay',[{eventType:'award',year:2025,batchSeq:1}],'specialized_sme')
 f.db.$client.prepare("insert into record (enterprise_id,title_code,source,name_raw) values (?,'innovative_sme','miit','current-overlay')").run(c.enterprise.id)
 const scope={title:['innovative_sme'],direction:['extra_in_miit'] as ['extra_in_miit']}
 expect(getComparison(f.db).rows).toContainEqual(expect.objectContaining({enterpriseId:c.enterprise.id,titleCode:'innovative_sme',direction:'extra_in_miit'}))
 expect(listRosterDifferences(f.db,scope)).toMatchObject({total:1,rows:[{inCurrentDifference:true,qualification:{status:'effective'},suggestedAction:'none'}]})
 expect(legacyDifferences(f.db,scope).total).toBe(1)
 expect(selectEnterpriseCoordinates(f.db,{}).candidates.find(r=>r.id===c.enterprise.id)!.difference.count).toBe(2)
 const head=f.db.$client.prepare("insert into difference_reason (enterprise_id,title_code,direction,status,created_at,recorded_at) values (?,'innovative_sme','extra_in_miit','needs_review','2026-01-01','2026-01-01') returning *").get(c.enterprise.id)
 expect(listRosterDifferences(f.db,scope)).toMatchObject({total:1,counts:{innovative_sme:{extra_in_miit:1}},rows:[{inCurrentDifference:true,status:'needs_review'}]})
 expect(legacyDifferences(f.db,scope).rows[0]).toMatchObject({inCurrentDifference:true})
 const stored=listDifferences(f.db,{title:'innovative_sme'})
 expect(stored.rows).toMatchObject([{enterpriseId:c.enterprise.id,status:'needs_review'}])
 expect(getRosterEnterpriseDetail(f.db,c.enterprise.id)!.differences.find(r=>r.titleCode==='innovative_sme')).toMatchObject({inCurrentDifference:true})
 expect(selectEnterpriseCoordinates(f.db,{}).candidates.find(r=>r.id===c.enterprise.id)!.difference.count).toBe(2)
 vi.setSystemTime(new Date('2029-06-01T00:00:00Z'))
 expect(listRosterDifferences(f.db,scope).rows[0]).toMatchObject({inCurrentDifference:true})
 expect(listDifferences(f.db,{title:'innovative_sme'})).toEqual(stored)
 expect(f.db.$client.prepare('select * from difference_reason').get()).toEqual(head)
})

it('retains raw extras when a same-cycle failure changes qualification and suggested action', () => {
 vi.setSystemTime(new Date('2026-06-01T00:00:00Z'))
 const c=f.candidate('source-withdrawal',[{eventType:'award',year:2025,batchSeq:1}],'little_giant')
 f.db.$client.prepare("insert into record (enterprise_id,title_code,source,name_raw) values (?,'innovative_sme','miit','source-withdrawal')").run(c.enterprise.id)
 const read=()=>listRosterDifferences(f.db,{q:'source-withdrawal',title:['innovative_sme'],direction:['extra_in_miit'],pageSize:1})
 expect(read()).toMatchObject({total:1,rows:[{qualification:{status:'effective'},suggestedAction:'none'}],counts:{innovative_sme:{extra_in_miit:1}}})
 const failure=f.db.$client.prepare("insert into record_event (record_id,event_type,year,decided_year,batch_seq,review_outcome) values (?,'review',2025,2026,1,'failed') returning id").get(c.record.id) as {id:number}
 f.db.$client.prepare('insert into record_evidence (record_event_id,source_file,page) values (?,?,1)').run(failure.id,'synthetic/formal-failed-review.pdf')
 expect(read()).toMatchObject({total:1,rows:[{enterpriseId:c.enterprise.id,inCurrentDifference:true,qualification:{status:'unrecognized'},suggestedAction:'collect_source_facts'}],counts:{innovative_sme:{extra_in_miit:1}}})
})

it('retains an invalid own lower title as current extra without a higher basis',()=>{
 vi.setSystemTime(new Date('2026-06-01T00:00:00Z'))
 const c=f.candidate('invalid-own',[{eventType:'award',year:2018,batchSeq:1}],'innovative_sme')
 f.db.$client.prepare('update enterprise set uscc_norm=null where id=?').run(c.enterprise.id)
 f.db.$client.prepare("insert into record (enterprise_id,title_code,source,name_raw) values (?,'innovative_sme','miit','invalid-own')").run(c.enterprise.id)
 expect(listRosterDifferences(f.db,{q:'invalid-own',direction:['extra_in_miit']})).toMatchObject({total:1,rows:[{enterpriseId:c.enterprise.id,inCurrentDifference:true}]})
})

it('keeps historical moved-in qualification readable without granting ordinary qualification', () => {
 vi.setSystemTime(new Date('2026-06-01T00:00:00Z'))
 const c=f.candidate('historical-explanation',[])
 f.db.$client.prepare("insert into record (enterprise_id,title_code,source,name_raw) values (?,'innovative_sme','miit','historical-explanation')").run(c.enterprise.id)
 f.decision(c.enterprise.id,'moved_in',{titleCode:'innovative_sme',currentQualification:{titleCode:'innovative_sme',validFrom:'2025-01-01',validUntil:'2028-01-01',basis:'Historical explanation only',publicationCheck:{status:'not_found',scope:'historical search'}}})
 const row=listRosterDifferences(f.db,{q:'historical-explanation',title:['innovative_sme']}).rows[0]!
 expect(row).toMatchObject({inCurrentDifference:true,reasonCode:'moved_in',qualification:{status:'unrecognized'},suggestedAction:'collect_source_facts'})
 expect(row.currentDecision.current).toMatchObject({currentQualification:{basis:'Historical explanation only'}})
})

import { schema } from '../../../db/client'
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

it('retains platform-only source differences as targeted facts arrive and change', () => {
 vi.setSystemTime(new Date('2026-06-01T00:00:00Z'))
 const c=f.candidate('targeted-platform',[])
 f.db.update(schema.enterprise).set({usccNorm:'91330110MA2GMDFH58'}).where(eq(schema.enterprise.id,c.enterprise.id)).run()
 f.db.$client.prepare("insert into record (enterprise_id,title_code,source,name_raw) values (?,'innovative_sme','miit','targeted-platform')").run(c.enterprise.id)
 const read=()=>listRosterDifferences(f.db,{q:'targeted-platform',title:['innovative_sme']})
 expect(read()).toMatchObject({total:1,rows:[{qualification:{status:'unrecognized'}}]})
 const row={id:'targeted-recognition',tyshxydm:'91330110MA2GMDFH58',qymc:'targeted-platform',rdjb:'1',rdtime:'2025-01-01',rddqrq:'2028-01-01',sfyx:'1',szsmc:'宁波市'}
 writeNewCollectionTarget(f.db,collectionCommand(row,'2026-05-01T00:00:00Z'))
 expect(read()).toMatchObject({total:1,rows:[{inCurrentDifference:true,qualification:{status:'effective',source:{source:'recognized_list'}},suggestedAction:'none'}]})
 writeNewCollectionTarget(f.db,collectionCommand({...row,sfyx:'0',sxsj:'2026-05-10'},'2026-05-11T00:00:00Z'))
 // A captured explicit invalidation is already a source conclusion, not a collection gap.
 expect(read()).toMatchObject({total:1,rows:[{inCurrentDifference:true,qualification:{status:'unrecognized'},suggestedAction:'none'}]})
 // The two comparison sides align when a published row arrives; stored history remains.
 f.decision(c.enterprise.id,'other',{titleCode:'innovative_sme',reasonNote:'Retained source explanation'})
 f.addRecord(c.enterprise.id,'targeted-platform',[{eventType:'award',year:2025,batchSeq:1}],'innovative_sme')
 expect(read()).toMatchObject({total:1,rows:[{inCurrentDifference:false,reasonNote:'Retained source explanation',qualification:{status:'effective'},suggestedAction:'none'}]})
})

it('retains missing-platform coordinates and counts before pagination independently of qualification', () => {
 vi.setSystemTime(new Date('2026-06-01T00:00:00Z'))
 f.candidate('page-source-A',[{eventType:'award',year:2025,batchSeq:1}])
 f.candidate('page-source-B',[{eventType:'award',year:2025,batchSeq:1}])
 const result=listRosterDifferences(f.db,{q:'page-source-',title:['specialized_sme'],page:2,pageSize:1})
 expect(result).toMatchObject({total:2,page:2,pageSize:1,counts:{specialized_sme:{missing_in_miit:2,extra_in_miit:0}},rows:[{name:'page-source-B',direction:'missing_in_miit',inCurrentDifference:true,qualification:{status:'effective'},suggestedAction:'none'}]})
 expect(legacyDifferences(f.db,{q:'page-source-',title:['specialized_sme'],page:2,pageSize:1})).toEqual(result)
})

it.each([
 { name:'expired', events:[{eventType:'award' as const,year:2020,batchSeq:1}], fact:null, status:'expired' },
 { name:'terminated', events:[], fact:'cancelled', status:'terminated' },
 { name:'moved-out', events:[], fact:'moved_out', status:'moved_out' },
])('does not request collection for the established $name conclusion', ({name,events,fact,status}) => {
 vi.setSystemTime(new Date('2026-06-01T00:00:00Z'))
 const c=f.candidate('settled-'+name,events,'specialized_sme')
 if(fact) f.db.insert(schema.enterpriseFactRevision).values({enterpriseId:c.enterprise.id,factId:1,revision:1,status:'confirmed',fact:{kind:fact,source:{reference:'official/settled-subject',statement:'Published subject conclusion'},effective:{precision:'day',value:'2026-01-01'},observed:{precision:'day',value:'2026-01-01'},city:null},action:'assert',actor:{type:'agent',id:'comparison-fixture'},basis:'Verified subject fact',createdAt:'2026-01-01T00:00:00Z'}).run()
 f.decision(c.enterprise.id,'other',{direction:'missing_in_miit',reasonNote:'Retained explanation for settled conclusion'})
 const read=()=>listRosterDifferences(f.db,{q:'settled-'+name,title:['specialized_sme']})
 // A known end of qualification is a conclusion, not a missing source to collect.
 expect(read()).toMatchObject({total:1,rows:[{inCurrentDifference:true,reasonNote:'Retained explanation for settled conclusion',qualification:{status},suggestedAction:'none'}]})
 expect(legacyDifferences(f.db,{q:'settled-'+name,title:['specialized_sme']})).toEqual(read())
})

it('suggests source collection for a missing directory period and clears advice when the period is supplied', () => {
 vi.setSystemTime(new Date('2026-06-01T00:00:00Z'))
 const c=f.candidate('period-gap',[])
 f.db.update(schema.enterprise).set({usccNorm:'91330201753252106U'}).where(eq(schema.enterprise.id,c.enterprise.id)).run()
 f.db.$client.prepare("insert into record (enterprise_id,title_code,source,name_raw) values (?,'innovative_sme','miit','period-gap')").run(c.enterprise.id)
 const row={id:'missing-period',tyshxydm:'91330201753252106U',qymc:'period-gap',rdjb:'1',sfyx:'1',szsmc:'宁波市'}
 const read=()=>listRosterDifferences(f.db,{q:'period-gap',title:['innovative_sme']})
 writeNewCollectionTarget(f.db,collectionCommand(row,'2026-05-03T00:00:00Z'))
 // sfyx alone cannot establish a period: the missing source fields justify collection.
 expect(read()).toMatchObject({total:1,rows:[{inCurrentDifference:true,qualification:{status:'unrecognized'},suggestedAction:'collect_source_facts'}]})
 writeNewCollectionTarget(f.db,collectionCommand({...row,rdtime:'2025-01-01',rddqrq:'2028-01-01'},'2026-05-04T00:00:00Z'))
 expect(read()).toMatchObject({total:1,rows:[{inCurrentDifference:true,qualification:{status:'effective'},suggestedAction:'none'}]})
})

it.each(['终审通过','未知状态'])('does not recollect a settled directory invalidation because an older process has %s',async status=>{
 vi.setSystemTime(new Date('2026-06-01T00:00:00Z'))
 const local=qualificationExportFixture()
 try {
  const c=local.candidate('settled-directory',[])
  const identity={tyshxydm:'91310115MA1H7KUG93',qymc:'settled-directory',rdjb:'1',szsmc:'宁波市'}
  local.db.update(schema.enterprise).set({usccNorm:identity.tyshxydm}).where(eq(schema.enterprise.id,c.enterprise.id)).run()
  local.db.$client.prepare("insert into record (enterprise_id,title_code,source,name_raw) values (?,'innovative_sme','miit','settled-directory')").run(c.enterprise.id)
  writeNewCollectionTarget(local.db,collectionCommand({...identity,id:'older-process',sblx:'申请',cszt:status},'2026-05-01T00:00:00Z','businessList'))
  writeNewCollectionTarget(local.db,collectionCommand({...identity,id:'settled-invalid-directory',rdtime:'2025-01-01',rddqrq:'2028-01-01',sfyx:'0',sxsj:'2026-05-10'},'2026-05-12T00:00:00Z'))
  const filter={q:'settled-directory',title:['innovative_sme']}
  const result=listRosterDifferences(local.db,filter)
  expect(result).toMatchObject({total:1,rows:[{enterpriseId:c.enterprise.id,inCurrentDifference:true,qualification:{status:'unrecognized'},suggestedAction:'none'}]})
  expect(legacyDifferences(local.db,filter)).toEqual(result)
 } finally {await local.close()}
})

it('hydrates only requested difference titles while retaining full higher-title versions and default reads', () => {
 const c=f.candidate('page-dependencies',[{eventType:'award',year:2025,batchSeq:1}],'little_giant')
 const asOf=Date.parse('2026-06-01T00:00:00Z')
 const reader=createCurrentQualificationAssessmentReader(f.db.$client)
 f.db.transaction(()=>{
  const full=reader.read(c.enterprise.id,asOf).snapshot
  expect(full.titles.map(row=>row.titleCode)).toEqual([...CURRENT_TITLES])
  const page=reader.readDifferenceBatch(CURRENT_TITLES.map(titleCode=>({enterpriseId:c.enterprise.id,titleCode})),asOf)
  expect(page.snapshots).toHaveLength(3)
  for(const {snapshot} of page.snapshots){
   expect(snapshot.titles).toHaveLength(1)
   const title=snapshot.titles[0]!.titleCode
   const previous=reader.readCurrentBatch([c.enterprise.id],asOf,title)[0]!.snapshot.titles.find(row=>row.titleCode===title)
   expect(snapshot.titles[0]).toEqual(previous)
   expect(snapshot.titles[0]!.effectiveQualification).toMatchObject({status:'effective'})
  }
 })
})
