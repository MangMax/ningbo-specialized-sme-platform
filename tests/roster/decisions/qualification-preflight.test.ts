import { submitSyntheticRecognizedCollection } from '../fixtures/recognized-source'
import { createCurrentQualificationAssessmentReader } from '../../../layers/sme-roster/lib/roster/current-qualification'
import { readDistrictStatistics } from '../../../layers/sme-roster/lib/roster/district-statistics'
import { listCurrentQualified } from '../../../layers/sme-roster/lib/roster/current-qualified-query'
import ExcelJS from 'exceljs'
import { writeCurrentWorkbook } from '../../../layers/sme-roster/lib/roster/current-workbook'
import historicalReceipts from '../../fixtures/decision-102-pre-browser-receipts.json'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as h3 from 'h3'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { initializeDb, schema as s } from '../../../db/client'
import { submitNativePlatformQuery } from '../../platform/fixtures/native-query'
vi.mock('@db', () => ({ useDb: () => db }))
const dir = mkdtempSync(join(tmpdir(), 'qualification-preflight-'))
const db = initializeDb({ create: true, dbPath: join(dir, 'synthetic.sqlite') })
const e = db.insert(s.enterprise).values({ name: '合成迁入', nameNorm: '合成迁入', usccNorm: '91330211255994457P' }).returning().get()
const source = submitNativePlatformQuery(db, { interface: 'business_list', queryKey: e.usccNorm!, rdjb: '2', titleCode: 'specialized_sme', queriedAt: '2026-11-16T00:00:00Z', status: 'success', rawResponse: '{}', relations: [{ sequenceNo: 1, relationKey: 'synthetic-record', rawFields: { id: 'synthetic-record', qymc: e.name, tyshxydm: e.usccNorm, result: 'first' }, enterpriseId: e.id, usccRaw: e.usccNorm!, nameRaw: e.name, verificationStatus: 'confirmed', matchBasis: 'uscc' }] })
const command = { enterpriseId: e.id, titleCode: 'specialized_sme', direction: 'extra_in_miit', action: 'replace', expectedCurrentId: null, idempotencyKey: 'bound-confirm', actor: { type: 'agent', id: 'synthetic' }, basis: '独立核实', ruleVersion: 'manual', effectiveAt: '2025-07-22T00:00:00Z', decision: { status: 'confirmed_reason', reasonCode: 'moved_in', measureCode: 'record_moved_in', verificationStatus: 'confirmed', evidenceQueryId: source.queryId, evidenceRelationId: source.relationIds[0], movedIn: { city: '南通' }, currentQualification: { titleCode: 'specialized_sme', awardYear: 2025, validFrom: '2025-07-22T00:00:00Z', validUntil: '2028-07-22T00:00:00Z', basis: '独立期间', publicationCheck: { status: 'not_found', scope: '宁波公布' } } } }
let server: ReturnType<typeof createServer>, base: string
async function post(path: string, body: unknown, token = 'synthetic') {
 const r = await fetch(base + '/' + path, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }
}
beforeAll(async () => {
 vi.stubGlobal('useRuntimeConfig', () => ({ apiToken: 'synthetic', filesDir: dir }))
 const { decisionRoute102 } = await import('../../../server/utils/decision-lifecycle-102-route')
 const preflight = (await import('../../../server/api/roster/decision-lifecycle/qualification-preflight.post')).default
 const commit = (await import('../../../server/api/roster/decision-lifecycle/qualification-commit.post')).default
 server = createServer(h3.toNodeListener(h3.createApp().use(h3.createRouter().post('/preflight', preflight).post('/commit', commit).post('/commands', decisionRoute102('commands')).get('/current', decisionRoute102('current')))))
 await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})
