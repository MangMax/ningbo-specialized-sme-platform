import { and, asc, eq, sql } from 'drizzle-orm'
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
import { fresh, year, type Event } from '../current-export/fixtures/specialized-export'

const dir = mkdtempSync(join(tmpdir(), 'recognition-date-range-'))
const f = nativeAppAdapter({ dir, token: 'synthetic-recognition-date-range' })
let pool: Pool | undefined
let db: ReturnType<typeof drizzle<Record<string, never>>>
beforeAll(async () => {
  await f.start()
  pool = new Pool({ connectionString: f.postgresUrl, options: '-c search_path=business,public' })
  db = drizzle({ client: pool })
}, 45_000)
beforeEach(async () => {
  await db.execute(sql`
    TRUNCATE enterprise, record_event, record_evidence, platform_collection,
      platform_business_record, import_batch,
      difference_reason RESTART IDENTITY CASCADE
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

async function seedRecognized(subject: { id: number; name: string; usccNorm: string | null }, raw: Record<string, unknown>) {
  await seedPostgresPlatformQuery(db, syntheticRecognizedQuery({
    rdjb: '1', queriedAt: new Date().toISOString(),
    rows: [{ raw: { id: 'synthetic-retired-filter', qymc: subject.name, tyshxydm: subject.usccNorm, rdjb: '1', ...raw }, enterpriseId: subject.id }],
  }))

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

it('preserves the formal recognition filter with a platform row', async () => {
  const a = await candidate('正式认定与平台数据', [{ eventType: 'award', year: year - 1, batchSeq: 2 }])
  const eventId = await eventForRecord(a.record.id)
  await seedRecognized(a.enterprise, {
    rddqrq: `${year + 2}-11-20`, whpc: `${year - 1}-2`,
  })
  const recognition = { recognitionFrom: `${year - 1}-01-01`, recognitionTo: `${year - 1}-12-31` }
  const expected = {
    total: 1,
    options: { validYears: [], maintenanceYears: [], maintenanceBatchesByYear: {} },
    rows: [{ enterpriseId: a.enterprise.id, qualificationWitnesses: [{
      cycle: { originYear: year - 1, batchSeq: 2 }, awardEventId: eventId,
      recognition: { precision: 'year', year: year - 1 }, matchedValidYear: null, matchedMaintenance: null,
    }] }],
  }
  expect((await query(recognition)).body).toMatchObject(expected)
  expect(await mcp(recognition)).toMatchObject(expected)
  const filters = { ...recognition, validYear: year + 2, maintenanceYear: year - 1 }
  expect(await mcp(filters)).toMatchObject({ total: 0, rows: [] })
  expect((await query({ ...recognition, validYear: String(filters.validYear), maintenanceYear: String(filters.maintenanceYear) })).body)
    .toMatchObject({ total: 0, rows: [] })
})

it('uses the restored award time and excludes the failed grant from recognition filters', async () => {
  const a=await candidate('同源年再次认定',[
    {eventType:'award',year:year-4,batchSeq:1},
    {eventType:'review',year:year-4,batchSeq:1,decidedYear:year-3,reviewOutcome:'failed'},
    {eventType:'award',year:year-4,decidedYear:year-1,batchSeq:1},
  ])
  const awards= await eventsForEnterprise(a.enterprise.id, true)
  const recognition = { recognitionFrom: `${year - 1}-01-01`, recognitionTo: `${year - 1}-12-31` }
  const restored = await query(recognition)
  expect(restored.body).toMatchObject({total:1,rows:[{enterpriseId:a.enterprise.id,recognition:{precision:'year',year:year-1}}]})
  expect(restored.body.rows[0].qualificationWitnesses.map((w:any)=>w.awardEventId)).toEqual([awards[1]!.id])
  expect((await mcp(recognition)).total).toBe(1)
  expect((await query({recognitionFrom:`${year-4}-01-01`,recognitionTo:`${year-4}-12-31`})).body.total).toBe(0)
})

it('keeps known and unknown batch grants separate in the formal recognition filter', async () => {
  const a = await candidate('未定批次双授予', [
    { eventType: 'award', year: year - 1, batchSeq: 1 },
    { eventType: 'award', year: year - 1, batchSeq: null },
  ])
  const awards = await eventsForEnterprise(a.enterprise.id, true)
  const result = await query({ recognitionFrom: `${year - 1}-01-01`, recognitionTo: `${year - 1}-12-31` })
  expect(result.body).toMatchObject({ total: 1, rows: [{ enterpriseId: a.enterprise.id }] })
  expect(result.body.rows[0].qualificationWitnesses.map((w:any) => [w.awardEventId,w.cycle.batchSeq]))
    .toEqual([[awards[0]!.id,1],[awards[1]!.id,null]])
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
  expect(unfiltered.body).toMatchObject({total:1,rows:[{enterpriseId:migrant.enterprise.id,firstYear:null,recognition:{precision:'year',year:year-1},matchedValidYears:[year+1],qualificationWitnesses:[{cycle:{originYear:year-1,batchSeq:null},awardEventId:null,recognition:{precision:'year',year:year-1},matchedValidYear:year+1,matchedMaintenance:null}]}],publishedPending:{rows:[],total:0}})
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

it.each(['HTTP', 'MCP'] as const)('does not use a different original row title as qualification evidence over %s', async transport => {
  const a=await candidate('来源称号边界')
  await seedPostgresPlatformQuery(db,syntheticRecognizedQuery({rdjb:'2',queriedAt:'2026-05-01T00:00:00Z',rows:[{enterpriseId:a.enterprise.id,raw:{id:'OTHER-TITLE',qymc:a.enterprise.name,tyshxydm:a.enterprise.usccNorm,rdjb:'2',rddqrq:'2028-11-20',whpc:'2023-2'}}]}))
  const read=async(filters:Record<string,number>={})=>transport==='MCP'?mcp(filters):(await query(Object.fromEntries(Object.entries(filters).map(([key,value])=>[key,String(value)])))).body
  expect(await read()).toMatchObject({total:1,rows:[{matchedValidYears:[],matchedMaintenance:[]}],options:{validYears:[],maintenanceYears:[]}})
  expect(await read({validYear:2028})).toMatchObject({total:0,rows:[]})
  expect(await read({maintenanceYear:2023})).toMatchObject({total:0,rows:[]})
})
