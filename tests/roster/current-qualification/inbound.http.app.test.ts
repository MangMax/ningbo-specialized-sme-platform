import { submitSyntheticRecognizedCollection } from '../fixtures/recognized-source'
import '../../support/compiled-enterprise-reader'
import { submitNativePlatformQuery } from '../../platform/fixtures/native-query'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as h3 from 'h3'
import ExcelJS from 'exceljs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { initializeDb, schema as s } from '../../../db/client'
import { enterpriseReads } from '../../../layers/sme-roster/server/utils/enterprise-read'
import { readEvidenceToken113 } from '../../../layers/sme-roster/server/utils/evidence-impact-113'
import { writeCurrentWorkbook } from '../../../layers/sme-roster/lib/roster/current-workbook'
import { createCurrentCandidateReader } from '../../../layers/sme-roster/lib/roster/current-qualification'
import type { CurrentQualifiedResult } from '../../../layers/sme-roster/lib/roster/current-qualified-query'
import type { CurrentQualifiedFilter } from '../../../layers/sme-roster/lib/roster/current-qualified-query'
import type { currentQualifiedFilterSchema } from '../../../layers/sme-roster/server/utils/current-qualified-filter'

const active = vi.hoisted(() => ({ db: null as ReturnType<typeof initializeDb> | null }))
vi.mock('@db', () => ({ useDb: () => active.db }))
vi.mock('@nuxtjs/mcp-toolkit/server', () => ({ defineMcpTool: (tool: unknown) => tool }))
const dir = mkdtempSync(join(tmpdir(), 'issue305-inbound-'))
const db = initializeDb({ create: true,  dbPath: join(dir, 'issue305.sqlite') }); active.db = db
const titles = ['little_giant', 'specialized_sme', 'innovative_sme'] as const
const year = new Date().getFullYear(), reawardYear = year - 1
type Review = { decidedYear: number | null; reviewOutcome: 'failed' | null }
const cases: { id: string; eligible: boolean; review?: Review; explicitAward: boolean; formalAward?: boolean }[] = [
  { id: 'settled-history-explicit-reaward', eligible: true, explicitAward: true },
  { id: 'failed-history-later-explicit-reaward', eligible: true, review: { decidedYear: year - 3, reviewOutcome: 'failed' }, explicitAward: true },
  { id: 'same-year-failure-reaward', eligible: false, review: { decidedYear: reawardYear, reviewOutcome: 'failed' }, explicitAward: true },
  { id: 'unknown-review-date', eligible: false, review: { decidedYear: null, reviewOutcome: 'failed' }, explicitAward: true },
  // A validity interval cannot restore a failed cycle without an explicit grant.
  { id: 'failed-history-interval-only', eligible: false, review: { decidedYear: year - 3, reviewOutcome: 'failed' }, explicitAward: false },
  { id: 'later-review-result-unknown', eligible: false, review: { decidedYear: year, reviewOutcome: null }, explicitAward: true },
  { id: 'formal-reaward-positive-control', eligible: true, explicitAward: true, formalAward: true },
]
const actor = { type: 'agent', id: 'issue305-inbound' } as const
const headers = { authorization: 'Bearer issue305-synthetic', 'content-type': 'application/json' }
const sourceCodes = ['91330211100000000P', '91330211100000010Q', '91330211100000020R', '91330211100000030T', '91330211100000040U', '91330211100000050W', '91330211100000060X', '91330211100000070Y', '913302111000000800', '913302111000000901', '91330211100000100D', '91330211100000110E', '91330211100000120F', '91330211100000130G', '91330211100000140H', '91330211100000150J', '91330211100000160K', '91330211100000170L', '91330211100000180M', '91330211100000190N', '913302111000002003'] as const
const codes = new Map<string, string>()
let identityIndex = 0
const ids = new Map<string, number>()
let server: ReturnType<typeof createServer>, base: string
const sdk = new McpServer({ name: 'issue305-inbound-read', version: '1' })
const client = new Client({ name: 'issue305-inbound-test', version: '1' })
type CurrentTool = { inputSchema: typeof currentQualifiedFilterSchema.shape; handler(input: CurrentQualifiedFilter): Promise<string> }
async function post(body: unknown): Promise<{ versionId: number }> {
  const response = await fetch(base + '/api/roster/decision-lifecycle/commands', { method: 'POST', headers, body: JSON.stringify(body) })
  expect(response.status, await response.clone().text()).toBe(200)
  return response.json()
}
beforeAll(async () => {
  await enterpriseReads.start()
  for (const [key, value] of Object.entries(h3)) vi.stubGlobal(key, value)
  vi.stubGlobal('useRuntimeConfig', () => ({ apiToken: 'issue305-synthetic', filesDir: dir }))
  const commands = (await import('../../../server/api/roster/decision-lifecycle/commands.post')).default
  const currentDecision = (await import('../../../server/api/roster/decision-lifecycle/current.get')).default
  const current = (await import('../../../server/api/roster/current-enterprises.get')).default
  const detail = (await import('../../../server/api/roster/enterprises/[id].get')).default
  server = createServer(h3.toNodeListener(h3.createApp({ debug: false }).use(h3.createRouter()
    .post('/api/roster/decision-lifecycle/commands', commands)
    .get('/api/roster/decision-lifecycle/current', currentDecision)
    .get('/api/roster/current-enterprises', current).get('/api/roster/enterprises/:id', detail))))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const tool = (await import('../../../server/mcp/tools/list_current_qualified_enterprises')).default as unknown as CurrentTool
  sdk.registerTool('list_current_qualified_enterprises', { inputSchema: tool.inputSchema }, async input => ({ content: [{ type: 'text', text: await tool.handler(input) }] }))
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await sdk.connect(serverTransport); await client.connect(clientTransport)
  for (const title of titles) for (const c of cases) {
    const name = `issue305-inbound-${title}-${c.id}`
    // Only immutable synthetic source facts are set up in SQLite. Qualification
    // and evidence review use the real public #102/#114 commands, as in PR138.
    const code = sourceCodes[identityIndex++]!
    codes.set(name, code)
    const enterprise = db.insert(s.enterprise).values({ name, nameNorm: name, usccNorm: code, city: '宁波市' }).returning().get()
    ids.set(name, enterprise.id)
    const record = db.insert(s.record).values({ enterpriseId: enterprise.id, titleCode: title, source: 'jxj', nameRaw: name }).returning().get()
    const events = [{ eventType: 'award' as const, year: 2020, decidedYear: 2020, batchSeq: 1 },
      ...(c.review ? [{ eventType: 'review' as const, year: 2020, batchSeq: 1, ...c.review }] : []),
      ...(c.formalAward ? [{ eventType: 'award' as const, year: reawardYear, decidedYear: reawardYear, batchSeq: 1 }] : [])]
    for (const input of events) {
      const event = db.insert(s.recordEvent).values({ recordId: record.id, ...input }).returning().get()
      db.insert(s.recordEvidence).values({ recordEventId: event.id, sourceFile: 'issue305/inbound-history.pdf', attachment: c.id, listNo: event.id, page: 1 }).run()
    }
    const rdjb = { little_giant: '3', specialized_sme: '2', innovative_sme: '1' }[title]
    const native = submitNativePlatformQuery(db, { interface: 'business_list', queryKey: name, rdjb, titleCode: title, queriedAt: new Date().toISOString(), status: 'success', rawResponse: JSON.stringify({ synthetic: name }), relations: [{ sequenceNo: 1, enterpriseId: enterprise.id, usccRaw: code, nameRaw: name, verificationStatus: 'confirmed', matchBasis: 'uscc' }] })
    // A real, current interface period must not override applicable publication.
    submitSyntheticRecognizedCollection(db, { rdjb, queriedAt: new Date().toISOString(), rows: [{ enterpriseId: null, raw: { id: name, qymc: name, tyshxydm: code, rdjb, rdtime: `${reawardYear}-01-01`, rddqrq: `${year+2}-12-31`, sfyx: '1', szsmc: '宁波市' } }] })
    const query = { id: native.queryId }, relation = { id: native.relationIds[0]! }
    const scope = { enterpriseId: enterprise.id, titleCode: title, direction: 'extra_in_miit' as const }
    const qualification = { titleCode: title, validFrom: `${reawardYear}-01-01T00:00:00Z`, validUntil: `${year + 2}-01-01T00:00:00Z`,
      ...(c.explicitAward ? { awardYear: reawardYear } : {}), basis: 'Synthetic independently verified external qualification',
      publicationCheck: { status: 'not_found', scope: 'New grant publications only; preserve older Ningbo history' } }
    const accepted = await post({ ...scope, action: 'replace', expectedCurrentId: null, idempotencyKey: name + '-replace', actor,
      basis: 'Synthetic reviewed inbound qualification with formal history', ruleVersion: 'issue305', effectiveAt: `${reawardYear}-01-01T00:00:00Z`,
      decision: { status: 'confirmed_reason', reasonCode: 'moved_in', measureCode: 'record_moved_in', verificationStatus: 'confirmed', evidenceQueryId: query.id, evidenceRelationId: relation.id, currentQualification: qualification } })
    const token = readEvidenceToken113(db, scope)
    expect(token.projectionReady).toBe(true)
    await post({ ...scope, action: 'maintain', expectedCurrentId: accepted.versionId, idempotencyKey: name + '-review', actor,
      basis: 'Synthetic explicit evidence review', ruleVersion: 'issue305', effectiveAt: `${reawardYear}-01-01T00:00:00Z`,
      reviewedEvidence: { latestRevisionId: token.latestRevisionId, projectionReady: token.projectionReady } })
    const readback = await fetch(base + '/api/roster/decision-lifecycle/current?' + new URLSearchParams({ enterpriseId: String(enterprise.id), titleCode: title, direction: scope.direction }))
    expect(readback.status).toBe(200)
    const body: { current: { currentQualification: unknown } } = await readback.json()
    expect(body.current.currentQualification).toEqual(qualification)
  }
})
afterAll(async () => {
  await client.close(); await sdk.close()
  if (server) await new Promise<void>(resolve => server.close(() => resolve()))
  await enterpriseReads.close(); db.$client.close(); vi.unstubAllGlobals(); rmSync(dir, { recursive: true, force: true })
})
// Current publication governs even expired/failed cycles. v1 remains explicit below.
const retainedGiant = ['unknown-review-date', 'later-review-result-unknown']
const positiveFor = (title: string) => title === 'little_giant'
  ? ['settled-history-explicit-reaward', 'unknown-review-date', 'later-review-result-unknown', 'formal-reaward-positive-control']
  : ['formal-reaward-positive-control']
