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
import { enterpriseReads } from '../../../server/utils/enterprise-read'
import { readEvidenceToken113 } from '../../../server/utils/evidence-impact-113'
import { writeCurrentWorkbook } from '../../../lib/roster/current-workbook'
import { createCurrentCandidateReader } from '../../../lib/roster/current-qualification'
import type { CurrentQualifiedResult } from '../../../lib/roster/current-qualified-query'
import type { CurrentQualifiedFilter } from '../../../lib/roster/current-qualified-query'
import type { currentQualifiedFilterSchema } from '../../../server/utils/current-qualified-filter'

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
    const enterprise = db.insert(s.enterprise).values({ name, nameNorm: name, usccNorm: name, city: '宁波市' }).returning().get()
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
    const native = submitNativePlatformQuery(db, { interface: 'business_list', queryKey: name, rdjb, titleCode: title, queriedAt: new Date().toISOString(), status: 'success', rawResponse: JSON.stringify({ synthetic: name }), relations: [{ sequenceNo: 1, enterpriseId: enterprise.id, usccRaw: name, nameRaw: name, verificationStatus: 'confirmed', matchBasis: 'uscc' }] })
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
function assertFormalQualification(result: CurrentQualifiedResult, title: typeof titles[number]) {
  // This positive control has a formal new award; the other six only have legacy intervals.
  const formalId = ids.get(`issue305-inbound-${title}-formal-reaward-positive-control`)!
  expect(result).toMatchObject({ total: 1, uncertainTotal: 0, responseVersion: 'current-qualified-478-v2',
    rows: [{ enterpriseId: formalId, group: 'eligible', firstYear: 2020, recognition: { precision: 'year', year: reawardYear } }],
    publishedPending: { rows: [], total: 0 } })
  expect(result.rows.map(row => row.enterpriseId)).toEqual([formalId])
}
it.each(titles)('keeps legacy inbound intervals from reviving expired formal cycles over current HTTP for %s', async title => {
  const response = await fetch(base + '/api/roster/current-enterprises?' + new URLSearchParams({ titleCode: title, pageSize: '200' }))
  expect(response.status, await response.clone().text()).toBe(200)
  assertFormalQualification(await response.json(), title)
})
it.each(titles)('keeps legacy inbound intervals from reviving expired formal cycles over SDK MCP for %s', async title => {
  const response = await client.callTool({ name: 'list_current_qualified_enterprises', arguments: { titleCode: title, pageSize: 200 } })
  expect(response.isError).not.toBe(true)
  const content = response.content
  if (!Array.isArray(content) || content[0]?.type !== 'text') throw new Error('Expected MCP text result')
  assertFormalQualification(JSON.parse(content[0].text), title)
})
it.each(titles)('retains all six expired formal histories and first awards in current XLSX for %s', async title => {
  const file = join(dir, `issue305-inbound-${title}.xlsx`)
  const result = await writeCurrentWorkbook(db.$client, title, file, () => {})
  expect(result.counts).toEqual({ eligible: 1, pending: 0, excluded: 6 })
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.readFile(file)
  for (const sheet of ['有效企业', '已到期', '已注销（吊销）', '已迁出', '未认定'] as const) {
    const actual: string[] = []
    workbook.getWorksheet(sheet)!.eachRow((row, index) => {
      if (index === 1) return
      actual.push(row.getCell(2).text); expect(row.getCell(6).text).toBe('2020')
      expect(row.getCell(7).text).toContain('2020年')
    })
    expect(actual.sort()).toEqual(cases.filter(c => sheet === '有效企业' ? c.formalAward : sheet === '已到期' ? !c.formalAward : false).map(c => `issue305-inbound-${title}-${c.id}`).sort())
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
it('incomplete typed fact and legacy termination cannot change the expired formal status', async () => {
 const id = ids.values().next().value!
 const scope = {enterpriseId:id,titleCode:'little_giant',direction:'extra_in_miit'}
 const cur = await (await fetch(base+'/api/roster/decision-lifecycle/current?'+new URLSearchParams({...scope,enterpriseId:String(id)}))).json()
 const r=await post({...scope,action:'replace',expectedCurrentId:cur.current.id,idempotencyKey:'probe-terminate',actor,basis:'Verified termination',ruleVersion:'probe',effectiveAt:'2024-01-01T00:00:00Z',decision:{status:'confirmed_reason',reasonCode:'deregistered',measureCode:'none',verificationStatus:'confirmed'}})
 const token=readEvidenceToken113(db,scope as any)
 await post({...scope,action:'maintain',expectedCurrentId:r.versionId,idempotencyKey:'probe-maintain',actor,basis:'Verified termination',ruleVersion:'probe',effectiveAt:'2024-01-01T00:00:00Z',reviewedEvidence:{latestRevisionId:token.latestRevisionId,projectionReady:token.projectionReady}})
 const read=async()=> (await (await fetch(base+`/api/roster/enterprises/${id}`)).json()).qualificationAssessment.titles.find((t:any)=>t.titleCode==='little_giant')
 expect(await read()).toMatchObject({group:'excluded',effectiveQualification:{status:'expired'}})
 const {getEnterpriseFacts,preflightEnterpriseFact,commitEnterpriseFact}=await import('../../../server/utils/enterprise-facts')
 const request={action:'assert',expectedVersion:getEnterpriseFacts(db,id).version,idempotencyKey:'probe-pending',actor,basis:'Unknown registration observation',fact:{kind:'registration_status',source:{reference:'probe',statement:'Unknown'},observed:{precision:'year',value:'2024'},effective:{precision:'unknown',value:null},city:null}}
 const plan=preflightEnterpriseFact(db,id,request)
 commitEnterpriseFact(db,id,{request,planHash:plan.planHash})
 expect(await read(), JSON.stringify(await read())).toMatchObject({group:'excluded',effectiveQualification:{status:'expired'}})
})
