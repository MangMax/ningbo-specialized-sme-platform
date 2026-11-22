import { and, asc, desc, eq, sql } from 'drizzle-orm'
import { Pool } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { seedRetiredEvidenceState } from '../fixtures/retired-evidence-state'
import { normalizeUscc } from '../../../layers/sme-roster/lib/domain'
import { enterprise } from '../../../db/postgresql/enterprise-tables'
import { record, recordEvent, recordEvidence } from '../../../db/postgresql/ledger-tables'
import { nativeAppAdapter } from '../../support/native-app'
import { syntheticRecognizedQuery } from '../fixtures/recognized-source'
import { seedPostgresPlatformQuery } from '../../platform/fixtures/postgres-query'
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest'
import { assertQualificationRowsSnapshotEqual } from '../fixtures/qualification-matrix'
import { commitPostgresCorrespondences, preflightPostgresCorrespondences } from '../../../layers/sme-roster/server/utils/record-correspondence-write-postgres'
import { fresh, year, type Event } from '../current-export/fixtures/specialized-export'

const dir = mkdtempSync(join(tmpdir(), 'recognition-date-range-'))
const f = nativeAppAdapter({ dir, token: 'synthetic-recognition-date-range' })
let pool: Pool | undefined
let db: ReturnType<typeof drizzle<Record<string, never>>>
let linkOffset = 0
beforeAll(async () => {
  await f.start()
  pool = new Pool({ connectionString: f.postgresUrl, options: '-c search_path=business,public' })
  db = drizzle({ client: pool })
}, 45_000)
beforeEach(async () => {
  await db.execute(sql`
    TRUNCATE enterprise, record_event, record_evidence, platform_collection, platform_archive_value,
      platform_business_record, import_batch,
      record_correspondence, record_correspondence_audit, difference_reason,
      evidence_review_receipt_114 RESTART IDENTITY CASCADE
  `)
})
afterAll(async () => {
  await pool?.end()
  await f.close()
  rmSync(dir, { recursive: true, force: true })
})

async function candidate(name: string, events: Event[] = fresh, title = 'innovative_sme') {
  return db.transaction(async tx => {
    const [subject] = await tx.insert(enterprise).values({
      name, nameNorm: name, usccNorm: normalizeUscc('SYNTHETIC-118-' + name), district: '鄞州区', city: '宁波市',
    }).returning()
    const [entry] = await tx.insert(record).values({ enterpriseId: subject!.id, source: 'jxj', titleCode: title, nameRaw: name }).returning()
    for (const item of events) {
      const [saved] = await tx.insert(recordEvent).values({ recordId: entry!.id, ...item }).returning()
      await tx.insert(recordEvidence).values({
        recordEventId: saved!.id, sourceFile: 'jxj/announcement/synthetic-118.xlsx', attachment: '专精特新中小企业名单', listNo: subject!.id,
      })
    }
    return { enterprise: subject!, record: entry! }
  })
}

async function eventForRecord(recordId: number) {
  const rows = await db.select({ id: recordEvent.id }).from(recordEvent)
    .where(eq(recordEvent.recordId, recordId)).orderBy(asc(recordEvent.id)).limit(1)
  return rows[0]!.id
}

async function eventsForEnterprise(id: number, awardsOnly = false) {
  return db.select({ id: recordEvent.id, decidedYear: recordEvent.decidedYear }).from(recordEvent)
    .innerJoin(record, eq(record.id, recordEvent.recordId)).where(and(
      eq(record.enterpriseId, id), awardsOnly ? eq(recordEvent.eventType, 'award') : undefined,
    )).orderBy(asc(recordEvent.id))
}

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

