import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as schema from '../db/schema'
import { TITLE_SEED } from '../db/titles'
import type { OfficialPublishedRow, RosterImportPayload, RosterImportRecord } from '../lib/roster-import-client'
import { preflightRosterImport, commitRosterImport } from '../server/utils/roster-import'
import { handleRosterImportRequest } from '../server/utils/roster-import-http'
import { handleEvidenceCorrectionRequest } from '../server/utils/roster-evidence-correction-api'
import { readCurrentCandidate, readCurrentQualificationAssessment, type CurrentTitle } from '../lib/roster/current-qualification'
import { writeCurrentWorkbook } from '../lib/roster/current-workbook'
import { startHttpFixture } from './helpers/http-fixture'
import { minimalPdf } from './helpers/minimal-pdf'
import * as official from '../server/utils/official-evidence'
import { assertOfficialPublishedBudget, readOfficialPublishedPresentation, OfficialPublishedPresentationError, type OfficialPublishedFact } from '../lib/roster/official-published-presentation'
import { currentWorkbookValues } from '../lib/roster/current-workbook-presentation'

import { getRosterEnterpriseDetail } from '../lib/roster/enterprise-roster'
import { listCurrentQualified } from '../lib/roster/current-qualified-query'
import { handleRecordCorrespondenceRequest } from '../server/utils/record-correspondence-api'

const routeContext = vi.hoisted(() => ({ db: undefined as any }))
// The package's defineMcpTool is an identity function; loading its Nitro registration cache needs virtual storage.
vi.mock('@nuxtjs/mcp-toolkit/server', () => ({ defineMcpTool: (definition: unknown) => definition }))
vi.mock('@db', () => ({ useDb: () => routeContext.db }))
vi.mock('../server/utils/enterprise-read', () => ({ enterpriseReads: {
  json: async (_path: string, request: {enterpriseId: number}) => {
    const value = getRosterEnterpriseDetail(routeContext.db, request.enterpriseId)
    return { found: value != null, body: Buffer.from(JSON.stringify(value)) }
  },
  currentQualifiedJson: async (_path: string, filter: Parameters<typeof listCurrentQualified>[1]) => ({ body: Buffer.from(JSON.stringify(listCurrentQualified(routeContext.db.$client, filter))) }),
} }))

