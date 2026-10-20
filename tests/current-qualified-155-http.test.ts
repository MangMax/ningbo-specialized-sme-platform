import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest'
import { schema as s } from '../db/client'
import { commitRecordCorrespondences, preflightRecordCorrespondences } from '../server/utils/record-correspondence'
import { readEvidenceToken113 } from '../server/utils/evidence-impact-113'
import { currentExport118Fixture, year } from './helpers/current-export-118'

const f = currentExport118Fixture()
let linkOffset = 0
beforeAll(f.start, 90000)
beforeEach(f.resetBusiness)
afterAll(f.close)

async function query(params: Record<string, string>) {
  const response = await fetch(f.url('/api/roster/current-enterprises?' + new URLSearchParams({ titleCode: 'specialized_sme', ...params })))
  return { response, body: await response.json() as any }
}

async function mcp(args: Record<string, unknown>) {
  const response = await fetch(f.url('/mcp'), { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' }, body: JSON.stringify({ jsonrpc: '2.0', id: 155, method: 'tools/call', params: { name: 'list_current_qualified_enterprises', arguments: { titleCode: 'specialized_sme', ...args } } }) })
  expect(response.status).toBe(200)
  const raw = await response.text()
  const payload = JSON.parse(raw.startsWith('event:') ? raw.split('\n').find(line => line.startsWith('data: '))!.slice(6) : raw)
  return JSON.parse(payload.result.content[0].text)
}

function linkRecognized(enterpriseId: number, eventId: number, conditions: Record<string, string>, role: 'recognized_corrob' | 'current_context' = 'recognized_corrob') {
  const enterprise = f.db.select().from(s.enterprise).all().find(row => row.id === enterpriseId)!
  const stamp = new Date(Date.now() + ++linkOffset * 1000).toISOString()
  const query = f.db.insert(s.platformQuery).values({ interface: 'recognized_list', queryKey: enterprise.usccNorm!, rdjb: '2', titleCode: 'specialized_sme', queriedAt: stamp, status: 'success', collectionEvidence: {
    source: 'queryBusList', status: 'success', effectiveConditions: { combination: 'and', ...conditions }, titleScope: { mode: 'selected', rdjb: ['2'] }, queriedAt: stamp, completedAt: stamp, rows: [], pages: [], fetchedCount: 1, declaredTotal: 1, completeness: 'complete', fullRange: true, unfinished: [], error: null, limits: { maxRequests: 1, maxRows: 50, maxDurationMs: 1000, pageSize: 50 },
  } as any }).returning().get()
  const relation = f.db.insert(s.platformRelation).values({ queryId: query.id, sequenceNo: 1, enterpriseId, usccRaw: enterprise.usccNorm, nameRaw: enterprise.name, verificationStatus: 'confirmed', matchBasis: 'uscc' }).returning().get()
  const request = { idempotencyKey: `filter-155-${relation.id}`, sourceIdentity: `synthetic/filter-155/${relation.id}`, actor: { type: 'agent' as const, id: 'test' }, basis: 'synthetic confirmed event and recognized row', ruleId: 'manual', ruleVersion: '1', operations: [{ action: 'create' as const, status: 'confirmed' as const, edge: { type: 'event_recognized' as const, eventId, relationId: relation.id, role } }] }
  const plan = preflightRecordCorrespondences(f.db, request)
  commitRecordCorrespondences(f.db, request, plan.planHash)
  return relation
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
  const matchedRelation=linkRecognized(current.enterprise.id, eventFor(current.enterprise.id, year), { rddqrq: String(year + 2), whpcyear: String(year - 1), whpc: '2' })
  linkRecognized(old.enterprise.id, eventFor(old.enterprise.id, year - 4), { rddqrq: String(year + 2), whpcyear: String(year - 1), whpc: '2' })
  const params = { validYear: String(year + 2), maintenanceYear: String(year - 1), maintenanceBatch: '2' }
  const result = await query(params)
  expect(result.response.status).toBe(200)
  expect(result.body).toMatchObject({ total: 1, rows: [{ enterpriseId: current.enterprise.id }] })
  expect(result.body.rows[0]).toMatchObject({matchedValidYears:[year+2],matchedMaintenance:[{year:year-1,batch:2}],qualificationWitnesses:[{matchedValidYear:year+2,matchedMaintenance:{year:year-1,batch:2},conditionQueryId:matchedRelation.queryId}]})
  expect(result.body.rows[0]).not.toHaveProperty('validYears')
  expect((await mcp({ validYear: year + 2, maintenanceYear: year - 1, maintenanceBatch: 2 })).rows).toEqual(result.body.rows)
  expect(result.body.options).toMatchObject({ validYears: [year + 2], maintenanceYears: [year - 1] })
  expect((await query({ validYear: String(year + 3) })).body.total).toBe(0) // lifecycle dueYear is not source validYear
})

it('does not combine valid year and maintenance batch from different recognized rows or context-only links', async () => {
  const a = f.candidate('同周期不同来源')
  const eventId = (f.db.$client.prepare('select e.id from record_event e join record r on r.id=e.record_id where r.enterprise_id=?').get(a.enterprise.id) as {id:number}).id
  linkRecognized(a.enterprise.id,eventId,{rddqrq:String(year+2)})
  linkRecognized(a.enterprise.id,eventId,{whpcyear:String(year-1),whpc:'3'})
  linkRecognized(a.enterprise.id,eventId,{rddqrq:String(year+3),whpcyear:String(year-1),whpc:'3'},'current_context')
  const valid = await query({ validYear:String(year+2) })
  expect(valid.body.total).toBe(1)
  expect((await query({ maintenanceYear:String(year-1),maintenanceBatch:'3' })).body.total).toBe(1)
  expect((await query({ validYear:String(year+2),maintenanceYear:String(year-1),maintenanceBatch:'3' })).body).toMatchObject({total:0,rows:[]})
  expect((await query({ validYear:String(year+3) })).body.total).toBe(0)
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

it('retains a confirmed migrant with no asserted award year without fabricating recognition from its validity interval', async () => {
  const candidate=f.candidate('迁入仅有有效区间',[])
  const source=f.db.insert(s.platformQuery).values({interface:'business_list',queryKey:candidate.enterprise.usccNorm!,rdjb:'2',titleCode:'specialized_sme',queriedAt:new Date().toISOString(),status:'success'}).returning().get()
  const relation=f.db.insert(s.platformRelation).values({queryId:source.id,enterpriseId:candidate.enterprise.id,sequenceNo:1,usccRaw:candidate.enterprise.usccNorm,nameRaw:candidate.enterprise.name,verificationStatus:'confirmed',matchBasis:'uscc'}).returning().get()
  const scope={enterpriseId:candidate.enterprise.id,titleCode:'specialized_sme',direction:'extra_in_miit'}
  const api=async (body:unknown) => {
    const response=await fetch(f.url('/api/roster/decision-lifecycle/commands'),{method:'POST',headers:f.headers,body:JSON.stringify(body)})
    return {status:response.status,body:await response.json() as any}
  }
  const command=await api({...scope,action:'replace',expectedCurrentId:null,idempotencyKey:'filter155-migrant',actor:{type:'agent',id:'synthetic-155'},basis:'Synthetic independent external qualification and publication check',ruleVersion:'synthetic-155',effectiveAt:`${year-1}-01-01T00:00:00Z`,decision:{status:'confirmed_reason',reasonCode:'moved_in',measureCode:'record_moved_in',verificationStatus:'confirmed',evidenceQueryId:source.id,evidenceRelationId:relation.id,currentQualification:{titleCode:'specialized_sme',validFrom:`${year-1}-01-01T00:00:00Z`,validUntil:`${year+2}-01-01T00:00:00Z`,basis:'Synthetic confirmed external qualification',publicationCheck:{status:'not_found',scope:'All ingested Ningbo specialized announcements'}}}})
  expect(command.status,JSON.stringify(command.body)).toBe(200)
  const token=readEvidenceToken113(f.db,scope as any)
  const review=await api({...scope,action:'maintain',expectedCurrentId:command.body.versionId,idempotencyKey:'filter155-migrant-review',actor:{type:'agent',id:'synthetic-155'},basis:'Synthetic explicit review',ruleVersion:'synthetic-155',effectiveAt:`${year-1}-01-01T00:00:00Z`,reviewedEvidence:{latestRevisionId:token.latestRevisionId,projectionReady:true}})
  expect(review.status,JSON.stringify(review.body)).toBe(200)
  const unfiltered=await query({})
  expect(unfiltered.body).toMatchObject({total:1,rows:[{enterpriseId:candidate.enterprise.id,recognition:null,matchedValidYears:[],qualificationWitnesses:[]}]})
  const dated=await query({recognitionFrom:`${year}-01-01`,recognitionTo:`${year}-12-31`})
  expect(dated.body).toMatchObject({total:0,uncertainTotal:1,rows:[]})
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
    const response=await fetch(f.url('/mcp'),{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream','mcp-protocol-version':'2025-06-18'},body:JSON.stringify({jsonrpc:'2.0',id:155,method:'tools/call',params:{name:'list_current_qualified_enterprises',arguments:{titleCode:'specialized_sme',...arguments_}}})})
    expect(response.status).toBe(400)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toMatchObject({jsonrpc:'2.0',id:155,error:{code:-32602}})
  }
})