async function linkRecognized(enterpriseId: number, eventId: number, conditions: Record<string, string>, role: 'recognized_corrob' | 'current_context' = 'recognized_corrob', rawFields: Record<string, unknown> = {}, multiTitle = false, partial = false) {
  const [subject] = await db.select().from(enterprise).where(eq(enterprise.id, enterpriseId))
  const [entry] = await db.select({ title: record.titleCode }).from(recordEvent)
    .innerJoin(record, eq(record.id, recordEvent.recordId)).where(eq(recordEvent.id, eventId))
  const title = entry!.title
  const rdjb = {innovative_sme:'1',specialized_sme:'2',little_giant:'3'}[title]!
  const stamp = new Date(Date.now() + ++linkOffset * 1000).toISOString()
  rawFields = { id: `synthetic-filter155-${linkOffset}`, qymc: subject!.name, tyshxydm: subject!.usccNorm, rdjb, ...rawFields }
  const native = await seedPostgresPlatformQuery(db, syntheticRecognizedQuery({ rdjb: multiTitle ? '1,2,3' : rdjb, queriedAt: stamp, conditions, partial, rows: [{ raw: rawFields, enterpriseId }] }))
  const relation = { id: native.relationIds[0]! }
  const request = { idempotencyKey: `filter-155-${relation.id}`, sourceIdentity: `synthetic/filter-155/${relation.id}`, actor: { type: 'agent' as const, id: 'test' }, basis: 'synthetic confirmed event and recognized row', ruleId: 'manual', ruleVersion: '1', operations: [{ action: 'create' as const, status: 'confirmed' as const, edge: { type: 'event_recognized' as const, eventId, relationId: relation.id, role } }] }
  const plan = await preflightPostgresCorrespondences(db, request)
  await commitPostgresCorrespondences(db, request, plan.planHash)
  return {...relation,queryId:native.queryId}
}

it('filters a formal current award by full-year contained recognition range and reports partial overlap separately', async () => {
  const a = await candidate('本期甲', [{ eventType: 'award', year: year - 2, batchSeq: 1 }, { eventType: 'review', year: year - 2, batchSeq: 1, decidedYear: year, reviewOutcome: 'passed' }])
  await candidate('本期乙', [{ eventType: 'award', year: year - 1, batchSeq: 1 }])
  const full = await query({ recognitionFrom: `${year - 2}-01-01`, recognitionTo: `${year - 2}-12-31` })
  expect(full.response.status).toBe(200)
  expect(full.body).toMatchObject({ total: 1, uncertainTotal: 0, rows: [{ enterpriseId: a.enterprise.id, recognition: { precision: 'year', year: year - 2 } }] })
  const partial = await query({ recognitionFrom: `${year - 2}-02-01`, recognitionTo: `${year - 2}-12-31` })
  expect(partial.body).toMatchObject({ total: 0, uncertainTotal: 1, rows: [] })
  expect((await mcp({ recognitionFrom: `${year - 2}-02-01`, recognitionTo: `${year - 2}-12-31` })).uncertainTotal).toBe(1)
})

it('requires one current award and one confirmed recognized relation for valid and maintenance condition matches', async () => {
  const current = await candidate('当前周期', [{ eventType: 'award', year: year, batchSeq: 1 }])
  const old = await candidate('旧周期借用', [{ eventType: 'award', year: year - 4, batchSeq: 1 }, { eventType: 'award', year, batchSeq: 1 }])
  const eventFor = async (id: number, eventYear: number) => {
    const [event] = await db.select({id: recordEvent.id}).from(recordEvent)
      .innerJoin(record,eq(record.id,recordEvent.recordId))
      .where(and(eq(record.enterpriseId,id),eq(recordEvent.year,eventYear),eq(recordEvent.eventType,'award')))
      .orderBy(desc(recordEvent.id)).limit(1)
    return event!.id
  }
  const matchedRelation=await linkRecognized(current.enterprise.id, await eventFor(current.enterprise.id, year), { rddqrq: String(year + 2), whpcyear: String(year - 1), whpc: '2' }, 'recognized_corrob', {rddqrq:`${year+2}-11-20`,whpc:`${year-1}-2`})
  await linkRecognized(old.enterprise.id, await eventFor(old.enterprise.id, year - 4), { rddqrq: String(year + 2), whpcyear: String(year - 1), whpc: '2' }, 'recognized_corrob', {rddqrq:`${year+2}-11-20`,whpc:`${year-1}-2`})
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
  const a = await candidate('同周期不同来源')
  const eventId = (await eventsForEnterprise(a.enterprise.id))[0]!.id
  await linkRecognized(a.enterprise.id,eventId,{rddqrq:String(year+2)},'recognized_corrob',{rddqrq:`${year+2}-06-01`})
  await linkRecognized(a.enterprise.id,eventId,{whpcyear:String(year-1),whpc:'3'},'recognized_corrob',{whpc:`${year-1}-3`})
  await linkRecognized(a.enterprise.id,eventId,{rddqrq:String(year+3),whpcyear:String(year-1),whpc:'3'},'current_context',{rddqrq:`${year+3}-06-01`,whpc:`${year-1}-3`})
  const valid = await query({ validYear:String(year+2) })
  expect(valid.body.total).toBe(1)
  expect((await query({ maintenanceYear:String(year-1) })).body.total).toBe(1)
  expect((await query({ validYear:String(year+2),maintenanceYear:String(year-1) })).body).toMatchObject({total:0,rows:[]})
  expect((await query({ validYear:String(year+3) })).body.total).toBe(0)
})