afterAll(async () => { if(server) await new Promise<void>(resolve => server.close(() => resolve())); db.$client.close(); vi.unstubAllGlobals(); rmSync(dir, { recursive: true, force: true }) })
it('preflights without writes and commits a bound qualification with original replay and key conflict', async () => {
 const before = db.select().from(s.differenceReason).all()
 expect(listCurrentQualified(db.$client,{titleCode:'specialized_sme'}).rows).toEqual([])
 const compatibilityReader = createCurrentQualificationAssessmentReader(db.$client)
 const compatibilityVersions = ['enterprise-qualification-478-v3','enterprise-qualification-687-v4'] as const
 const legacyBefore = compatibilityVersions.map(assessmentVersion => compatibilityReader.read(e.id,Date.parse('2026-11-16T00:00:00Z'),{assessmentVersion}).snapshot)
 const plan = await post('preflight', command)
 expect(plan.status).toBe(200)
 expect(plan.body.qualification).toEqual(command.decision.currentQualification)
 expect(plan.body.movedIn).toEqual({ city: '南通' })
 expect(db.select().from(s.differenceReason).all()).toEqual(before)
 const envelope = { command, planHash: plan.body.planHash }
 const saved = await post('commit', envelope)
 expect(saved.status).toBe(200)
 expect(saved.body.versionId).toBeGreaterThan(0)
 for (const [index,assessmentVersion] of compatibilityVersions.entries()) {
  const after = compatibilityReader.read(e.id,Date.parse('2026-11-16T00:00:00Z'),{assessmentVersion}).snapshot
  expect(after).toEqual(legacyBefore[index])
  expect(after.titles.map(t=>t.group)).toEqual(['excluded','excluded','excluded'])
 }
 const readback = await fetch(base + '/current?' + new URLSearchParams({ enterpriseId: String(e.id), titleCode: 'specialized_sme', direction: 'extra_in_miit' }))
 expect(readback.status).toBe(200)
 expect((await readback.json()).current.currentQualification).toEqual(command.decision.currentQualification)
 const reader = createCurrentQualificationAssessmentReader(db.$client)
 for (const [instant, status] of [['2025-07-21T23:59:59.999Z', 'unrecognized'], ['2025-07-22T00:00:00Z', 'unrecognized'], ['2026-11-16T00:00:00Z', 'unrecognized'], ['2028-07-21T23:59:59.999Z', 'unrecognized'], ['2028-07-22T00:00:00Z', 'unrecognized']]) {
  const result = reader.read(e.id, Date.parse(instant!)).snapshot.titles.find(t => t.titleCode === 'specialized_sme')!
  expect(result.effectiveQualification?.status, instant).toBe(status)

 }
 for (const filter of [{titleCode:'specialized_sme' as const}, {titleCode:'specialized_sme' as const,q:'91330211255994457P',recognitionFrom:'2025-01-01',recognitionTo:'2025-12-31'}]) {
  const listed = listCurrentQualified(db.$client,filter)
  expect(listed.total).toBe(0)
  expect(listed.rows).toEqual([])
 }
 const stats = readDistrictStatistics(db, { title:'specialized_sme',page:1,pageSize:25 }, Date.parse('2026-11-16T00:00:00Z'))
 expect(stats.total).toBe(0)
 expect(stats.rows).toEqual([])
 const path = join(dir,'synthetic-own-qualification.xlsx')
 await writeCurrentWorkbook(db.$client,'specialized_sme',path,()=>{})
 const workbook = new ExcelJS.Workbook(); await workbook.xlsx.readFile(path)
 expect(workbook.getWorksheet('有效企业')!.rowCount).toBe(1)
 const sheet = workbook.getWorksheet('未认定')!
 expect(sheet.rowCount).toBe(2)
 expect(sheet.getRow(2).getCell(2).value).toBe('合成迁入')
 expect(sheet.getRow(2).getCell(3).value).toBe('91330211255994457P')
 expect(sheet.getRow(2).getCell(6).value).toBeNull()
 expect(String(sheet.getRow(2).getCell(7).value)).not.toContain('独立期间')
 for (const [index,kind,status] of [[0,'cancelled','terminated'],[1,'moved_out','moved_out']] as const) {
  const fact = {enterpriseId:e.id,factId:9000+index,revision:1,status:'confirmed' as const,fact:{kind,source:{reference:'synthetic.pdf',statement:'合成明确主体事实'},effective:{precision:'day',value:'2026-01-01'},observed:{precision:'day',value:'2026-01-01'}},action:'assert',actor:{type:'agent' as const,id:'synthetic'},basis:'合成核实',createdAt:'2026-01-01T00:00:00Z'}
  db.insert(s.enterpriseFactRevision).values(fact).run()
  expect(reader.read(e.id,Date.parse('2026-11-16T00:00:00Z')).snapshot.titles.find(t=>t.titleCode==='specialized_sme')!.effectiveQualification?.status).toBe(status)
  db.insert(s.enterpriseFactRevision).values({...fact,revision:2,status:'withdrawn',action:'withdraw'}).run()
 }
 expect(await post('commit', envelope)).toEqual(saved)
 expect((await post('commit', { ...envelope, command: { ...command, basis: '不同' } })).body.error.code).toBe('idempotency_conflict')
})
it('rejects altered plans and stale heads atomically, then allows a fresh plan after withdrawal', async () => {
 const current = db.select().from(s.differenceReason).all().at(-1)!
 const next = { ...command, expectedCurrentId: current.id, idempotencyKey: 'next' }
 const plan = await post('preflight', next)
 expect(plan.status).toBe(200)
 const before = db.select().from(s.differenceReason).all()
 expect((await post('commit', { command: next, planHash: '0'.repeat(64) })).body.error.code).toBe('stale_plan')
 expect(db.select().from(s.differenceReason).all()).toEqual(before)
 const withdrawn = await post('commands', { ...command, action: 'withdraw', decision: undefined, expectedCurrentId: current.id, idempotencyKey: 'withdraw' })
 expect(withdrawn.status).toBe(200)
 expect(createCurrentQualificationAssessmentReader(db.$client).read(e.id, Date.parse('2026-11-16T00:00:00Z')).snapshot.titles.find(t => t.titleCode === 'specialized_sme')!.effectiveQualification?.status).toBe('unrecognized')
 expect((await post('commit', { command: next, planHash: plan.body.planHash })).body.error.code).toBe('stale_version')
 const retry = { ...next, expectedCurrentId: withdrawn.body.versionId }
 const fresh = await post('preflight', retry)
 expect((await post('commit', { command: retry, planHash: fresh.body.planHash })).status).toBe(200)
})
it('requires authorization and rejects unknown envelope and command fields', async () => {
 expect((await post('preflight', command, '')).status).toBe(401)
 expect((await post('commit', { command, planHash: '0'.repeat(64), extra: true })).status).toBe(400)
 expect((await post('preflight', { ...command, extra: true })).status).toBe(400)
})
it('rejects changed source assignment revisions without partial writes', async () => {
 const latest = db.select().from(s.differenceReason).all().at(-1)!
 const input = { ...command, expectedCurrentId: latest.id, idempotencyKey: 'source-change' }
 const plan = await post('preflight', input)
 expect(plan.status).toBe(200)
 const assignment = db.select().from(s.platformObservationAssignment).all()[0]!
 // Independent source owner appends a new revision while the plan is in flight.
 db.insert(s.platformObservationAssignment).values({ ...assignment, revision: 2, basis: '重新核实同一归属' }).run()
 const before = db.select().from(s.differenceReason).all()
 expect((await post('commit', { command: input, planHash: plan.body.planHash })).body.error.code).toBe('stale_plan')
 expect(db.select().from(s.differenceReason).all()).toEqual(before)
 const fresh = await post('preflight', input)
 expect((await post('commit', { command: input, planHash: fresh.body.planHash })).status).toBe(200)
})
it('rejects a withdrawn fact reference and preserves the original qualification receipt', async () => {
 const fact = { enterpriseId: e.id, factId: 1, revision: 1, status: 'confirmed' as const, fact: { kind: 'moved_in', city: '南通' }, action: 'confirm', actor: { type: 'agent' as const, id: 'synthetic' }, basis: '明确迁入', createdAt: '2026-11-16T00:00:00Z' }
 db.insert(s.enterpriseFactRevision).values(fact).run()
 const latest = db.select().from(s.differenceReason).all().at(-1)!
 const input = { ...command, expectedCurrentId: latest.id, idempotencyKey: 'fact-change', decision: { ...command.decision, factReferences: [{ enterpriseId: e.id, factId: 1, revision: 1, kind: 'moved_in' }] } }
 const plan = await post('preflight', input)
 expect(plan.status).toBe(200)
 expect(plan.body.facts).toMatchObject([{ revision: 1, fact: { kind: 'moved_in', city: '南通' } }])
 db.insert(s.enterpriseFactRevision).values({ ...fact, revision: 2, status: 'withdrawn', action: 'withdraw' }).run()
 const before = db.select().from(s.differenceReason).all()
 expect((await post('commit', { command: input, planHash: plan.body.planHash })).body.error.code).toBe('fact_reference_mismatch')
 expect(db.select().from(s.differenceReason).all()).toEqual(before)
})
it('recomputes referenced qualification facts in single and batched reads without writes', async () => {
 const fact = { enterpriseId: e.id, factId: 2, revision: 1, status: 'confirmed' as const, fact: { kind: 'moved_in', city: '南通' }, action: 'confirm', actor: { type: 'agent' as const, id: 'synthetic' }, basis: '明确迁入', createdAt: '2026-11-16T00:00:00Z' }
 db.insert(s.enterpriseFactRevision).values(fact).run()
 const latest = db.select().from(s.differenceReason).all().at(-1)!
 const input = { ...command, expectedCurrentId: latest.id, idempotencyKey: 'referenced-reader', decision: { ...command.decision, factReferences: [{ enterpriseId: e.id, factId: 2, revision: 1, kind: 'moved_in' }] } }
 const plan = await post('preflight', input)
 expect(plan.status).toBe(200)
 expect((await post('commit', { command: input, planHash: plan.body.planHash })).status).toBe(200)
 const reader = createCurrentQualificationAssessmentReader(db.$client)
 const status = () => reader.read(e.id, Date.parse('2026-11-16T00:00:00Z')).snapshot.titles.find(title => title.titleCode === 'specialized_sme')!.effectiveQualification!.status
 expect(status()).toBe('unrecognized')
 expect(listCurrentQualified(db.$client,{titleCode:'specialized_sme'}).rows.map(row=>row.enterpriseId)).toEqual([])
 db.insert(s.enterpriseFactRevision).values({ ...fact, revision: 2, status: 'withdrawn', action: 'withdraw' }).run()
 const before = db.$client.serialize()
 expect(status()).toBe('unrecognized')
 expect(listCurrentQualified(db.$client,{titleCode:'specialized_sme'}).rows).toEqual([])
 expect(db.$client.serialize()).toEqual(before)
})
it('uses the same strict MCP handlers and guarded discovery classification', async () => {
 vi.doMock('@nuxtjs/mcp-toolkit/server', () => ({ defineMcpTool: (definition: unknown) => definition }))
 const preflight = (await import('../../../server/mcp/tools/preflight_qualification_decision')).default
 const commit = (await import('../../../server/mcp/tools/commit_qualification_decision')).default
 expect(preflight.enabled!({ context: { mcpAuth: { writeAuthorized: false } } } as never)).toBe(false)
 expect(commit.enabled!({ context: { mcpAuth: { writeAuthorized: true } } } as never)).toBe(true)
 const latest = db.select().from(s.differenceReason).all().at(-1)!
 const input = { ...command, expectedCurrentId: latest.id, idempotencyKey: 'mcp-confirm' }
 const plan = await preflight.handler(input as never, {} as never) as any
 expect(plan.qualification).toEqual(command.decision.currentQualification)
 const saved = await commit.handler({ command: input, planHash: plan.planHash } as never, {} as never)
 expect(saved).toMatchObject({ versionId: expect.any(Number) })
 expect((await post('commit', { command: input, planHash: plan.planHash })).body).toEqual(saved)
 const invalid = await commit.handler({ command: input, planHash: plan.planHash, extra: true } as never, {} as never) as any
 expect(invalid.isError).toBe(true)
 expect(JSON.parse(invalid.content[0].text).error.code).toBe('invalid_request')
})