const closes: Array<() => void | Promise<void>> = []
const qualificationYear = 2026
const executionTime = Date.parse('2026-10-25T08:00:00Z')
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(executionTime) })
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); for (const close of closes.splice(0).reverse()) await close() })
const sourceBytes = minimalPdf({ pages: 1 })
const digest = createHash('sha256').update(sourceBytes).digest('hex')
const uscc = '91330211255994457P'
async function fixture() {
  const dir = mkdtempSync('/tmp/issue356-synthetic-'), filesDir = join(dir, 'files'); mkdirSync(filesDir)
  const sqlite = new Database(join(dir, 'synthetic.sqlite')); sqlite.pragma('foreign_keys=ON')
  closes.push(() => { expect(sqlite.pragma('foreign_key_check')).toEqual([]); sqlite.close() })
  const db = drizzle(sqlite, { schema }); migrate(db, { migrationsFolder: resolve('db/migrations') })
  // Infrastructure catalog only. Normal domain facts below go through B public commands.
  for (const title of TITLE_SEED) db.insert(schema.title).values(title).run()
  for (const [index, path] of ['2021公布.pdf', '2024公布.pdf', '独立佐证.pdf'].entries()) {
    writeFileSync(join(filesDir, path), sourceBytes)
    db.insert(schema.storedFile).values({ id: index + 1, relPath: path, filename: path, ext: 'pdf', source: 'jxj', kind: 'announcement', bytes: Buffer.byteLength(sourceBytes), sha256: digest, createdAt: 'synthetic' }).run()
  }
  const server = await startHttpFixture({ routes: {
    ...Object.fromEntries((['preflight', 'commit'] as const).map(action => ['/import/' + action, (input: Parameters<typeof handleRosterImportRequest>[1]) => handleRosterImportRequest(action, input, { db, apiToken: 'synthetic-356-api', filesDir, executeImport: async (database, a, request, errors, context) => a === 'preflight' ? preflightRosterImport(database, request, errors, { ...context, filesDir }) : commitRosterImport(database, request, errors, { ...context, filesDir }) })])),
    ...Object.fromEntries((['preflight', 'commit'] as const).map(action => ['/correction/' + action, (input: Parameters<typeof handleRosterImportRequest>[1]) => handleEvidenceCorrectionRequest({ ...input, action }, { db, apiToken: 'synthetic-356-api', filesDir })])),
    '/detail': input => ({ status: 200, body: getRosterEnterpriseDetail(db, Number(input.query.id)) }),
    '/current': input => ({ status: 200, body: listCurrentQualified(sqlite, { titleCode: 'specialized_sme', pageSize: Number(input.query.pageSize ?? 25), page: Number(input.query.page ?? 1) }) }),
    '/source': input => handleRecordCorrespondenceRequest({ ...input, action: 'source', kind: 'event', id: input.query.id }, { db, apiToken: 'synthetic-356-api' }),
    '/exact': input => handleEvidenceCorrectionRequest({ ...input, action: 'get', id: input.query.id, query: { official: 'latest' } }, { db, apiToken: 'synthetic-356-api' }),
  } }); closes.push(server.close)
  const trace: unknown[] = []; closes.push(() => writeFileSync(join(dir, 'public-commands.json'), JSON.stringify(trace, null, 2)))
  const http = async (path: string, body?: unknown) => {
    const response = await fetch(server.baseUrl + path, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: 'Bearer synthetic-356-api', 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    const result = await response.json(); trace.push({ path, body, status: response.status, result })
    expect(response.status, JSON.stringify(result)).toBe(200)
    return result
  }
  const commit = async (payload: RosterImportPayload, key: string) => {
    const request = { idempotencyKey: key, sourceKind: 'announcement', sourceIdentity: 'synthetic-356', payload }
    const plan = await http('/import/preflight', request); expect(plan.preflight.conflicts).toEqual([])
    const result = await http('/import/commit', { ...request, payload: { ...payload, ...(plan.preflight.officialEvidencePlanHash ? { officialEvidencePlanHash: plan.preflight.officialEvidencePlanHash } : {}) } })
    expect(result.status, JSON.stringify(result)).toBe('committed'); return result
  }
  const published = (nameRaw: string | null, file = 1, listNo = 1, extra: Partial<OfficialPublishedRow> = {}): OfficialPublishedRow => ({ nameRaw, usccRaw: uscc, districtRaw: null, declaration: { kind: 'independent', sourceDocument: { source: 'jxj', title: '合成公布', docNumber: null, issueDate: null, path: ['2021公布.pdf', '2024公布.pdf', '独立佐证.pdf'][file - 1]! }, basis: '合成独立发布依据' }, storedFileId: file, path: ['2021公布.pdf', '2024公布.pdf', '独立佐证.pdf'][file - 1]!, sha256: digest, bytes: Buffer.byteLength(sourceBytes), attachment: null, sectionKey: '认定名单', listNo, page: 1, sourceBindingKnown: true, actor: { type: 'agent', id: 'synthetic-356' }, basis: '合成逐行核实', ...extra })
  const evidence = (row: OfficialPublishedRow) => ({ sourceFile: row.path!, attachment: row.attachment, page: row.page, listNo: row.listNo, publishedRow: row })
  const record = (title: CurrentTitle, events: RosterImportRecord['events'], name = '现用名', code: string | null = uscc): RosterImportRecord => ({ enterprise: { name, uscc: code }, titleCode: title, events })
  const announcement = (records: RosterImportRecord[]): RosterImportPayload => ({ announcement: { sourceDocument: { source: 'jxj', title: '合成公布' }, records } })
  const ids = () => db.select().from(schema.recordEvidence).all()
  const exact = (id: number) => http('/exact?id=' + id)
  const correct = async (id: number, row: OfficialPublishedRow, key: string) => {
    const current = await exact(id)
    const request = { idempotencyKey: key, actor: { type: 'agent', id: 'synthetic-356' }, basis: '合成更正依据', operations: [{ evidenceId: id, eventId: current.eventId, recordId: current.recordId, enterpriseId: current.enterpriseId, expectedVersion: current.version, expectedRowRevision: current.official.row?.revision ?? 0, coordinate: { sourceFile: row.path, attachment: row.attachment, listNo: row.listNo, page: row.page }, publishedRow: row }] }
    const plan = await http('/correction/preflight', request)
    await http('/correction/commit', { request, planHash: plan.planHash })
  }
  return { dir, db, sqlite, commit, published, evidence, record, announcement, ids, exact, correct, http }
}


const factsOf = (value: any) => value.publishedPresentation?.facts
const minimal = (evidenceId: number, eventId: number, nameRaw: string | null, revision = 1, sourceBindingKnown = true) => ({ evidenceId, eventId, revision, availability: 'captured', nameRaw, sourceBindingKnown })
async function paired() {
  const f = await fixture()
  await f.commit(f.announcement([f.record('specialized_sme', [
    { eventType: 'award', year: 2021, batchSeq: 1, evidence: [f.evidence(f.published('2021旧名'))] },
    { eventType: 'review', year: 2021, batchSeq: 1, decidedYear: 2024, reviewOutcome: 'passed', evidence: [f.evidence(f.published('2024新名', 2))] },
  ])]), 'paired')
  return f
}

it('B01 pairs anonymous detail source and retained current names by stable evidence IDs without exposing C envelopes', async () => {
  const f = await paired(), ids = f.ids(), expected = [minimal(1, 1, '2021旧名'), minimal(2, 2, '2024新名')]
  const detail = await f.http('/detail?id=1')
  expect(factsOf(detail)).toEqual(expected)
  expect(detail.evidence.map((e: any) => [e.id, e.eventId, e.sourceFile, e.page, e.listNo])).toEqual([[1, 1, '2021公布.pdf', 1, 1], [2, 2, '2024公布.pdf', 1, 1]])
  expect(detail.records[0].nameRaw).toBe('现用名')
  const current = await f.http('/current')
  expect(current.total).toBe(1); expect(current.uncertainTotal).toBe(0)
  expect(factsOf(current.rows[0])).toEqual(expected)
  expect(current.rows[0].publishedNames).toEqual(['现用名'])
  for (const id of ids) {
    const source = await f.http('/source?id=' + id.recordEventId)
    expect(factsOf(source.source)).toEqual([expected[id.id - 1]])
    expect(source.source.evidence[0].publishedName).toEqual(expected[id.id - 1])
    expect(Object.keys(source.source.evidence[0].publishedName).sort()).toEqual(['availability','eventId','evidenceId','nameRaw','revision','sourceBindingKnown'])
    const exact = await f.exact(id.id)
    expect(exact.official.row.nameRaw).toBe(expected[id.id - 1]!.nameRaw)
    expect(exact.official.row.actor).toBeDefined()
    expect(JSON.stringify(factsOf(source.source))).not.toMatch(/actor|basis|command|sha256|usccRaw|districtRaw|capturedEnterpriseId/)
  }
})

it('B02 preserves null empty whitespace binding unknown legacy and repeated equal names as distinct sources', async () => {
  const f = await fixture()
  await f.commit(f.announcement([f.record('specialized_sme', [{ eventType: 'award', year: 2024, batchSeq: 1, evidence: [
    f.evidence(f.published(null, 1, 1)), f.evidence(f.published('', 1, 2)), f.evidence(f.published(' \t旧名\n ', 1, 3)),
    f.evidence(f.published('相同名称', 1, 4, { sourceBindingKnown: false })), f.evidence(f.published('相同名称', 1, 5)),
    { sourceFile: '2021公布.pdf', page: 1, listNo: 99 },
  ] }])]), 'mixed')
  const expected = [minimal(1,1,null), minimal(2,1,''), minimal(3,1,' \t旧名\n '), minimal(4,1,'相同名称',1,false), minimal(5,1,'相同名称'), { evidenceId:6,eventId:1,revision:null,availability:'unknown_legacy',nameRaw:null,sourceBindingKnown:null }]
  expect(factsOf(await f.http('/detail?id=1'))).toEqual(expected)
  expect(factsOf((await f.http('/source?id=1')).source)).toEqual(expected)
  expect(factsOf((await f.http('/current')).rows[0])).toEqual(expected)
})

it('B03 hydrates only retained current rows after qualification counts filters and options', async () => {
  const f = await paired()
  await f.commit(f.announcement([f.record('specialized_sme', [{ eventType:'award',year:2024,batchSeq:1,evidence:[f.evidence(f.published('第二企业',3,2,{usccRaw:null}))] }], '第二企业', null)]), 'second')
  const read = vi.spyOn(official, 'listEventsOfficialEvidencePages')
  const current = await f.http('/current?page=1&pageSize=1')
  expect(current.total).toBe(2); expect(current.rows).toHaveLength(1)
  expect(read).toHaveBeenCalledTimes(1)
  expect(read.mock.calls.map(call => [call[1],call[2]])).toEqual([[[{eventId:1},{eventId:2}],{pageSize:50,maxBytes:65536}]])
  expect(current.options.recognitionYears).toEqual([2021,2024])
  expect(current.rows[0].qualificationWitnesses).toMatchObject([{cycle:{originYear:2021,batchSeq:1},awardEventId:1,recognition:{precision:'year',year:2021}}])
  expect(current.rows[0].references).toEqual(expect.arrayContaining(['evidence:1 2021公布.pdf  序号:1','evidence:2 2024公布.pdf  序号:1']))
})

it('B04 reads raw-only latest after public correction without caching or changing qualification partitions', async () => {
  const f = await paired(), before = await f.http('/current'), current = await f.exact(2)
  const row = f.published('更正公布原名', 2, 1, { declaration:{kind:'existing',sourceDocumentId:current.official.row.sourceDocumentId,basis:'同一出处复核'} })
  await f.correct(2,row,'raw-only')
  const after = await f.http('/current')
  expect(factsOf(after.rows[0])).toEqual([minimal(1,1,'2021旧名'),minimal(2,2,'更正公布原名',2)])
  expect([after.total,after.uncertainTotal,after.options,after.rows[0].group,after.rows[0].publishedNames]).toEqual([before.total,before.uncertainTotal,before.options,before.rows[0].group,before.rows[0].publishedNames])
  expect(factsOf(await f.http('/detail?id=1'))).toEqual(factsOf(after.rows[0]))
  expect(factsOf((await f.http('/source?id=2')).source)).toEqual([minimal(2,2,'更正公布原名',2)])
  expect(after.rows[0].basis).not.toBe(before.rows[0].basis) // B correctly increments event.revision.
})

it('B05 separates unavailable safe errors from unknown legacy while preserving original detail and locators', async () => {
  const f = await paired()
  vi.spyOn(official,'listEventsOfficialEvidencePages').mockImplementation(() => { throw new Error('private sql secret capture') })
  const detail = await f.http('/detail?id=1')
  expect(detail.publishedPresentation).toEqual({availability:'unavailable',error:'read_failed',facts:[]})
  expect(detail.evidence.map((v:any) => [v.id,v.sourceFile,v.page])).toEqual([[1,'2021公布.pdf',1],[2,'2024公布.pdf',1]])
  expect(JSON.stringify(detail)).not.toContain('private sql secret capture')
  expect((await f.http('/source?id=1')).source.publishedPresentation).toEqual({availability:'unavailable',error:'read_failed',facts:[]})
  const query = await f.http('/current')
  expect(query.total).toBe(1); expect(query.rows[0].group).toBe('eligible')
  expect(query.rows[0].publishedPresentation).toEqual({availability:'unavailable',error:'read_failed',facts:[]})
})

it('B06 reuses one selected event Map across source detail and repeated references with no per-evidence latest', async () => {
  const f = await paired()
  const { sourceReader } = await import('../server/utils/record-correspondence-read')
  // Caller-selected reference inputs to the pure reader, not forged persisted decisions.
  const row = { id: 17, type:'later_process',role:'followup_apply',status:'candidate',eventId:1,predecessorEventId:2,relationId:null,exportRowId:null } as any
  const read = vi.spyOn(official,'listEventsOfficialEvidencePages'), latest = vi.spyOn(official,'readLatestOfficialEvidence')
  const reader = sourceReader(f.db,[row,{...row,id:18}],{kind:'event',id:1})
  const direct = reader.read('event',1) as any, first = reader.detail(row), second = reader.detail({...row,id:18})
  expect(read).toHaveBeenCalledTimes(1)
  expect(read.mock.calls.map(call => [call[1],call[2]])).toEqual([[[{eventId:1},{eventId:2}],{pageSize:50,maxBytes:65536}]])
  expect(first.event).toBe(direct); expect(second.event).toBe(direct)
  expect((first.event as any).evidence[0].publishedName).toBe((second.event as any).evidence[0].publishedName)
  expect((first.predecessorEvent as any).publishedPresentation.facts).toEqual([minimal(2,2,'2024新名')])
  expect(latest).not.toHaveBeenCalled()
})

it('B07 applies final source copy and text budget without truncating old locators or shrinking A pages', async () => {
  const f = await fixture(), name = 'x'.repeat(600)
  await f.commit(f.announcement([f.record('specialized_sme',[{eventType:'award',year:2024,batchSeq:1,evidence:Array.from({length:20},(_,i) => f.evidence(f.published(name,1,i+1)))}])]),'budget')
  const read = vi.spyOn(official,'listEventsOfficialEvidencePages')
  const detail = await f.http('/detail?id=1')
  expect(detail.publishedPresentation.availability).toBe('available')
  expect(detail.publishedPresentation.facts).toHaveLength(20)
  const source = await f.http('/source?id=1')
  expect(source.source.publishedPresentation).toEqual({availability:'unavailable',error:'response_limit',facts:[]})
  expect(source.source.evidence).toHaveLength(20)
  expect(source.source.evidence.map((v:any) => [v.id,v.page,v.listNo])).toEqual(Array.from({length:20},(_,i)=>[i+1,1,i+1]))
  expect(source.source.evidence.every((v:any) => !('publishedName' in v))).toBe(true)
  expect(read).toHaveBeenCalledTimes(2)
  expect(read.mock.calls.map(call => call[1])).toEqual([[{eventId:1}],[{eventId:1}]])
  expect(read.mock.calls.every(call => JSON.stringify(call[2]) === JSON.stringify({pageSize:50,maxBytes:65536}))).toBe(true)
})

it('B08 preserves A field and event scope failures as typed unavailable without exposing raw errors', async () => {
  const f = await paired()
  // Explicit corrupt historical capture; public B rejects these invalid inputs.
  f.sqlite.prepare('UPDATE official_evidence_row_revision SET name_raw=? WHERE evidence_id=1').run('x'.repeat(4001))
  const detail = await f.http('/detail?id=1')
  expect(detail.publishedPresentation).toEqual({availability:'unavailable',error:'field_limit',facts:[]})
  expect(detail.evidence).toHaveLength(2)
  f.sqlite.prepare('UPDATE official_evidence_row_revision SET name_raw=? WHERE evidence_id=1').run('2021旧名')
  // Explicit extreme legacy event scope, not a normal import shortcut.
  const insert = f.sqlite.prepare('INSERT INTO record_evidence(record_event_id,source_file,page,list_no) VALUES(1,?,1,?)')
  for(let i=0;i<300;i++)insert.run('historical.pdf',i+2)
  const source = await f.http('/source?id=1')
  expect(source.source.publishedPresentation).toEqual({availability:'unavailable',error:'source_limit',facts:[]})
  expect(source.source.evidence).toHaveLength(301)
})

it('B09 retains captured old and new names after public merge using the surviving owner IDs', async () => {
  const f = await fixture()
  await f.commit(f.announcement([f.record('specialized_sme',[{eventType:'award',year:2021,batchSeq:1,evidence:[f.evidence(f.published('归并前原名'))]}],'归并前企业',null)]),'old')
  await f.commit(f.announcement([f.record('specialized_sme',[{eventType:'award',year:2024,batchSeq:1,evidence:[f.evidence(f.published('归并后原名',2))]}])]),'new')
  await f.commit({merges:[{fromEnterpriseId:1,intoUscc:uscc,note:'独立主体依据核实归并'}]},'merge')
  const expected = [minimal(1,1,'归并前原名'),minimal(2,2,'归并后原名')]
  const detail = await f.http('/detail?id=2')
  expect(detail.enterprise.enterpriseId).toBe(2); expect(factsOf(detail)).toEqual(expected)
  expect(factsOf((await f.http('/current')).rows[0])).toEqual(expected)
  expect(factsOf((await f.http('/source?id=1')).source)).toEqual([expected[0]])
  expect((await f.exact(1)).official.row).toMatchObject({capturedEnterpriseId:1,currentOwner:{enterpriseId:2}})
})

it('B10 preserves enumerable qualification input exactly under an explicit sidecar-only isolation control', async () => {
  const f = await paired(), before = await f.http('/current'), exact = await f.exact(2)
  const row = f.published('隔离变量公布名',2,1,{declaration:{kind:'existing',sourceDocumentId:exact.official.row.sourceDocumentId,basis:'同一公布事实'}})
  await f.correct(2,row,'isolation')
  // Public correction increments event.revision. Pin just that old input to isolate the sidecar.
  f.sqlite.prepare('UPDATE record_event SET revision=? WHERE id=2').run(exact.event.revision)
  const after = await f.http('/current'), strip = (v:any) => ({...v,rows:v.rows.map(({publishedPresentation,...old}:any)=>old)})
  expect(strip(after)).toEqual(strip(before))
  expect(factsOf(after.rows[0])).toEqual([minimal(1,1,'2021旧名'),minimal(2,2,'隔离变量公布名',2)])
  expect(readCurrentCandidate(f.sqlite,1,'specialized_sme',qualificationYear,executionTime).group).toBe('eligible')
})

it('B11 reads actual H3 routes and MCP handlers through the same serialized DTO while C exact auth remains protected', async () => {
  const f = await paired(), h3 = await import('h3'), { createServer } = await import('node:http')
  routeContext.db = f.db
  for (const key of ['defineEventHandler','getRouterParam','setHeader','createError'] as const) vi.stubGlobal(key,h3[key])
  vi.stubGlobal('useRuntimeConfig',() => ({apiToken:'synthetic-356-api',mcpToken:'synthetic-mcp-356',filesDir:f.dir+'/files'}))
  const router = h3.createRouter()
  router.get('/api/roster/enterprises/:id',(await import('../server/api/roster/enterprises/[id].get')).default)
  router.get('/api/roster/current-enterprises',(await import('../server/api/roster/current-enterprises.get')).default)
  router.get('/api/roster/correspondences/events/:id',(await import('../server/api/roster/correspondences/events/[id].get')).default)
  router.get('/api/roster/evidence/:id',(await import('../server/api/roster/evidence/[id].get')).default)
  const server = createServer(h3.toNodeListener(h3.createApp().use(router)))
  await new Promise<void>((resolve,reject) => { server.once('error',reject);server.listen(0,'127.0.0.1',resolve) })
  closes.push(() => new Promise<void>((resolve,reject) => server.close(error => error ? reject(error) : resolve())))
  const address=server.address();if(!address || typeof address==='string')throw Error('Missing owned listener')
  const trace:unknown[]=[];closes.push(() => writeFileSync(join(f.dir,'h3-reads.json'),JSON.stringify(trace,null,2)))
  const get=async(path:string,token?:string) => {const response=await fetch(`http://127.0.0.1:${address.port}${path}`,{headers:token?{authorization:'Bearer '+token}:{}});const body=await response.json();trace.push({path,tokenPresent:!!token,status:response.status,body});return {status:response.status,body}}
  const expected=[minimal(1,1,'2021旧名'),minimal(2,2,'2024新名')]
  const detail=await get('/api/roster/enterprises/1'),query=await get('/api/roster/current-enterprises?titleCode=specialized_sme'),source=await get('/api/roster/correspondences/events/2')
  expect([detail.status,query.status,source.status]).toEqual([200,200,200])
  expect(factsOf(detail.body)).toEqual(expected);expect(factsOf(query.body.rows[0])).toEqual(expected);expect(factsOf(source.body.source)).toEqual([expected[1]])
  const { dispatchRecordCorrespondenceMcp }=await import('../server/utils/mcp-record-correspondence')
  expect(dispatchRecordCorrespondenceMcp('source',{kind:'event',id:2},{db:f.db})).toEqual(source.body)
  const detailTool=(await import('../server/mcp/tools/get_enterprise_detail')).default
  const currentTool=(await import('../server/mcp/tools/list_current_qualified_enterprises')).default
  // Direct tool handlers, not the real MCP transport or native admission.
  expect(JSON.parse(await (detailTool as any).handler({enterpriseId:1}))).toEqual(detail.body)
  expect(JSON.parse(await (currentTool as any).handler({titleCode:'specialized_sme'}))).toEqual(query.body)
  expect((await get('/api/roster/evidence/1')).status).toBe(200)
  expect((await get('/api/roster/evidence/1?official=latest')).status).toBe(401)
  expect((await get('/api/roster/evidence/1?official=latest','wrong')).status).toBe(401)
  const c=await get('/api/roster/evidence/1?official=latest','synthetic-356-api')
  expect(c.status).toBe(200);expect(c.body.official.row).toMatchObject({nameRaw:'2021旧名',actor:{type:'agent',id:'synthetic-356'},usccRaw:uscc})
  expect(JSON.stringify(factsOf(detail.body))).not.toMatch(/actor|command|basis|sha256|usccRaw|districtRaw/)
})

it('B12 rejects total enterprise name bytes across individually small event pages and preserves current counts', async () => {
  const f = await fixture()
  await f.commit(f.announcement([f.record('specialized_sme',Array.from({length:4},(_,eventIndex) => ({eventType:'award' as const,year:2021+eventIndex,batchSeq:1,evidence:Array.from({length:10},(_,i) => f.evidence(f.published('x'.repeat(1000),1,eventIndex*10+i+1)))})))]),'enterprise-scope')
  const detail=await f.http('/detail?id=1')
  expect(detail.publishedPresentation).toEqual({availability:'unavailable',error:'response_limit',facts:[]})
  expect(detail.events).toHaveLength(4);expect(detail.evidence).toHaveLength(40)
  const current=await f.http('/current')
  expect(current.total).toBe(1);expect(current.rows[0].group).toBe('eligible')
  expect(current.rows[0].publishedPresentation).toEqual({availability:'unavailable',error:'response_limit',facts:[]})
})

async function currentH3(f: Awaited<ReturnType<typeof fixture>>) {
  const h3 = await import('h3'), { createServer } = await import('node:http')
  routeContext.db = f.db
  vi.stubGlobal('defineEventHandler', h3.defineEventHandler)
  const handler = (await import('../server/api/roster/current-enterprises.get')).default
  const server = createServer(h3.toNodeListener(h3.createApp().use('/api/roster/current-enterprises', handler)))
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  closes.push(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
  const address = server.address(); if (!address || typeof address === 'string') throw Error('Missing owned H3 listener')
  return async () => {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/roster/current-enterprises?titleCode=specialized_sme`)
    expect(response.status).toBe(200); const result = await response.json()
    writeFileSync(join(f.dir, 'current-h3-r1.json'), JSON.stringify(result, null, 2)); return result
  }
}

async function budgetFixture(count: number, perEvent: number, name: string) {
  const f = await fixture()
  await f.commit(f.announcement([f.record('specialized_sme', Array.from({ length: count / perEvent }, (_, eventIndex) => ({
    eventType: 'award' as const, year: 2025 - count / perEvent + eventIndex, batchSeq: 1,
    evidence: Array.from({ length: perEvent }, (_, i) => f.evidence(f.published(name, 1, eventIndex * perEvent + i + 1))),
  })))]), 'r1-budget')
  const literal = Array.from({ length: count }, (_, i) => minimal(i + 1, Math.floor(i / perEvent) + 1, name))
  // Independent expected strings: no production formatter/budget builder supplies this oracle.
  const text = Array.from({ length: count }, () => '公布名称：' + JSON.stringify(name))
  const dtoBytes = Buffer.byteLength(JSON.stringify({ publishedPresentation: { availability: 'available', error: null, facts: literal } }))
  const textBytes = Buffer.byteLength(JSON.stringify(text))
  return { f, literal, dtoBytes, textBytes, get: await currentH3(f) }
}

it.each([{ case: 'Spec25', count: 25, perEvent: 5 }, { case: 'Standards24', count: 24, perEvent: 1 }])(
  'B13 rejects current double text overflow while retaining one DTO and all old qualification fields for $case', async ({ count, perEvent }) => {
    const { f, literal, dtoBytes, textBytes, get } = await budgetFixture(count, perEvent, 'x'.repeat(1000))
    expect(dtoBytes + textBytes).toBeLessThan(65536)
    expect(dtoBytes + textBytes * 2).toBeGreaterThan(65536)
    const before = JSON.parse(JSON.stringify(readCurrentCandidate(f.sqlite, 1, 'specialized_sme', qualificationYear, executionTime, undefined, true)))
    const current = await get(), { publishedPresentation, qualificationAssessment, ...old } = current.rows[0]
    // The additive complete T2 is checked before the unchanged legacy-row oracle.
    const scope = { enterpriseId: 1, asOf: new Date(executionTime).toISOString(), ruleVersion: 'current-roster-116-v8', assessmentVersion: 'enterprise-qualification-407-v1' }
    expect(current.responseVersion).toBe('current-qualified-408-v1')
    expect(qualificationAssessment).toMatchObject(scope)
    expect(qualificationAssessment.titles.map((item: { titleCode: string }) => item.titleCode)).toEqual(['little_giant', 'specialized_sme', 'innovative_sme'])
    expect(qualificationAssessment.snapshotId).toBe(createHash('sha256').update(JSON.stringify([scope, qualificationAssessment.titles])).digest('hex'))
    expect(qualificationAssessment).toEqual(readCurrentQualificationAssessment(f.sqlite, 1, executionTime))
    expect(current.total).toBe(1); expect(current.uncertainTotal).toBe(0); expect(old).toEqual(before)
    expect(old.references.filter((v: string) => v.startsWith('evidence:'))).toHaveLength(count)
    const detail = await f.http('/detail?id=1')
    expect(detail.publishedPresentation.facts).toEqual(literal)
    expect(detail.evidence.map((v: any) => [v.id, v.eventId, v.sourceFile, v.page, v.listNo])).toEqual(literal.map((v, i) => [v.evidenceId, v.eventId, '2021公布.pdf', 1, i + 1]))
    expect(publishedPresentation).toEqual({ availability: 'unavailable', error: 'response_limit', facts: [] })
  },
)

it('B14 keeps current under budget when one DTO and two texts fit but doubling the DTO would not', async () => {
  const { f, literal, dtoBytes, textBytes, get } = await budgetFixture(24, 1, 'x'.repeat(700))
  await f.commit({ aliases: [{ uscc, name: '已确认旧名', sourceKind: 'manual', sourceRefId: 0, verificationStatus: 'confirmed' }, { uscc, name: '待核别名', sourceKind: 'manual', sourceRefId: 0, verificationStatus: 'pending' }] }, 'r1-aliases')
  expect(dtoBytes + textBytes * 2).toBeLessThan(65536)
  expect(dtoBytes * 2 + textBytes * 2).toBeGreaterThan(65536)
  const current = await get()
  expect(current.rows[0].publishedPresentation).toEqual({ availability: 'available', error: null, facts: literal })
  expect(current.rows[0].aliases).toEqual(['已确认旧名'])
  expect(current.total).toBe(1)
})

it.each([{ case: 'escaped-below', repeats: 48, available: true }, { case: 'escaped-above', repeats: 54, available: false }])(
  'B15 budgets escaped Unicode UTF8 across both current text branches for $case', async ({ repeats, available }) => {
    const name = '中🙂"\\\n'.repeat(repeats)
    const { literal, dtoBytes, textBytes, get } = await budgetFixture(24, 1, name)
    expect(name.length).toBeLessThan(4000)
    if (available) expect(dtoBytes + textBytes * 2).toBeLessThan(65536)
    else expect(dtoBytes + textBytes * 2).toBeGreaterThan(65536)
    const current = await get()
    expect(current.rows[0].publishedPresentation).toEqual(available
      ? { availability: 'available', error: null, facts: literal }
      : { availability: 'unavailable', error: 'response_limit', facts: [] })
    expect(current.rows[0].group).toBe('eligible'); expect(current.total).toBe(1)
  },
)
