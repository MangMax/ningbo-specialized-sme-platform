import { submitSyntheticRecognizedCollection } from '../fixtures/recognized-source'
import { submitNativePlatformQuery } from '../../platform/fixtures/native-query'
import { afterAll, beforeEach, expect, it } from 'vitest'
import { assertQualificationRowsSnapshotEqual } from '../fixtures/qualification-matrix'
import { schema as s } from '../../../db/client'
import { commitRecordCorrespondences, preflightRecordCorrespondences } from '../../../server/utils/record-correspondence'
import { readEvidenceToken113 } from '../../../server/utils/evidence-impact-113'
import { specializedExportFixture, year } from '../current-export/fixtures/specialized-export'

const fixture = specializedExportFixture()
const f = { ...fixture, get db() { return fixture.db }, get dbPath() { return fixture.dbPath }, candidate: (name: string, events?: Parameters<typeof fixture.candidate>[1], title = 'innovative_sme') => fixture.candidate(name, events, title) }
let linkOffset = 0
beforeEach(async () => {
  await f.resetBusiness(); await f.start()
}, 90000)
afterAll(f.close)

async function query(params: Record<string, string>) {
  const response = await fetch(f.url('/api/roster/current-enterprises?' + new URLSearchParams({ titleCode: 'innovative_sme', ...params })))
  return { response, body: await response.json() as any }
}