it.each(historicalReceipts.fixtures)('preserves frozen legacy hash and original receipt: $name', async ({ name, command, hash }) => {
    db.insert(s.enterprise).values({ id: command.enterpriseId, name, nameNorm: name }).run()
    const review = 'reviewedEvidence' in command
    const row = db.insert(s.differenceReason).values({
      enterpriseId: command.enterpriseId, titleCode: command.titleCode, direction: 'missing_in_miit',
      status: 'needs_review', measureCode: 'manual_review', verificationStatus: 'pending',
      lifecycleAction: command.action === 'withdraw' ? 'withdraw' : 'replace',
      recordedAt: '2026-10-19T01:00:00.000Z',
      ...(!review ? { idempotencyKey: command.idempotencyKey, requestHash: hash } : {}),
    }).returning().get()
    const receipt = { versionId: row.id, currentId: command.action === 'withdraw' ? null : row.id, previousId: null, action: command.action, recordedAt: row.recordedAt,
      ...(review ? { reviewedRevisionId: 98765 } : {}) }
    if (review) db.insert(s.evidenceReviewReceipt114).values({
      idempotencyKey: command.idempotencyKey, requestHash: hash, kind: command.action,
      enterpriseId: command.enterpriseId, titleCode: command.titleCode, direction: command.direction,
      decisionId: row.id, reviewedRevisionId: 98765, actor: command.actor as { type: 'agent'; id: string }, basis: command.basis,
      ruleVersion: command.ruleVersion, effectiveAt: command.effectiveAt, response: receipt, recordedAt: row.recordedAt,
    }).run()
 const before = db.select().from(s.differenceReason).all()
 const replay = await post('commands', command)
 expect(replay.status).toBe(200)
 expect(replay.body).toEqual(receipt)
 expect(db.select().from(s.differenceReason).all()).toEqual(before)
})
it('invalidates a pinned source plan when a new content version of that business record is captured', async () => {
 const latest = db.select().from(s.differenceReason).all().filter(row => row.enterpriseId === e.id).at(-1)!
 const input = { ...command, expectedCurrentId: latest.id, idempotencyKey: 'new-content' }
 const plan = await post('preflight', input)
 expect(plan.status).toBe(200)
 expect(plan.body.source.versionId).toBeGreaterThan(0)
 submitNativePlatformQuery(db, { interface: 'business_list', queryKey: e.usccNorm!, rdjb: '2', titleCode: 'specialized_sme', queriedAt: '2026-11-17T00:00:00Z', status: 'success', rawResponse: '{}', relations: [{ sequenceNo: 1, relationKey: 'synthetic-record', rawFields: { id: 'synthetic-record', qymc: e.name, tyshxydm: e.usccNorm, result: 'changed' }, enterpriseId: e.id, usccRaw: e.usccNorm!, nameRaw: e.name, verificationStatus: 'confirmed', matchBasis: 'uscc' }] })
 const before = db.select().from(s.differenceReason).all()
 expect((await post('commit', { command: input, planHash: plan.body.planHash })).body.error.code).toBe('stale_plan')
 expect(db.select().from(s.differenceReason).all()).toEqual(before)
 expect(createCurrentQualificationAssessmentReader(db.$client).read(e.id,Date.parse('2026-11-18T00:00:00Z')).snapshot.titles.find(t=>t.titleCode==='specialized_sme')!.effectiveQualification?.status).toBe('unrecognized')
})