it('uses returned structured facts and leaves condition-only, malformed, and conflicting facts unknown', async () => {
  const a=await candidate('返回字段核验')
  const eventId= (await eventsForEnterprise(a.enterprise.id))[0]!.id
  await linkRecognized(a.enterprise.id,eventId,{rddqrq:String(year+2),whpcyear:String(year-1),whpc:'2'})
  let result=await query({})
  expect(result.body).toMatchObject({total:1,rows:[{enterpriseId:a.enterprise.id,matchedValidYears:[],matchedMaintenance:[]}]})
  expect(result.body.options).toMatchObject({validYears:[],maintenanceYears:[]})
  expect((await mcp({validYear:year+2,maintenanceYear:year-1})).total).toBe(0)
  await linkRecognized(a.enterprise.id,eventId,{},'recognized_corrob',{rddqrq:'not-a-date',whpcyear:String(year-1),whpc:`${year-2}-2`})
  result=await query({})
  expect(result.body.rows[0]).toMatchObject({matchedValidYears:[],matchedMaintenance:[]})
  expect((await query({maintenanceYear:String(year-1)})).body.total).toBe(0)
})

it('keeps datetime validity unknown without removing unfiltered eligibility', async () => {
  const a=await candidate('返回日期时间格式')
  const eventId= (await eventsForEnterprise(a.enterprise.id))[0]!.id
  await linkRecognized(a.enterprise.id,eventId,{},'recognized_corrob',{rddqrq:`${year+2}-11-21 11:41:36`,whpcyear:'',whpc:''})
  const result=await query({validYear:String(year+2)})
  expect(result.body).toMatchObject({total:0,rows:[]})
  expect((await query({})).body).toMatchObject({total:1,rows:[{enterpriseId:a.enterprise.id,matchedValidYears:[],matchedMaintenance:[]}]})
  expect(result.body.options).toMatchObject({validYears:[],maintenanceYears:[]})
  expect((await mcp({validYear:year+2})).total).toBe(0)
  expect((await query({validYear:String(year+3)})).body.total).toBe(0)
})

it('uses the restored award time and excludes terminated grant links from current filters', async () => {
  const a=await candidate('同源年再次认定',[
    {eventType:'award',year:year-4,batchSeq:1},
    {eventType:'review',year:year-4,batchSeq:1,decidedYear:year-3,reviewOutcome:'failed'},
    {eventType:'award',year:year-4,decidedYear:year-1,batchSeq:1},
  ])
  const awards= await eventsForEnterprise(a.enterprise.id, true)
  await linkRecognized(a.enterprise.id,awards[0]!.id,{},'recognized_corrob',{rddqrq:`${year+2}-11-20`,whpc:`${year-2}-2`})
  await linkRecognized(a.enterprise.id,awards[1]!.id,{},'recognized_corrob',{rddqrq:`${year+3}-11-20`,whpc:`${year-1}-3`})
  const restored=await query({recognitionFrom:`${year-1}-01-01`,recognitionTo:`${year-1}-12-31`,validYear:String(year+3),maintenanceYear:String(year-1)})
  expect(restored.body).toMatchObject({total:1,rows:[{enterpriseId:a.enterprise.id,recognition:{precision:'year',year:year-1},matchedValidYears:[year+3]}]})
  expect(restored.body.rows[0].qualificationWitnesses.map((w:any)=>w.awardEventId)).toEqual([awards[1]!.id])
  expect((await mcp({recognitionFrom:`${year-1}-01-01`,recognitionTo:`${year-1}-12-31`,validYear:year+3,maintenanceYear:year-1})).total).toBe(1)
  expect((await query({validYear:String(year+2)})).body.total).toBe(0)
  expect((await query({recognitionFrom:`${year-4}-01-01`,recognitionTo:`${year-4}-12-31`})).body.total).toBe(0)
})