async function mcp(args: Record<string, unknown>) {
  const response = await fetch(f.url('/mcp'), { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' }, body: JSON.stringify({ jsonrpc: '2.0', id: 155, method: 'tools/call', params: { name: 'list_current_qualified_enterprises', arguments: { titleCode: 'innovative_sme', ...args } } }) })
  expect(response.status).toBe(200)
  const raw = await response.text()
  const payload = JSON.parse(raw.startsWith('event:') ? raw.split('\n').find(line => line.startsWith('data: '))!.slice(6) : raw)
  return JSON.parse(payload.result.content[0].text)
}

function linkRecognized(enterpriseId: number, eventId: number, conditions: Record<string, string>, role: 'recognized_corrob' | 'current_context' = 'recognized_corrob', rawFields: Record<string, unknown> = {}, multiTitle = false, partial = false) {
  const enterprise = f.db.select().from(s.enterprise).all().find(row => row.id === enterpriseId)!
  const title = (f.db.$client.prepare('select r.title_code as title from record_event e join record r on r.id=e.record_id where e.id=?').get(eventId) as {title:string}).title
  const rdjb = {innovative_sme:'1',specialized_sme:'2',little_giant:'3'}[title]!
  const stamp = new Date(Date.now() + ++linkOffset * 1000).toISOString()
  rawFields = { id: `synthetic-filter155-${linkOffset}`, qymc: enterprise.name, tyshxydm: enterprise.usccNorm, rdjb, ...rawFields }
  const native = submitSyntheticRecognizedCollection(f.db, { rdjb: multiTitle ? '1,2,3' : rdjb, queriedAt: stamp, conditions, partial, rows: [{ raw: rawFields, enterpriseId }] })
  const relation = { id: native.relationIds[0]! }
  const request = { idempotencyKey: `filter-155-${relation.id}`, sourceIdentity: `synthetic/filter-155/${relation.id}`, actor: { type: 'agent' as const, id: 'test' }, basis: 'synthetic confirmed event and recognized row', ruleId: 'manual', ruleVersion: '1', operations: [{ action: 'create' as const, status: 'confirmed' as const, edge: { type: 'event_recognized' as const, eventId, relationId: relation.id, role } }] }
  const plan = preflightRecordCorrespondences(f.db, request)
  commitRecordCorrespondences(f.db, request, plan.planHash)
  return {...relation,queryId:native.queryId}
}

it('filters a formal current award by full-year contained recognition range and reports partial overlap separately', async () => {
  const a = f.candidate('本期甲', [{ eventType: 'award', year: year - 2, batchSeq: 1 }, { eventType: 'review', year: year - 2, batchSeq: 1, decidedYear: year, reviewOutcome: 'passed' }])
  f.candidate('本期乙', [{ eventType: 'award', year: year - 1, batchSeq: 1 }])
  const full = await query({ recognitionFrom: `${year - 2}-01-01`, recognitionTo: `${year - 2}-12-31` })
  expect(full.response.status).toBe(200)
  expect(full.body).toMatchObject({ total: 1, uncertainTotal: 0, rows: [{ enterpriseId: a.enterprise.id, recognition: { precision: 'year', year: year - 2 } }] })
  const partial = await query({ recognitionFrom: `${year - 2}-02-01`, recognitionTo: `${year - 2}-12-31` })
  expect(partial.body).toMatchObject({ total: 0, uncertainTotal: 1, rows: [] })
  expect((await mcp({ recognitionFrom: `${year - 2}-02-01`, recognitionTo: `${year - 2}-12-31` })).uncertainTotal).toBe(1)
})

it('requires one current award and one confirmed recognized relation for valid and maintenance condition matches', async () => {
  const current = f.candidate('当前周期', [{ eventType: 'award', year: year, batchSeq: 1 }])
  const old = f.candidate('旧周期借用', [{ eventType: 'award', year: year - 4, batchSeq: 1 }, { eventType: 'award', year, batchSeq: 1 }])
  const eventFor = (id: number, eventYear: number) => (f.db.$client.prepare('select e.id from record_event e join record r on r.id=e.record_id where r.enterprise_id=? and e.year=? and e.event_type=? order by e.id desc limit 1').get(id, eventYear, 'award') as { id: number }).id
  const matchedRelation=linkRecognized(current.enterprise.id, eventFor(current.enterprise.id, year), { rddqrq: String(year + 2), whpcyear: String(year - 1), whpc: '2' }, 'recognized_corrob', {rddqrq:`${year+2}-11-20`,whpc:`${year-1}-2`})
  linkRecognized(old.enterprise.id, eventFor(old.enterprise.id, year - 4), { rddqrq: String(year + 2), whpcyear: String(year - 1), whpc: '2' }, 'recognized_corrob', {rddqrq:`${year+2}-11-20`,whpc:`${year-1}-2`})
  const params = { validYear: String(year + 2), maintenanceYear: String(year - 1) }
  const result = await query(params)
  expect(result.response.status).toBe(200)
  expect(result.body).toMatchObject({ total: 1, rows: [{ enterpriseId: current.enterprise.id }] })
  expect(result.body.rows[0]).toMatchObject({matchedValidYears:[year+2],matchedMaintenance:[{year:year-1,batch:null}],qualificationWitnesses:[{matchedValidYear:year+2,matchedMaintenance:{year:year-1,batch:null},conditionQueryId:matchedRelation.queryId}]})
  expect(result.body.rows[0]).not.toHaveProperty('validYears')
  assertQualificationRowsSnapshotEqual((await mcp({ validYear: year + 2, maintenanceYear: year - 1 })).rows, result.body.rows)
  expect(result.body.options).toMatchObject({ validYears: [year + 2], maintenanceYears: [year - 1] })
  expect((await query({ validYear: String(year + 3) })).body.total).toBe(0) // lifecycle dueYear is not source validYear
})

it('does not combine valid year and maintenance year from different recognized rows or context-only links', async () => {
  const a = f.candidate('同周期不同来源')
  const eventId = (f.db.$client.prepare('select e.id from record_event e join record r on r.id=e.record_id where r.enterprise_id=?').get(a.enterprise.id) as {id:number}).id
  linkRecognized(a.enterprise.id,eventId,{rddqrq:String(year+2)},'recognized_corrob',{rddqrq:`${year+2}-06-01`})
  linkRecognized(a.enterprise.id,eventId,{whpcyear:String(year-1),whpc:'3'},'recognized_corrob',{whpc:`${year-1}-3`})
  linkRecognized(a.enterprise.id,eventId,{rddqrq:String(year+3),whpcyear:String(year-1),whpc:'3'},'current_context',{rddqrq:`${year+3}-06-01`,whpc:`${year-1}-3`})
  const valid = await query({ validYear:String(year+2) })
  expect(valid.body.total).toBe(1)
  expect((await query({ maintenanceYear:String(year-1) })).body.total).toBe(1)
  expect((await query({ validYear:String(year+2),maintenanceYear:String(year-1) })).body).toMatchObject({total:0,rows:[]})
  expect((await query({ validYear:String(year+3) })).body.total).toBe(0)
})

it('uses returned structured facts and leaves condition-only, malformed, and conflicting facts unknown', async () => {
  const a=f.candidate('返回字段核验')
  const eventId=(f.db.$client.prepare('select e.id from record_event e join record r on r.id=e.record_id where r.enterprise_id=?').get(a.enterprise.id) as {id:number}).id
  linkRecognized(a.enterprise.id,eventId,{rddqrq:String(year+2),whpcyear:String(year-1),whpc:'2'})
  let result=await query({})
  expect(result.body).toMatchObject({total:1,rows:[{enterpriseId:a.enterprise.id,matchedValidYears:[],matchedMaintenance:[]}]})
  expect(result.body.options).toMatchObject({validYears:[],maintenanceYears:[]})
  expect((await mcp({validYear:year+2,maintenanceYear:year-1})).total).toBe(0)
  linkRecognized(a.enterprise.id,eventId,{},'recognized_corrob',{rddqrq:'not-a-date',whpcyear:String(year-1),whpc:`${year-2}-2`})
  result=await query({})
  expect(result.body.rows[0]).toMatchObject({matchedValidYears:[],matchedMaintenance:[]})
  expect((await query({maintenanceYear:String(year-1)})).body.total).toBe(0)
})

it('keeps datetime validity unknown without removing unfiltered eligibility', async () => {
  const a=f.candidate('返回日期时间格式')
  const eventId=(f.db.$client.prepare('select e.id from record_event e join record r on r.id=e.record_id where r.enterprise_id=?').get(a.enterprise.id) as {id:number}).id
  linkRecognized(a.enterprise.id,eventId,{},'recognized_corrob',{rddqrq:`${year+2}-11-21 11:41:36`,whpcyear:'',whpc:''})
  const result=await query({validYear:String(year+2)})
  expect(result.body).toMatchObject({total:0,rows:[]})
  expect((await query({})).body).toMatchObject({total:1,rows:[{enterpriseId:a.enterprise.id,matchedValidYears:[],matchedMaintenance:[]}]})
  expect(result.body.options).toMatchObject({validYears:[],maintenanceYears:[]})
  expect((await mcp({validYear:year+2})).total).toBe(0)
  expect((await query({validYear:String(year+3)})).body.total).toBe(0)
})

it('uses the restored award time and excludes terminated grant links from current filters', async () => {
  const a=f.candidate('同源年再次认定',[
    {eventType:'award',year:year-4,batchSeq:1},
    {eventType:'review',year:year-4,batchSeq:1,decidedYear:year-3,reviewOutcome:'failed'},
    {eventType:'award',year:year-4,decidedYear:year-1,batchSeq:1},
  ])
  const awards=f.db.$client.prepare('select e.id,e.decided_year as decidedYear from record_event e join record r on r.id=e.record_id where r.enterprise_id=? and e.event_type=? order by e.id').all(a.enterprise.id,'award') as {id:number;decidedYear:number|null}[]
  linkRecognized(a.enterprise.id,awards[0]!.id,{},'recognized_corrob',{rddqrq:`${year+2}-11-20`,whpc:`${year-2}-2`})
  linkRecognized(a.enterprise.id,awards[1]!.id,{},'recognized_corrob',{rddqrq:`${year+3}-11-20`,whpc:`${year-1}-3`})
  const restored=await query({recognitionFrom:`${year-1}-01-01`,recognitionTo:`${year-1}-12-31`,validYear:String(year+3),maintenanceYear:String(year-1)})
  expect(restored.body).toMatchObject({total:1,rows:[{enterpriseId:a.enterprise.id,recognition:{precision:'year',year:year-1},matchedValidYears:[year+3]}]})
  expect(restored.body.rows[0].qualificationWitnesses.map((w:any)=>w.awardEventId)).toEqual([awards[1]!.id])
  expect((await mcp({recognitionFrom:`${year-1}-01-01`,recognitionTo:`${year-1}-12-31`,validYear:year+3,maintenanceYear:year-1})).total).toBe(1)
  expect((await query({validYear:String(year+2)})).body.total).toBe(0)
  expect((await query({recognitionFrom:`${year-4}-01-01`,recognitionTo:`${year-4}-12-31`})).body.total).toBe(0)
})

it('accepts confirmed row-position title in a multi-title archive and intersects facts in that same row', async () => {
  const a=f.candidate('多称号归档位置')
  const eventId=(f.db.$client.prepare('select e.id from record_event e join record r on r.id=e.record_id where r.enterprise_id=?').get(a.enterprise.id) as {id:number}).id
  linkRecognized(a.enterprise.id,eventId,{},'recognized_corrob',{rddqrq:`${year+2}-11-20`,whpc:`${year-1}-2`},true)
  const filters={validYear:String(year+2),maintenanceYear:String(year-1)}
  expect((await query(filters)).body).toMatchObject({total:1,rows:[{enterpriseId:a.enterprise.id}]})
  expect((await mcp({validYear:year+2,maintenanceYear:year-1})).total).toBe(1)
})

it('keeps conflicting returned valid years unknown for one grant instead of choosing a source', async () => {
  const a=f.candidate('同授予矛盾返回')
  const eventId=(f.db.$client.prepare('select e.id from record_event e join record r on r.id=e.record_id where r.enterprise_id=?').get(a.enterprise.id) as {id:number}).id
  linkRecognized(a.enterprise.id,eventId,{},'recognized_corrob',{rddqrq:`${year+2}-11-20`})
  linkRecognized(a.enterprise.id,eventId,{},'recognized_corrob',{rddqrq:`${year+3}-11-20`})
  const result=await query({})
  expect(result.body).toMatchObject({total:1,options:{validYears:[]},rows:[{enterpriseId:a.enterprise.id,matchedValidYears:[]}]})
  expect((await query({validYear:String(year+2)})).body.total).toBe(0)
  expect((await mcp({validYear:year+3})).total).toBe(0)
})

it('keeps unknown-batch grant alternatives separate under combined filters', async () => {
  const a=f.candidate('未定批次双授予',[
    {eventType:'award',year:year-1,batchSeq:1},
    {eventType:'award',year:year-1,batchSeq:null},
  ])
  const awards=f.db.$client.prepare('select e.id from record_event e join record r on r.id=e.record_id where r.enterprise_id=? and e.event_type=? order by e.id').all(a.enterprise.id,'award') as {id:number}[]
  linkRecognized(a.enterprise.id,awards[0]!.id,{},'recognized_corrob',{rddqrq:`${year+2}-11-20`})
  linkRecognized(a.enterprise.id,awards[1]!.id,{},'recognized_corrob',{whpc:`${year-1}-3`})
  expect((await query({})).body).toMatchObject({total:1,rows:[{enterpriseId:a.enterprise.id}]})
  expect((await query({validYear:String(year+2)})).body.total).toBe(1)
  expect((await query({maintenanceYear:String(year-1)})).body.total).toBe(1)
  expect((await query({validYear:String(year+2),maintenanceYear:String(year-1)})).body.total).toBe(0)
  expect((await mcp({validYear:year+2,maintenanceYear:year-1})).total).toBe(0)
})

it('projects the selected qualifying source in filtered results', async () => {
  const a=f.candidate('同源年两批认定',[
    {eventType:'award',year:year-2,batchSeq:1},
    {eventType:'award',year:year-2,decidedYear:year-1,batchSeq:2},
  ])
  const awards=f.db.$client.prepare('select e.id from record_event e join record r on r.id=e.record_id where r.enterprise_id=? and e.event_type=? order by e.id').all(a.enterprise.id,'award') as {id:number}[]
  linkRecognized(a.enterprise.id,awards[0]!.id,{},'recognized_corrob',{rddqrq:`${year+1}-11-20`,whpc:`${year-2}-1`})
  linkRecognized(a.enterprise.id,awards[1]!.id,{},'recognized_corrob',{rddqrq:`${year+2}-11-20`,whpc:`${year-1}-2`})
  const result=await query({recognitionFrom:`${year-1}-01-01`,recognitionTo:`${year-1}-12-31`,validYear:String(year+2),maintenanceYear:String(year-1)})
  expect(result.body).toMatchObject({total:1,rows:[{enterpriseId:a.enterprise.id,recognition:{precision:'year',year:year-1},matchedValidYears:[year+2],matchedMaintenance:[{year:year-1,batch:null}]}]})
  expect(result.body.rows[0].qualificationWitnesses.map((w:any)=>w.awardEventId)).toEqual([awards[1]!.id])
})

it('retains eligible rows with missing metadata until a related filter is requested and pages the complete definite set', async () => {
  const a=f.candidate('甲缺信息')
  const b=f.candidate('乙缺信息')
  f.candidate('丙缺信息')
  const unfiltered=await query({page:'2',pageSize:'1'})
  expect(unfiltered.body).toMatchObject({total:3,page:2,pageSize:1,rows:[{enterpriseId:b.enterprise.id}],options:{recognitionYears:[year],validYears:[],maintenanceYears:[]}})
  expect((await query({validYear:String(year+2)})).body).toMatchObject({total:0,uncertainTotal:0,rows:[]})
  expect((await query({recognitionFrom:`${year}-02-01`,recognitionTo:`${year}-12-31`})).body).toMatchObject({total:0,uncertainTotal:3,rows:[]})
  expect(a.enterprise.id).toBeLessThan(b.enterprise.id)
})

it('keeps a confirmed migrant without a formal award unrecognized without fabricating recognition from its validity interval', async () => {
  const candidate=f.candidate('迁入仅有有效区间',[])
  const native = submitNativePlatformQuery(f.db,{interface:'business_list',queryKey:candidate.enterprise.usccNorm!,rdjb:'1',titleCode:'innovative_sme',queriedAt:new Date().toISOString(),status:'success',rawResponse:'Synthetic assigned process',relations:[{enterpriseId:candidate.enterprise.id,sequenceNo:1,usccRaw:candidate.enterprise.usccNorm,nameRaw:candidate.enterprise.name,verificationStatus:'confirmed',matchBasis:'uscc'}]})
  const source = {id:native.queryId}, relation={id:native.relationIds[0]!}
  const scope={enterpriseId:candidate.enterprise.id,titleCode:'innovative_sme',direction:'extra_in_miit'}
  const api=async (body:unknown) => {
    const response=await fetch(f.url('/api/roster/decision-lifecycle/commands'),{method:'POST',headers:f.headers,body:JSON.stringify(body)})
    return {status:response.status,body:await response.json() as any}
  }
  const command=await api({...scope,action:'replace',expectedCurrentId:null,idempotencyKey:'filter155-migrant',actor:{type:'agent',id:'synthetic-155'},basis:'Synthetic independent external qualification and publication check',ruleVersion:'synthetic-155',effectiveAt:`${year-1}-01-01T00:00:00Z`,decision:{status:'confirmed_reason',reasonCode:'moved_in',measureCode:'record_moved_in',verificationStatus:'confirmed',evidenceQueryId:source.id,evidenceRelationId:relation.id,currentQualification:{titleCode:'innovative_sme',validFrom:`${year-1}-01-01T00:00:00Z`,validUntil:`${year+2}-01-01T00:00:00Z`,basis:'Synthetic confirmed external qualification',publicationCheck:{status:'not_found',scope:'All ingested Ningbo innovative announcements'}}}})
  expect(command.status,JSON.stringify(command.body)).toBe(200)
  const token=readEvidenceToken113(f.db,scope as any)
  const review=await api({...scope,action:'maintain',expectedCurrentId:command.body.versionId,idempotencyKey:'filter155-migrant-review',actor:{type:'agent',id:'synthetic-155'},basis:'Synthetic explicit review',ruleVersion:'synthetic-155',effectiveAt:`${year-1}-01-01T00:00:00Z`,reviewedEvidence:{latestRevisionId:token.latestRevisionId,projectionReady:true}})
  expect(review.status,JSON.stringify(review.body)).toBe(200)
  const unfiltered=await query({})
  expect(unfiltered.body).toMatchObject({total:0,rows:[],publishedPending:{rows:[],total:0}})
  const unrecognized=await query({status:'unrecognized'})
  expect(unrecognized.body).toMatchObject({total:1,rows:[{enterpriseId:candidate.enterprise.id,recognition:null,matchedValidYears:[],qualificationWitnesses:[],qualificationAssessment:{titles:[{titleCode:'little_giant',effectiveQualification:{status:'unrecognized'}},{titleCode:'specialized_sme',effectiveQualification:{status:'unrecognized'}},{titleCode:'innovative_sme',effectiveQualification:{status:'unrecognized'}}]}}]})
  const dated=await query({recognitionFrom:`${year}-01-01`,recognitionTo:`${year}-12-31`})
  expect(dated.body).toMatchObject({total:0,uncertainTotal:0,rows:[]})
  expect((await query({status:'unrecognized',recognitionFrom:`${year}-01-01`,recognitionTo:`${year}-12-31`})).body).toMatchObject({total:0,uncertainTotal:1,rows:[]})
})

it('rejects invalid dates and a maintenance batch without its year', async () => {
  expect((await query({ recognitionFrom: '2024-02-30', recognitionTo: '2024-12-31' })).response.status).toBe(400)
  expect((await query({ recognitionFrom: '2024-12-31', recognitionTo: '2024-01-01' })).response.status).toBe(400)
  expect((await query({ maintenanceBatch: '2' })).response.status).toBe(400)
  expect((await query({ recognitionFrom: '2024-01-01' })).response.status).toBe(400)
  expect((await query({ validYear: '2024-01-01' })).response.status).toBe(400)
  expect((await query({ maintenanceYear: '2024', maintenanceBatch: '16' })).response.status).toBe(400)
  const leap = await query({ recognitionFrom: '2024-02-29', recognitionTo: '2024-02-29' })
  expect(leap.response.status).toBe(200)
  expect((await query({ recognitionFrom: '2025-02-29', recognitionTo: '2025-03-01' })).response.status).toBe(400)
})

it('rejects invalid new filters at original MCP JSON-RPC transport', async () => {
  for (const arguments_ of [{maintenanceBatch:2},{recognitionFrom:'2024-01-01'},{validYear:2024,unknownFilter:'ignored'}]) {
    const response=await fetch(f.url('/mcp'),{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream','mcp-protocol-version':'2025-06-18'},body:JSON.stringify({jsonrpc:'2.0',id:155,method:'tools/call',params:{name:'list_current_qualified_enterprises',arguments:{titleCode:'innovative_sme',...arguments_}}})})
    expect(response.status).toBe(400)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toMatchObject({jsonrpc:'2.0',id:155,error:{code:-32602}})
  }
})

it.each(['HTTP', 'MCP'] as const)('preserves partial sources and year conflicts without filling facts over %s', async transport => {
  const candidate = f.candidate('年份部分见证')
  const eventId = (f.db.$client.prepare('select id from record_event where record_id=?').get(candidate.record.id) as {id:number}).id
  const first = linkRecognized(candidate.enterprise.id,eventId,{},'recognized_corrob',{rddqrq:'2028-11-20'})
  const second = linkRecognized(candidate.enterprise.id,eventId,{},'recognized_corrob',{whpc:'2023-2'})
  const read = async (filters: Record<string,number> = {}) => transport === 'MCP' ? mcp(filters)
    : (await query(Object.fromEntries(Object.entries(filters).map(([key,value]) => [key,String(value)])))).body
  const all = await read()
  expect(all).toMatchObject({total:1,options:{validYears:[2028],maintenanceYears:[2023],maintenanceBatchesByYear:{}},rows:[{enterpriseId:candidate.enterprise.id,group:'eligible'}]})
  expect(all.rows[0].qualificationWitnesses).toEqual([
    expect.objectContaining({conditionQueryId:first.queryId,correspondenceId:expect.any(Number),matchedValidYear:2028,matchedMaintenance:null}),
    expect.objectContaining({conditionQueryId:second.queryId,correspondenceId:expect.any(Number),matchedValidYear:null,matchedMaintenance:{year:2023,batch:null}}),
  ])
  expect((await read({maintenanceYear:2023})).total).toBe(1)
  expect((await read({validYear:2028})).total).toBe(1)
  expect(await read({validYear:2028,maintenanceYear:2023})).toMatchObject({total:0,rows:[]})
  expect(await read({maintenanceYear:2023,maintenanceBatch:2})).toMatchObject({total:0,rows:[]})
  linkRecognized(candidate.enterprise.id,eventId,{},'recognized_corrob',{whpc:'2024-3'})
  const conflict = await read()
  expect(conflict).toMatchObject({total:1,options:{validYears:[2028],maintenanceYears:[],maintenanceBatchesByYear:{}}})
  expect(conflict.rows[0].qualificationWitnesses).toHaveLength(3)
  expect(conflict.rows[0].qualificationWitnesses.every((w:any) => w.matchedMaintenance === null)).toBe(true)
  expect((await read({validYear:2028})).rows[0].references).toEqual(conflict.rows[0].references)
  expect((await read({maintenanceYear:2023})).total).toBe(0)
})

it.each(['HTTP', 'MCP'] as const)('rejects unsupported returned representations and titles over %s', async transport => {
  const read = async (titleCode: string, filters: Record<string,number> = {}) => transport === 'MCP' ? mcp({titleCode,...filters})
    : (await query({titleCode,...Object.fromEntries(Object.entries(filters).map(([key,value]) => [key,String(value)]))})).body
  for (const [index, raw] of [
    {rddqrq:'2028-11-20 11:41:36',whpcyear:'2023',whpc:'2'},
    {rddqrq:'2028',whpc:'2'},
    {rddqrq:'2028-02-30',whpc:'2023/2'},
    {rddqrq:'2028-11-20T00:00:00Z',whpcyear:'2023',whpc:'2023-2'},
  ].entries()) {
    const a = f.candidate('未知格式'+index)
    const eventId = (f.db.$client.prepare('select id from record_event where record_id=?').get(a.record.id) as {id:number}).id
    linkRecognized(a.enterprise.id,eventId,{rddqrq:'2028',whpcyear:'2023',whpc:'2'},'recognized_corrob',raw)
  }
  expect(await read('innovative_sme')).toMatchObject({total:4,options:{validYears:[],maintenanceYears:[],maintenanceBatchesByYear:{}}})
  expect(await read('innovative_sme',{validYear:2028})).toMatchObject({total:0,rows:[]})
  expect(await read('innovative_sme',{maintenanceYear:2023})).toMatchObject({total:0,rows:[]})
  for (const title of ['specialized_sme','little_giant']) {
    const a = f.candidate(title,undefined,title)
    const eventId = (f.db.$client.prepare('select id from record_event where record_id=?').get(a.record.id) as {id:number}).id
    linkRecognized(a.enterprise.id,eventId,{},'recognized_corrob',{rddqrq:'2028-11-20',whpc:'2023-2'})
    expect(await read(title)).toMatchObject({total:1,options:{validYears:[],maintenanceYears:[],maintenanceBatchesByYear:{}}})
    expect(await read(title,{validYear:2028})).toMatchObject({total:0,rows:[]})
    expect(await read(title,{maintenanceYear:2023})).toMatchObject({total:0,rows:[]})
  }
})

it.each(['HTTP', 'MCP'] as const)('uses observed composite year without confirming its suffix or predicate batch over %s', async transport => {
  const a = f.candidate('已观察年份')
  const eventId = (f.db.$client.prepare('select id from record_event where record_id=?').get(a.record.id) as {id:number}).id
  linkRecognized(a.enterprise.id,eventId,{rddqrq:'2028',whpcyear:'2023',whpc:'2'},'recognized_corrob',{rddqrq:'2028-11-20',whpcyear:'',whpc:'2023-2'})
  const read = async (filters: Record<string,number> = {}) => transport === 'MCP' ? mcp(filters)
    : (await query(Object.fromEntries(Object.entries(filters).map(([key,value]) => [key,String(value)])))).body
  expect(await read({validYear:2028,maintenanceYear:2023})).toMatchObject({total:1,rows:[{matchedValidYears:[2028],matchedMaintenance:[{year:2023,batch:null}]}],options:{maintenanceBatchesByYear:{}}})
  expect(await read({maintenanceYear:2023,maintenanceBatch:2})).toMatchObject({total:0,rows:[]})
})

it.each(['HTTP', 'MCP'] as const)('uses predicates only for consistency and ignores partial archives over %s', async transport => {
  const a = f.candidate('条件不替代事实')
  const eventId = (f.db.$client.prepare('select id from record_event where record_id=?').get(a.record.id) as {id:number}).id
  const mismatch = linkRecognized(a.enterprise.id,eventId,{rddqrq:'2029',whpcyear:'2024'},'recognized_corrob',{rddqrq:'2028-11-20',whpc:'2023-2'})
  linkRecognized(a.enterprise.id,eventId,{},'recognized_corrob',{rddqrq:'2028-11-20',whpc:'2023-2'},false,true)
  const read = async (filters: Record<string,number> = {}) => transport === 'MCP' ? mcp(filters)
    : (await query(Object.fromEntries(Object.entries(filters).map(([key,value]) => [key,String(value)])))).body
  const all = await read()
  expect(all).toMatchObject({total:1,options:{validYears:[],maintenanceYears:[],maintenanceBatchesByYear:{}},rows:[{group:'eligible',matchedValidYears:[],matchedMaintenance:[]}]})
  expect(all.rows[0].qualificationWitnesses).toEqual([expect.objectContaining({conditionQueryId:mismatch.queryId,matchedValidYear:null,matchedMaintenance:null})])
  expect(all.rows[0].references.length).toBeGreaterThan(0)
  const rejected: Record<string,number>[] = [{validYear:2028},{validYear:2029},{maintenanceYear:2023},{maintenanceYear:2024}]
  for (const filters of rejected)
    expect(await read(filters)).toMatchObject({total:0,rows:[]})
})

it.each(['HTTP', 'MCP'] as const)('keeps independently supported validity when maintenance representation is unknown over %s', async transport => {
  const a = f.candidate('独立有效年')
  const eventId = (f.db.$client.prepare('select id from record_event where record_id=?').get(a.record.id) as {id:number}).id
  linkRecognized(a.enterprise.id,eventId,{},'recognized_corrob',{rddqrq:'2028-02-29',whpcyear:'2023',whpc:'2023-2'})
  const read = async (filters: Record<string,number> = {}) => transport === 'MCP' ? mcp(filters)
    : (await query(Object.fromEntries(Object.entries(filters).map(([key,value]) => [key,String(value)])))).body
  expect(await read({validYear:2028})).toMatchObject({total:1,rows:[{matchedValidYears:[2028],matchedMaintenance:[]}],options:{validYears:[2028],maintenanceYears:[],maintenanceBatchesByYear:{}}})
  expect(await read({validYear:2028,maintenanceYear:2023})).toMatchObject({total:0,rows:[]})
})

it.each(['HTTP', 'MCP'] as const)('does not use a different original row title as qualification evidence over %s', async transport => {
  const a=f.candidate('来源称号边界')
  const eventId=(f.db.$client.prepare('select id from record_event where record_id=?').get(a.record.id) as {id:number}).id
  submitSyntheticRecognizedCollection(f.db,{rdjb:'2',queriedAt:'2026-05-01T00:00:00Z',rows:[{enterpriseId:a.enterprise.id,raw:{id:'OTHER-TITLE',qymc:a.enterprise.name,tyshxydm:a.enterprise.usccNorm,rdjb:'2',rddqrq:'2028-11-20',whpc:'2023-2'}}]})
  const read=async(filters:Record<string,number>={})=>transport==='MCP'?mcp(filters):(await query(Object.fromEntries(Object.entries(filters).map(([key,value])=>[key,String(value)])))).body
  expect(await read()).toMatchObject({total:1,rows:[{matchedValidYears:[],matchedMaintenance:[]}],options:{validYears:[],maintenanceYears:[]}})
  expect(await read({validYear:2028})).toMatchObject({total:0,rows:[]})
  expect(await read({maintenanceYear:2023})).toMatchObject({total:0,rows:[]})
})