it('keeps manual qualification ineffective before and after source ownership changes', async () => {
 const state = await fetch(base + '/current?' + new URLSearchParams({ enterpriseId: String(e.id), titleCode: 'specialized_sme', direction: 'extra_in_miit' })).then(r => r.json())
 const freshSource = submitNativePlatformQuery(db, { interface:'business_list',queryKey:e.usccNorm!,rdjb:'2',titleCode:'specialized_sme',queriedAt:'2026-11-18T00:00:00Z',status:'success',rawResponse:'{}',relations:[{sequenceNo:1,relationKey:'synthetic-record',rawFields:{id:'synthetic-record',qymc:e.name,tyshxydm:e.usccNorm,result:'changed'},enterpriseId:e.id,usccRaw:e.usccNorm!,nameRaw:e.name,verificationStatus:'confirmed',matchBasis:'uscc'}] })
 const input = {...command,expectedCurrentId:state.versionId,idempotencyKey:'independent-source-check',decision:{...command.decision,evidenceQueryId:freshSource.queryId,evidenceRelationId:freshSource.relationIds[0]}}
 const plan = await post('preflight', input)
 expect(plan.status).toBe(200)
 expect((await post('commit',{command:input,planHash:plan.body.planHash})).status).toBe(200)
 const reader = createCurrentQualificationAssessmentReader(db.$client)
 const asOf = Date.parse('2026-11-16T00:00:00Z')
 const before = reader.read(e.id, asOf).snapshot
 const own = before.titles.find(t => t.titleCode === 'specialized_sme')!
 expect(own.effectiveQualification?.status).toBe('unrecognized')
 expect(before.titles.filter(t => t.titleCode !== 'specialized_sme').map(t => [t.titleCode,t.effectiveQualification?.status])).toEqual([['little_giant','unrecognized'],['innovative_sme','unrecognized']])
 const assignment = db.select().from(s.platformObservationAssignment).all().at(-1)!
 db.insert(s.platformObservationAssignment).values({ ...assignment, revision: assignment.revision + 1, verificationStatus: 'pending' }).run()
 const changed = reader.read(e.id, asOf).snapshot
 const after = changed.titles.find(t => t.titleCode === 'specialized_sme')!
 expect(after.effectiveQualification?.status).toBe('unrecognized')
 expect(changed.titles.find(t => t.titleCode === 'innovative_sme')!.effectiveQualification?.status).toBe('unrecognized')
 // Current qualification digests source facts, not the manual assignment revision.
 expect(after.versions.decisions).toBe(own.versions.decisions)
 expect(db.transaction(() => reader.readEffectiveTitles([e.id], asOf, 'specialized_sme').get(e.id))).toBe('unrecognized')
})