it('accepts confirmed row-position title in a multi-title archive and intersects facts in that same row', async () => {
  const a=await candidate('多称号归档位置')
  const eventId= (await eventsForEnterprise(a.enterprise.id))[0]!.id
  await linkRecognized(a.enterprise.id,eventId,{},'recognized_corrob',{rddqrq:`${year+2}-11-20`,whpc:`${year-1}-2`},true)
  const filters={validYear:String(year+2),maintenanceYear:String(year-1)}
  expect((await query(filters)).body).toMatchObject({total:1,rows:[{enterpriseId:a.enterprise.id}]})
  expect((await mcp({validYear:year+2,maintenanceYear:year-1})).total).toBe(1)
})

it('keeps conflicting returned valid years unknown for one grant instead of choosing a source', async () => {
  const a=await candidate('同授予矛盾返回')
  const eventId= (await eventsForEnterprise(a.enterprise.id))[0]!.id
  await linkRecognized(a.enterprise.id,eventId,{},'recognized_corrob',{rddqrq:`${year+2}-11-20`})
  await linkRecognized(a.enterprise.id,eventId,{},'recognized_corrob',{rddqrq:`${year+3}-11-20`})
  const result=await query({})
  expect(result.body).toMatchObject({total:1,options:{validYears:[]},rows:[{enterpriseId:a.enterprise.id,matchedValidYears:[]}]})
  expect((await query({validYear:String(year+2)})).body.total).toBe(0)
  expect((await mcp({validYear:year+3})).total).toBe(0)
})

it('keeps unknown-batch grant alternatives separate under combined filters', async () => {
  const a=await candidate('未定批次双授予',[
    {eventType:'award',year:year-1,batchSeq:1},
    {eventType:'award',year:year-1,batchSeq:null},
  ])
  const awards= await eventsForEnterprise(a.enterprise.id, true)
  await linkRecognized(a.enterprise.id,awards[0]!.id,{},'recognized_corrob',{rddqrq:`${year+2}-11-20`})
  await linkRecognized(a.enterprise.id,awards[1]!.id,{},'recognized_corrob',{whpc:`${year-1}-3`})
  expect((await query({})).body).toMatchObject({total:1,rows:[{enterpriseId:a.enterprise.id}]})
  expect((await query({validYear:String(year+2)})).body.total).toBe(1)
  expect((await query({maintenanceYear:String(year-1)})).body.total).toBe(1)
  expect((await query({validYear:String(year+2),maintenanceYear:String(year-1)})).body.total).toBe(0)
  expect((await mcp({validYear:year+2,maintenanceYear:year-1})).total).toBe(0)
})

it('projects the selected qualifying source in filtered results', async () => {
  const a=await candidate('同源年两批认定',[
    {eventType:'award',year:year-2,batchSeq:1},
    {eventType:'award',year:year-2,decidedYear:year-1,batchSeq:2},
  ])
  const awards= await eventsForEnterprise(a.enterprise.id, true)
  await linkRecognized(a.enterprise.id,awards[0]!.id,{},'recognized_corrob',{rddqrq:`${year+1}-11-20`,whpc:`${year-2}-1`})
  await linkRecognized(a.enterprise.id,awards[1]!.id,{},'recognized_corrob',{rddqrq:`${year+2}-11-20`,whpc:`${year-1}-2`})
  const result=await query({recognitionFrom:`${year-1}-01-01`,recognitionTo:`${year-1}-12-31`,validYear:String(year+2),maintenanceYear:String(year-1)})
  expect(result.body).toMatchObject({total:1,rows:[{enterpriseId:a.enterprise.id,recognition:{precision:'year',year:year-1},matchedValidYears:[year+2],matchedMaintenance:[{year:year-1,batch:null}]}]})
  expect(result.body.rows[0].qualificationWitnesses.map((w:any)=>w.awardEventId)).toEqual([awards[1]!.id])
})