const negativeFor = (title: string) => title === 'little_giant'
  ? ['failed-history-later-explicit-reaward', 'same-year-failure-reaward', 'failed-history-interval-only']
  : ['settled-history-explicit-reaward', 'failed-history-later-explicit-reaward', 'same-year-failure-reaward', 'unknown-review-date', 'failed-history-interval-only', 'later-review-result-unknown']
function supportingTitles(title: typeof titles[number]) {
  return title === 'little_giant' ? ['little_giant'] : title === 'specialized_sme' ? ['little_giant', 'specialized_sme'] : ['little_giant', 'specialized_sme', 'innovative_sme']
}
function eligibleNames(title: typeof titles[number]) {
  return supportingTitles(title).flatMap(t => positiveFor(t).map(id => `issue305-inbound-${t}-${id}`)).sort()
}
function assertFormalQualification(result: CurrentQualifiedResult, title: typeof titles[number]) {
  expect(result).toMatchObject({ total: eligibleNames(title).length, uncertainTotal: 0, responseVersion: 'current-qualified-478-v2', publishedPending: { rows: [], total: 0 } })
  expect(result.rows.map(row => row.enterpriseId).sort((a,b)=>a-b)).toEqual(eligibleNames(title).map(name=>ids.get(name)!).sort((a,b)=>a-b))
  expect(result.rows.map(row => row.name).sort()).toEqual(eligibleNames(title))
  for (const row of result.rows) {
    const own = row.name.includes(`-${title}-`)
    expect(row.firstYear).toBe(own ? 2020 : null)
  }
}
it.each(titles)('uses publication over manual and interface periods with downward inheritance over HTTP for %s', async title => {
  const response = await fetch(base + '/api/roster/current-enterprises?' + new URLSearchParams({ titleCode: title, pageSize: '200' }))
  expect(response.status, await response.clone().text()).toBe(200)
  assertFormalQualification(await response.json(), title)
})
it.each(titles)('uses publication over manual and interface periods with downward inheritance over SDK MCP for %s', async title => {
  const response = await client.callTool({ name: 'list_current_qualified_enterprises', arguments: { titleCode: title, pageSize: 200 } })
  expect(response.isError).not.toBe(true)
  const content = response.content
  if (!Array.isArray(content) || content[0]?.type !== 'text') throw new Error('Expected MCP text result')
  assertFormalQualification(JSON.parse(content[0].text), title)
})
it.each(titles)('preserves literal five sheet identity partitions and local history in XLSX for %s', async title => {
  const file = join(dir, `issue305-inbound-${title}.xlsx`)
  const result = await writeCurrentWorkbook(db.$client, title, file, () => {})
  const count = eligibleNames(title).length
  expect(result.counts).toEqual({ eligible: count, pending: 0, excluded: 7 * supportingTitles(title).length - count })
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.readFile(file)
  const partitions = { '有效企业': eligibleNames(title), '已到期': negativeFor(title).map(id=>`issue305-inbound-${title}-${id}`).sort(), '已注销（吊销）': [], '已迁出': [], '未认定': supportingTitles(title).filter(t=>t!==title).flatMap(t=>negativeFor(t).map(id=>`issue305-inbound-${t}-${id}`)).sort() }
  for (const [sheet, expected] of Object.entries(partitions)) {
    const actual: string[] = []
    workbook.getWorksheet(sheet)!.eachRow((row, index) => {
      if (index === 1) return
      const name = row.getCell(2).text
      actual.push(name)
      expect(row.getCell(3).text).toBe(codes.get(name))
      if (name.includes(`-${title}-`)) {
        expect(row.getCell(6).text).toBe('2020')
        expect(row.getCell(7).text).toContain('2020年')
      } else {
        expect(row.getCell(6).text).toBe('')
        expect(row.getCell(7).text).toBe('')
      }
    })
    expect(actual.sort()).toEqual(expected)
  }
})
it('keeps retained giant awards and failed publication independent of manual and interface periods', async () => {
  for (const c of cases) {
    const id = ids.get(`issue305-inbound-little_giant-${c.id}`)!
    const response = await fetch(base + `/api/roster/enterprises/${id}`)
    expect(response.status).toBe(200)
    const detail = await response.json()
    const giant = detail.qualificationAssessment.titles.find((t: any) => t.titleCode === 'little_giant')
    const presentation = giant.effectiveQualification.presentationBasis.join(' ')
    expect(presentation).not.toContain('Synthetic independently verified external qualification')
    expect(giant.effectiveQualification).not.toHaveProperty('source')
    expect(giant.effectiveQualification.status).toBe(positiveFor('little_giant').includes(c.id) ? 'effective' : 'expired')
    if (retainedGiant.includes(c.id) || c.formalAward) {
      expect(giant).toMatchObject({ group: 'eligible', effectiveQualification: { status: 'effective' } })
      expect(presentation).toContain('不按认定年龄自动到期')
    }
    if (c.formalAward) {
      // The same-year local reaward is the supporting formal qualification;
      // the separately recorded inbound interval cannot supersede it.
      expect(giant.evidence.map((e: any) => ({ eventType: e.eventType, year: e.year, batchSeq: e.batchSeq })))
        .toEqual([{ eventType: 'award', year: 2020, batchSeq: 1 }, { eventType: 'award', year: reawardYear, batchSeq: 1 }])
      expect(giant.sourceVersions.map((source: any) => source.sourceFile))
        .toEqual(['issue305/inbound-history.pdf', 'issue305/inbound-history.pdf'])
    }
  }
})
it('preserves reviewed inbound historical outcomes through the explicit v1 compatibility reader', () => {
  const read = createCurrentCandidateReader(db.$client)
  for (const title of titles) for (const c of cases) {
    const id = ids.get(`issue305-inbound-${title}-${c.id}`)!
    const row = read(id, title, year, Date.now(), undefined, false, true, { assessmentVersion: 'enterprise-qualification-407-v1' })
    expect(row.group, `${title}/${c.id}`).toBe(c.eligible ? 'eligible' : 'pending')
    expect(row.firstYear).toBe(2020)
  }
})
it('incomplete typed fact and legacy termination cannot cancel a retained original giant award', async () => {
 const id = ids.values().next().value!
 const scope = {enterpriseId:id,titleCode:'little_giant',direction:'extra_in_miit'}
 const cur = await (await fetch(base+'/api/roster/decision-lifecycle/current?'+new URLSearchParams({...scope,enterpriseId:String(id)}))).json()
 const r=await post({...scope,action:'replace',expectedCurrentId:cur.current.id,idempotencyKey:'probe-terminate',actor,basis:'Verified termination',ruleVersion:'probe',effectiveAt:'2024-01-01T00:00:00Z',decision:{status:'confirmed_reason',reasonCode:'deregistered',measureCode:'none',verificationStatus:'confirmed'}})
 const token=readEvidenceToken113(db,scope as any)
 await post({...scope,action:'maintain',expectedCurrentId:r.versionId,idempotencyKey:'probe-maintain',actor,basis:'Verified termination',ruleVersion:'probe',effectiveAt:'2024-01-01T00:00:00Z',reviewedEvidence:{latestRevisionId:token.latestRevisionId,projectionReady:token.projectionReady}})
 const read=async()=> (await (await fetch(base+`/api/roster/enterprises/${id}`)).json()).qualificationAssessment.titles.find((t:any)=>t.titleCode==='little_giant')
 expect(await read()).toMatchObject({group:'eligible',effectiveQualification:{status:'effective'}})
 const {getEnterpriseFacts,preflightEnterpriseFact,commitEnterpriseFact}=await import('../../../layers/sme-roster/server/utils/enterprise-facts')
 const request={action:'assert',expectedVersion:getEnterpriseFacts(db,id).version,idempotencyKey:'probe-pending',actor,basis:'Unknown registration observation',fact:{kind:'registration_status',source:{reference:'probe',statement:'Unknown'},observed:{precision:'year',value:'2024'},effective:{precision:'unknown',value:null},city:null}}
 const plan=preflightEnterpriseFact(db,id,request)
 commitEnterpriseFact(db,id,{request,planHash:plan.planHash})
 expect(await read(), JSON.stringify(await read())).toMatchObject({group:'eligible',effectiveQualification:{status:'effective'}})
})