it('uses an unassigned same-code directory period without manual qualification and recomputes invalidation', () => {
 const enterprise = db.insert(s.enterprise).values({name:'独立平台企业',nameNorm:'独立平台企业',usccNorm:'91310115MA1H7KUG93',city:'宁波市'}).returning().get()
 const capture = (sfyx: string, queriedAt: string) => submitSyntheticRecognizedCollection(db,{rdjb:'2',queriedAt,rows:[{enterpriseId:null,raw:{id:'independent-directory',qymc:'平台原名',tyshxydm:'91310115MA1H7KUG93',rdjb:'2',rdtime:'2025-07-22',rddqrq:'2028-07-21',sfyx,szsmc:'宁波市'}}]})
 capture('1','2026-11-16T00:00:00Z')
 const reader = createCurrentQualificationAssessmentReader(db.$client)
 const at = (instant: string) => reader.read(enterprise.id,Date.parse(instant)).snapshot
 for (const [instant,status] of [['2025-07-21T15:59:59Z','unrecognized'],['2025-07-21T16:00:00Z','effective'],['2028-07-21T15:59:59Z','effective'],['2028-07-21T16:00:00Z','unrecognized']] as const) {
  expect(at(instant).titles.find(t=>t.titleCode==='specialized_sme')!.effectiveQualification?.status,instant).toBe(status)
 }
 expect(at('2026-11-16T00:00:00Z').titles.map(t=>[t.titleCode,t.effectiveQualification?.status])).toEqual([['little_giant','unrecognized'],['specialized_sme','effective'],['innovative_sme','effective']])
 const listed = listCurrentQualified(db.$client,{titleCode:'specialized_sme',q:'91310115MA1H7KUG93',recognitionFrom:'2025-01-01',recognitionTo:'2025-12-31'})
 expect(listed.rows.map(row=>[row.name,row.uscc,row.firstYear])).toEqual([['独立平台企业','91310115MA1H7KUG93',null]])
 expect(listCurrentQualified(db.$client,{titleCode:'specialized_sme',q:'91310115MA1H7KUG93',recognitionFrom:'2026-01-01',recognitionTo:'2026-12-31'}).rows).toEqual([])
 expect(db.select().from(s.differenceReason).all().filter(row=>row.enterpriseId===enterprise.id)).toEqual([])
 capture('0','2026-11-17T00:00:00Z')
 const before = db.$client.serialize()
 expect(at('2026-11-18T00:00:00Z').titles.map(t=>t.effectiveQualification?.status)).toEqual(['unrecognized','unrecognized','unrecognized'])
 expect(db.transaction(()=>reader.readEffectiveTitles([enterprise.id],Date.parse('2026-11-18T00:00:00Z'),'specialized_sme').get(enterprise.id))).toBe('unrecognized')
 expect(db.$client.serialize()).toEqual(before)
})