it('retains eligible rows with missing metadata until a related filter is requested and pages the complete definite set', async () => {
  const a=await candidate('甲缺信息')
  const b=await candidate('乙缺信息')
  await candidate('丙缺信息')
  const unfiltered=await query({page:'2',pageSize:'1'})
  expect(unfiltered.body).toMatchObject({total:3,page:2,pageSize:1,rows:[{enterpriseId:b.enterprise.id}],options:{recognitionYears:[year],validYears:[],maintenanceYears:[]}})
  expect((await query({validYear:String(year+2)})).body).toMatchObject({total:0,uncertainTotal:0,rows:[]})
  expect((await query({recognitionFrom:`${year}-02-01`,recognitionTo:`${year}-12-31`})).body).toMatchObject({total:0,uncertainTotal:3,rows:[]})
  expect(a.enterprise.id).toBeLessThan(b.enterprise.id)
})

it('uses a source period without manual admission or fabricated publication recognition', async () => {
  const migrant=await candidate('迁入仅有有效区间',[])
  const code = '91310115MA1H7KUG93'
  await db.update(enterprise).set({usccNorm:code}).where(eq(enterprise.id,migrant.enterprise.id))
  const native = await seedPostgresPlatformQuery(db,{interface:'business_list',queryKey:code,rdjb:'1',titleCode:'innovative_sme',queriedAt:new Date().toISOString(),status:'success',rawResponse:'Synthetic assigned process',relations:[{enterpriseId:migrant.enterprise.id,sequenceNo:1,usccRaw:code,nameRaw:migrant.enterprise.name,verificationStatus:'confirmed',matchBasis:'uscc'}]})
  await seedPostgresPlatformQuery(db,syntheticRecognizedQuery({rdjb:'1',queriedAt:new Date().toISOString(),rows:[{enterpriseId:null,raw:{id:'source-period-only',qymc:migrant.enterprise.name,tyshxydm:code,rdjb:'1',rdtime:`${year-1}-01-01`,rddqrq:`${year+1}-12-31`,sfyx:'1',szsmc:'宁波市'}}]}))
  expect((await query({})).body).toMatchObject({total:1,rows:[{enterpriseId:migrant.enterprise.id,firstYear:null,recognition:{precision:'year',year:year-1}}]})
  const source = {id:native.queryId}, relation={id:native.relationIds[0]!}
  const scope={enterpriseId:migrant.enterprise.id,titleCode:'innovative_sme',direction:'extra_in_miit'} as const
  const api=async (body:unknown) => {
    const response=await fetch(f.url('/api/roster/decision-lifecycle/commands'),{method:'POST',headers:f.headers,body:JSON.stringify(body)})
    return {status:response.status,body:await response.json() as any}
  }
  const command=await api({...scope,action:'replace',expectedCurrentId:null,idempotencyKey:'filter155-migrant',actor:{type:'agent',id:'synthetic-155'},basis:'Synthetic independent external qualification and publication check',ruleVersion:'synthetic-155',effectiveAt:`${year-1}-01-01T00:00:00Z`,decision:{status:'confirmed_reason',reasonCode:'moved_in',measureCode:'record_moved_in',verificationStatus:'confirmed',evidenceQueryId:source.id,evidenceRelationId:relation.id,currentQualification:{titleCode:'innovative_sme',validFrom:`${year-1}-01-01T00:00:00Z`,validUntil:`${year+2}-01-01T00:00:00Z`,basis:'Synthetic confirmed external qualification',publicationCheck:{status:'not_found',scope:'All ingested Ningbo innovative announcements'}}}})
  expect(command.status,JSON.stringify(command.body)).toBe(200)
  await seedRetiredEvidenceState(db, command.body.versionId)
  const unfiltered=await query({})
  expect(unfiltered.body).toMatchObject({total:1,rows:[{enterpriseId:migrant.enterprise.id,firstYear:null,recognition:{precision:'year',year:year-1},matchedValidYears:[year+1],qualificationWitnesses:[{cycle:{originYear:year-1,batchSeq:null},awardEventId:null,recognition:{precision:'year',year:year-1},matchedValidYear:year+1,matchedMaintenance:null,correspondenceId:null,conditionQueryId:null}]}],publishedPending:{rows:[],total:0}})
  const unrecognized=await query({status:'unrecognized'})
  expect(unrecognized.body).toMatchObject({total:0,rows:[]})
  const dated=await query({recognitionFrom:`${year}-01-01`,recognitionTo:`${year}-12-31`})
  expect(dated.body).toMatchObject({total:0,uncertainTotal:0,rows:[]})
  const knownYear=await query({recognitionFrom:`${year-1}-01-01`,recognitionTo:`${year-1}-12-31`})
  expect(knownYear.body).toMatchObject({total:1,uncertainTotal:0,rows:[{enterpriseId:migrant.enterprise.id,firstYear:null,recognition:{precision:'year',year:year-1}}]})
  const partialYear=await query({recognitionFrom:`${year-1}-02-01`,recognitionTo:`${year-1}-12-31`})
  expect(partialYear.body).toMatchObject({total:0,uncertainTotal:1,rows:[]})
  const detail=await fetch(f.url(`/api/roster/enterprises/${migrant.enterprise.id}`)).then(r=>r.json())
  expect(detail.events).toEqual([])
  expect(detail.qualificationAssessment.titles.find((t:any)=>t.titleCode==='innovative_sme').evidence).toEqual([])
  expect((await query({status:'unrecognized',recognitionFrom:`${year}-01-01`,recognitionTo:`${year}-12-31`})).body).toMatchObject({total:0,uncertainTotal:0,rows:[]})
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
  const migrant = await candidate('年份部分见证')
  const eventId = await eventForRecord(migrant.record.id)
  const first = await linkRecognized(migrant.enterprise.id,eventId,{},'recognized_corrob',{rddqrq:'2028-11-20'})
  const second = await linkRecognized(migrant.enterprise.id,eventId,{},'recognized_corrob',{whpc:'2023-2'})
  const read = async (filters: Record<string,number> = {}) => transport === 'MCP' ? mcp(filters)
    : (await query(Object.fromEntries(Object.entries(filters).map(([key,value]) => [key,String(value)])))).body
  const all = await read()
  expect(all).toMatchObject({total:1,options:{validYears:[2028],maintenanceYears:[2023],maintenanceBatchesByYear:{}},rows:[{enterpriseId:migrant.enterprise.id,group:'eligible'}]})
  expect(all.rows[0].qualificationWitnesses).toEqual([
    expect.objectContaining({conditionQueryId:first.queryId,correspondenceId:expect.any(Number),matchedValidYear:2028,matchedMaintenance:null}),
    expect.objectContaining({conditionQueryId:second.queryId,correspondenceId:expect.any(Number),matchedValidYear:null,matchedMaintenance:{year:2023,batch:null}}),
  ])
  expect((await read({maintenanceYear:2023})).total).toBe(1)
  expect((await read({validYear:2028})).total).toBe(1)
  expect(await read({validYear:2028,maintenanceYear:2023})).toMatchObject({total:0,rows:[]})
  expect(await read({maintenanceYear:2023,maintenanceBatch:2})).toMatchObject({total:0,rows:[]})
  await linkRecognized(migrant.enterprise.id,eventId,{},'recognized_corrob',{whpc:'2024-3'})
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
    const a = await candidate('未知格式'+index)
    const eventId = await eventForRecord(a.record.id)
    await linkRecognized(a.enterprise.id,eventId,{rddqrq:'2028',whpcyear:'2023',whpc:'2'},'recognized_corrob',raw)
  }
  expect(await read('innovative_sme')).toMatchObject({total:4,options:{validYears:[],maintenanceYears:[],maintenanceBatchesByYear:{}}})
  expect(await read('innovative_sme',{validYear:2028})).toMatchObject({total:0,rows:[]})
  expect(await read('innovative_sme',{maintenanceYear:2023})).toMatchObject({total:0,rows:[]})
  for (const title of ['specialized_sme','little_giant']) {
    const a = await candidate(title,undefined,title)
    const eventId = await eventForRecord(a.record.id)
    await linkRecognized(a.enterprise.id,eventId,{},'recognized_corrob',{rddqrq:'2028-11-20',whpc:'2023-2'})
    expect(await read(title)).toMatchObject({total:1,options:{validYears:[],maintenanceYears:[],maintenanceBatchesByYear:{}}})
    expect(await read(title,{validYear:2028})).toMatchObject({total:0,rows:[]})
    expect(await read(title,{maintenanceYear:2023})).toMatchObject({total:0,rows:[]})
  }
})

it.each(['HTTP', 'MCP'] as const)('uses observed composite year without confirming its suffix or predicate batch over %s', async transport => {
  const a = await candidate('已观察年份')
  const eventId = await eventForRecord(a.record.id)
  await linkRecognized(a.enterprise.id,eventId,{rddqrq:'2028',whpcyear:'2023',whpc:'2'},'recognized_corrob',{rddqrq:'2028-11-20',whpcyear:'',whpc:'2023-2'})
  const read = async (filters: Record<string,number> = {}) => transport === 'MCP' ? mcp(filters)
    : (await query(Object.fromEntries(Object.entries(filters).map(([key,value]) => [key,String(value)])))).body
  expect(await read({validYear:2028,maintenanceYear:2023})).toMatchObject({total:1,rows:[{matchedValidYears:[2028],matchedMaintenance:[{year:2023,batch:null}]}],options:{maintenanceBatchesByYear:{}}})
  expect(await read({maintenanceYear:2023,maintenanceBatch:2})).toMatchObject({total:0,rows:[]})
})

it.each(['HTTP', 'MCP'] as const)('uses predicates only for consistency and ignores partial archives over %s', async transport => {
  const a = await candidate('条件不替代事实')
  const eventId = await eventForRecord(a.record.id)
  const mismatch = await linkRecognized(a.enterprise.id,eventId,{rddqrq:'2029',whpcyear:'2024'},'recognized_corrob',{rddqrq:'2028-11-20',whpc:'2023-2'})
  await linkRecognized(a.enterprise.id,eventId,{},'recognized_corrob',{rddqrq:'2028-11-20',whpc:'2023-2'},false,true)
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
  const a = await candidate('独立有效年')
  const eventId = await eventForRecord(a.record.id)
  await linkRecognized(a.enterprise.id,eventId,{},'recognized_corrob',{rddqrq:'2028-02-29',whpcyear:'2023',whpc:'2023-2'})
  const read = async (filters: Record<string,number> = {}) => transport === 'MCP' ? mcp(filters)
    : (await query(Object.fromEntries(Object.entries(filters).map(([key,value]) => [key,String(value)])))).body
  expect(await read({validYear:2028})).toMatchObject({total:1,rows:[{matchedValidYears:[2028],matchedMaintenance:[]}],options:{validYears:[2028],maintenanceYears:[],maintenanceBatchesByYear:{}}})
  expect(await read({validYear:2028,maintenanceYear:2023})).toMatchObject({total:0,rows:[]})
})

it.each(['HTTP', 'MCP'] as const)('does not use a different original row title as qualification evidence over %s', async transport => {
  const a=await candidate('来源称号边界')
  const eventId=await eventForRecord(a.record.id)
  await seedPostgresPlatformQuery(db,syntheticRecognizedQuery({rdjb:'2',queriedAt:'2026-05-01T00:00:00Z',rows:[{enterpriseId:a.enterprise.id,raw:{id:'OTHER-TITLE',qymc:a.enterprise.name,tyshxydm:a.enterprise.usccNorm,rdjb:'2',rddqrq:'2028-11-20',whpc:'2023-2'}}]}))
  const read=async(filters:Record<string,number>={})=>transport==='MCP'?mcp(filters):(await query(Object.fromEntries(Object.entries(filters).map(([key,value])=>[key,String(value)])))).body
  expect(await read()).toMatchObject({total:1,rows:[{matchedValidYears:[],matchedMaintenance:[]}],options:{validYears:[],maintenanceYears:[]}})
  expect(await read({validYear:2028})).toMatchObject({total:0,rows:[]})
  expect(await read({maintenanceYear:2023})).toMatchObject({total:0,rows:[]})
})
