import { syntheticRecognizedQuery } from '../fixtures/recognized-source'
import { listPostgresCurrentQualified } from '../../../layers/sme-roster/lib/roster/current-qualified-query-postgres'
import { readPostgresCurrentQualification, readPostgresCurrentDetailBatch, readPostgresCurrentStatusBatch } from '../../../layers/sme-roster/lib/roster/current-qualification-postgres'
import { closePostgresDirectoryDb, usePostgresDirectoryDb } from '../../../db/postgresql/client'
import { enterprise } from '../../../db/postgresql/enterprise-tables'
import { enterpriseFactRevision } from '../../../db/postgresql/qualification-tables'
import { differenceReason } from '../../../db/postgresql/roster-selection-tables'
import { evidenceReviewReceipt114 } from '../official-evidence/fixtures/evidence-review-receipt-table'
import { platformObservationAssignment } from '../../../db/postgresql/platform-tables'
import { eq, sql } from 'drizzle-orm'
import { postgresRuntimeFixture } from '../../support/postgres-fixture.mjs'
import { seedPostgresPlatformQuery } from '../../platform/fixtures/postgres-query'
import ExcelJS from 'exceljs'
import { writePostgresCurrentWorkbook } from '../../../layers/sme-roster/lib/roster/current-workbook-postgres'
import historicalReceipts from '../../fixtures/decision-102-pre-browser-receipts.json'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as h3 from 'h3'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
const dir = mkdtempSync(join(tmpdir(), 'qualification-preflight-'))
let postgres: Awaited<ReturnType<typeof postgresRuntimeFixture>> | undefined
let db: ReturnType<typeof usePostgresDirectoryDb>
const e = { id: 1, name: '合成迁入', nameNorm: '合成迁入', usccNorm: '91330211255994457P' }
let command: ReturnType<typeof makeCommand>
function makeCommand(source: Awaited<ReturnType<typeof seedPostgresPlatformQuery>>) {
 return { enterpriseId: e.id, titleCode: 'specialized_sme', direction: 'extra_in_miit', action: 'replace', expectedCurrentId: null, idempotencyKey: 'bound-confirm', actor: { type: 'agent', id: 'synthetic' }, basis: '独立核实', ruleVersion: 'manual', effectiveAt: '2025-07-22T00:00:00Z', decision: { status: 'confirmed_reason', reasonCode: 'moved_in', measureCode: 'record_moved_in', verificationStatus: 'confirmed', evidenceQueryId: source.queryId, evidenceRelationId: source.relationIds[0], movedIn: { city: '南通' }, currentQualification: { titleCode: 'specialized_sme', awardYear: 2025, validFrom: '2025-07-22T00:00:00Z', validUntil: '2028-07-22T00:00:00Z', basis: '独立期间', publicationCheck: { status: 'not_found', scope: '宁波公布' } } } }
}
const readOptions = { isolationLevel: 'repeatable read', accessMode: 'read only' } as const
const decisions = () => db.select().from(differenceReason).orderBy(differenceReason.id)
const assignments = () => db.select().from(platformObservationAssignment)
 .orderBy(platformObservationAssignment.observationId, platformObservationAssignment.revision)
const readQualification = (id: number, asOf: number) => db.transaction(tx => readPostgresCurrentQualification(tx, id, asOf), readOptions)
const readDetailed = (id: number, asOf: number) => db.transaction(async tx =>
 (await readPostgresCurrentDetailBatch(tx, [id], 'specialized_sme', asOf)).get(id)!.snapshot, readOptions)
const readEffective = (id: number, asOf: number) => db.transaction(async tx =>
 (await readPostgresCurrentStatusBatch(tx, [id], 'specialized_sme', asOf)).get(id), readOptions)
const readCurrent = (filter: Parameters<typeof listPostgresCurrentQualified>[1]) => listPostgresCurrentQualified(db, filter)
const stamp = async () => (await db.execute(sql`
 select table_name, pg_catalog.query_to_xml(format('SELECT * FROM business.%I ORDER BY 1', table_name), true, false, '')::text as rows
 from information_schema.tables where table_schema = 'business' and table_type = 'BASE TABLE' order by table_name
`)).rows
function addFact({ fact, actor, ...row }: Omit<typeof enterpriseFactRevision.$inferInsert, 'actor' | 'fact'> & { fact: object; actor: object }) {
 return db.insert(enterpriseFactRevision).values({ ...row, fact: JSON.stringify(fact), actor: JSON.stringify(actor) })
}
let server: ReturnType<typeof createServer>, base: string
async function post(path: string, body: unknown, token = 'synthetic') {
 const r = await fetch(base + '/' + path, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }
}
beforeAll(async () => {
 postgres = await postgresRuntimeFixture({ dir })
 vi.stubEnv('NUXT_POSTGRES_DIRECTORY_URL', postgres.url)
 vi.stubEnv('NUXT_DB_READONLY', '0')
 db = usePostgresDirectoryDb()
 await db.insert(enterprise).values(e)
 const source = await seedPostgresPlatformQuery(db, { interface: 'business_list', queryKey: e.usccNorm!, rdjb: '2', titleCode: 'specialized_sme', queriedAt: '2026-11-16T00:00:00Z', status: 'success', rawResponse: '{}', relations: [{ sequenceNo: 1, relationKey: 'synthetic-record', rawFields: { id: 'synthetic-record', qymc: e.name, tyshxydm: e.usccNorm, result: 'first' }, enterpriseId: e.id, usccRaw: e.usccNorm!, nameRaw: e.name, verificationStatus: 'confirmed', matchBasis: 'uscc' }] })
 command = makeCommand(source)
 vi.stubGlobal('useRuntimeConfig', () => ({ apiToken: 'synthetic', filesDir: dir }))
 const { decisionRoute102 } = await import('../../../layers/sme-roster/server/utils/decision-lifecycle-route')
 const preflight = (await import('../../../layers/sme-roster/server/api/roster/decision-lifecycle/qualification-preflight.post')).default
 const commit = (await import('../../../layers/sme-roster/server/api/roster/decision-lifecycle/qualification-commit.post')).default
 server = createServer(h3.toNodeListener(h3.createApp().use(h3.createRouter().post('/preflight', preflight).post('/commit', commit).post('/commands', decisionRoute102('commands')).get('/current', decisionRoute102('current')))))
 await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
}, 30_000)
afterAll(async () => {
 if (server) await new Promise<void>(resolve => server.close(() => resolve()))
 await closePostgresDirectoryDb()
 postgres?.close()
 vi.unstubAllEnvs()
 vi.unstubAllGlobals()
 rmSync(dir, { recursive: true, force: true })
})
it('preflights without writes and commits a bound qualification with original replay and key conflict', async () => {
 const before = (await decisions())
 expect((await readCurrent({titleCode:'specialized_sme'})).rows).toEqual([])
 const plan = await post('preflight', command)
 expect(plan.status).toBe(200)
 expect(plan.body.qualification).toEqual(command.decision.currentQualification)
 expect(plan.body.movedIn).toEqual({ city: '南通' })
 expect((await decisions())).toEqual(before)
 const envelope = { command, planHash: plan.body.planHash }
 const saved = await post('commit', envelope)
 expect(saved.status).toBe(200)
 expect(saved.body.versionId).toBeGreaterThan(0)
 const readback = await fetch(base + '/current?' + new URLSearchParams({ enterpriseId: String(e.id), titleCode: 'specialized_sme', direction: 'extra_in_miit' }))
 expect(readback.status).toBe(200)
 expect((await readback.json()).current.currentQualification).toEqual(command.decision.currentQualification)
 for (const [instant, status] of [['2025-07-21T23:59:59.999Z', 'unrecognized'], ['2025-07-22T00:00:00Z', 'unrecognized'], ['2026-11-16T00:00:00Z', 'unrecognized'], ['2028-07-21T23:59:59.999Z', 'unrecognized'], ['2028-07-22T00:00:00Z', 'unrecognized']]) {
  const result = (await readQualification(e.id, Date.parse(instant!)))!.titles.find(t => t.titleCode === 'specialized_sme')!
  expect(result.effectiveQualification?.status, instant).toBe(status)

 }
 for (const filter of [{titleCode:'specialized_sme' as const}, {titleCode:'specialized_sme' as const,q:'91330211255994457P',recognitionFrom:'2025-01-01',recognitionTo:'2025-12-31'}]) {
  const listed = await readCurrent(filter)
  expect(listed.total).toBe(0)
  expect(listed.rows).toEqual([])
 }
 const path = join(dir,'synthetic-own-qualification.xlsx')
 await writePostgresCurrentWorkbook(db,'specialized_sme',path,()=>{})
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
  await addFact(fact)
  expect((await readQualification(e.id,Date.parse('2026-11-16T00:00:00Z')))!.titles.find(t=>t.titleCode==='specialized_sme')!.effectiveQualification?.status).toBe(status)
  await addFact({...fact,revision:2,status:'withdrawn',action:'withdraw'})
 }
 expect(await post('commit', envelope)).toEqual(saved)
 expect((await post('commit', { ...envelope, command: { ...command, basis: '不同' } })).body.error.code).toBe('idempotency_conflict')
})
it('rejects altered plans and stale heads atomically, then allows a fresh plan after withdrawal', async () => {
 const current = (await decisions()).at(-1)!
 const next = { ...command, expectedCurrentId: current.id, idempotencyKey: 'next' }
 const plan = await post('preflight', next)
 expect(plan.status).toBe(200)
 const before = (await decisions())
 expect((await post('commit', { command: next, planHash: '0'.repeat(64) })).body.error.code).toBe('stale_plan')
 expect((await decisions())).toEqual(before)
 const withdrawn = await post('commands', { ...command, action: 'withdraw', decision: undefined, expectedCurrentId: current.id, idempotencyKey: 'withdraw' })
 expect(withdrawn.status).toBe(200)
 expect((await readQualification(e.id,Date.parse('2026-11-16T00:00:00Z')))!.titles.find(t => t.titleCode === 'specialized_sme')!.effectiveQualification?.status).toBe('unrecognized')
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
 const latest = (await decisions()).at(-1)!
 const input = { ...command, expectedCurrentId: latest.id, idempotencyKey: 'source-change' }
 const plan = await post('preflight', input)
 expect(plan.status).toBe(200)
 const assignment = (await assignments())[0]!
 // Independent source owner appends a new revision while the plan is in flight.
 await db.insert(platformObservationAssignment).values({ ...assignment, revision: 2, basis: '重新核实同一归属' })
 const before = (await decisions())
 expect((await post('commit', { command: input, planHash: plan.body.planHash })).body.error.code).toBe('stale_plan')
 expect((await decisions())).toEqual(before)
 const fresh = await post('preflight', input)
 expect((await post('commit', { command: input, planHash: fresh.body.planHash })).status).toBe(200)
})
it('rejects a withdrawn fact reference and preserves the original qualification receipt', async () => {
 const fact = { enterpriseId: e.id, factId: 1, revision: 1, status: 'confirmed' as const, fact: { kind: 'moved_in', city: '南通' }, action: 'confirm', actor: { type: 'agent' as const, id: 'synthetic' }, basis: '明确迁入', createdAt: '2026-11-16T00:00:00Z' }
 await addFact(fact)
 const latest = (await decisions()).at(-1)!
 const input = { ...command, expectedCurrentId: latest.id, idempotencyKey: 'fact-change', decision: { ...command.decision, factReferences: [{ enterpriseId: e.id, factId: 1, revision: 1, kind: 'moved_in' }] } }
 const plan = await post('preflight', input)
 expect(plan.status).toBe(200)
 expect(plan.body.facts).toMatchObject([{ revision: 1, fact: { kind: 'moved_in', city: '南通' } }])
 await addFact({ ...fact, revision: 2, status: 'withdrawn', action: 'withdraw' })
 const before = (await decisions())
 expect((await post('commit', { command: input, planHash: plan.body.planHash })).body.error.code).toBe('fact_reference_mismatch')
 expect((await decisions())).toEqual(before)
})
it('recomputes referenced qualification facts in single and batched reads without writes', async () => {
 const fact = { enterpriseId: e.id, factId: 2, revision: 1, status: 'confirmed' as const, fact: { kind: 'moved_in', city: '南通' }, action: 'confirm', actor: { type: 'agent' as const, id: 'synthetic' }, basis: '明确迁入', createdAt: '2026-11-16T00:00:00Z' }
 await addFact(fact)
 const latest = (await decisions()).at(-1)!
 const input = { ...command, expectedCurrentId: latest.id, idempotencyKey: 'referenced-reader', decision: { ...command.decision, factReferences: [{ enterpriseId: e.id, factId: 2, revision: 1, kind: 'moved_in' }] } }
 const plan = await post('preflight', input)
 expect(plan.status).toBe(200)
 expect((await post('commit', { command: input, planHash: plan.body.planHash })).status).toBe(200)
 const status = async () => (await readQualification(e.id, Date.parse('2026-11-16T00:00:00Z')))!.titles.find(title => title.titleCode === 'specialized_sme')!.effectiveQualification!.status
 expect(await status()).toBe('unrecognized')
 expect((await readCurrent({titleCode:'specialized_sme'})).rows.map(row=>row.enterpriseId)).toEqual([])
 await addFact({ ...fact, revision: 2, status: 'withdrawn', action: 'withdraw' })
 const before = await stamp()
 expect(await status()).toBe('unrecognized')
 expect((await readCurrent({titleCode:'specialized_sme'})).rows).toEqual([])
 expect(await stamp()).toEqual(before)
})
it('uses the same strict MCP handlers and guarded discovery classification', async () => {
 vi.doMock('@nuxtjs/mcp-toolkit/server', () => ({ defineMcpTool: (definition: unknown) => definition }))
 const preflight = (await import('../../../layers/sme-roster/server/mcp/tools/preflight_qualification_decision')).default
 const commit = (await import('../../../layers/sme-roster/server/mcp/tools/commit_qualification_decision')).default
 expect(preflight.enabled!({ context: { mcpAuth: { writeAuthorized: false } } } as never)).toBe(false)
 expect(commit.enabled!({ context: { mcpAuth: { writeAuthorized: true } } } as never)).toBe(true)
 const latest = (await decisions()).at(-1)!
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
    await db.insert(enterprise).values({ id: command.enterpriseId, name, nameNorm: name })
    const review = 'reviewedEvidence' in command
    const [saved] = await db.insert(differenceReason).values({
      enterpriseId: command.enterpriseId, titleCode: command.titleCode, direction: 'missing_in_miit',
      status: 'needs_review', measureCode: 'manual_review', verificationStatus: 'pending',
      lifecycleAction: command.action === 'withdraw' ? 'withdraw' : 'replace',
      recordedAt: '2026-10-19T01:00:00.000Z', createdAt: '2026-10-19T01:00:00.000Z',
      ...(command.action !== 'maintain' ? { idempotencyKey: command.idempotencyKey, requestHash: hash,
        basis: command.basis, effectiveAt: command.effectiveAt } : {}),
    }).returning()
    const row = saved!
    const receipt = { versionId: row.id, currentId: command.action === 'withdraw' ? null : row.id, previousId: null, action: command.action, recordedAt: row.recordedAt,
      ...(review ? { reviewedRevisionId: 98765 } : {}) }
    if (review) {
      postgres!.psql(['-f', 'tests/roster/official-evidence/fixtures/retired-roster-tables.sql'])
      await db.insert(evidenceReviewReceipt114).values({
        idempotencyKey: command.idempotencyKey, requestHash: hash, kind: command.action,
        enterpriseId: command.enterpriseId, titleCode: command.titleCode, direction: command.direction,
        decisionId: row.id, reviewedRevisionId: 98765, actor: JSON.stringify(command.actor), basis: command.basis,
        ruleVersion: command.ruleVersion, effectiveAt: command.effectiveAt, response: JSON.stringify(receipt), recordedAt: row.recordedAt,
      })
      postgres!.psql(['-f', 'upgrade/pg/2026-11-roster-cleanup/apply.sql'])
    }
 const before = (await decisions())
 const replay = await post('commands', command)
 expect(replay.status).toBe(200)
 expect(replay.body).toEqual(receipt)
 expect((await decisions())).toEqual(before)
})
it('invalidates a pinned source plan when a new content version of that business record is captured', async () => {
 const latest = (await decisions()).filter(row => row.enterpriseId === e.id).at(-1)!
 const input = { ...command, expectedCurrentId: latest.id, idempotencyKey: 'new-content' }
 const plan = await post('preflight', input)
 expect(plan.status).toBe(200)
 expect(plan.body.source.versionId).toBeGreaterThan(0)
 await seedPostgresPlatformQuery(db, { interface: 'business_list', queryKey: e.usccNorm!, rdjb: '2', titleCode: 'specialized_sme', queriedAt: '2026-11-17T00:00:00Z', status: 'success', rawResponse: '{}', relations: [{ sequenceNo: 1, relationKey: 'synthetic-record', rawFields: { id: 'synthetic-record', qymc: e.name, tyshxydm: e.usccNorm, result: 'changed' }, enterpriseId: e.id, usccRaw: e.usccNorm!, nameRaw: e.name, verificationStatus: 'confirmed', matchBasis: 'uscc' }] })
 const before = (await decisions())
 expect((await post('commit', { command: input, planHash: plan.body.planHash })).body.error.code).toBe('stale_plan')
 expect((await decisions())).toEqual(before)
 expect((await readQualification(e.id,Date.parse('2026-11-18T00:00:00Z')))!.titles.find(t=>t.titleCode==='specialized_sme')!.effectiveQualification?.status).toBe('unrecognized')
})

it('keeps manual qualification ineffective before and after source ownership changes', async () => {
 const state = await fetch(base + '/current?' + new URLSearchParams({ enterpriseId: String(e.id), titleCode: 'specialized_sme', direction: 'extra_in_miit' })).then(r => r.json())
 const freshSource = await seedPostgresPlatformQuery(db, { interface:'business_list',queryKey:e.usccNorm!,rdjb:'2',titleCode:'specialized_sme',queriedAt:'2026-11-18T00:00:00Z',status:'success',rawResponse:'{}',relations:[{sequenceNo:1,relationKey:'synthetic-record',rawFields:{id:'synthetic-record',qymc:e.name,tyshxydm:e.usccNorm,result:'changed'},enterpriseId:e.id,usccRaw:e.usccNorm!,nameRaw:e.name,verificationStatus:'confirmed',matchBasis:'uscc'}] })
 const input = {...command,expectedCurrentId:state.versionId,idempotencyKey:'independent-source-check',decision:{...command.decision,evidenceQueryId:freshSource.queryId,evidenceRelationId:freshSource.relationIds[0]}}
 const plan = await post('preflight', input)
 expect(plan.status).toBe(200)
 expect((await post('commit',{command:input,planHash:plan.body.planHash})).status).toBe(200)
 const asOf = Date.parse('2026-11-16T00:00:00Z')
 const before = await readDetailed(e.id, asOf)
 const own = before.titles.find(t => t.titleCode === 'specialized_sme')!
 expect(own.effectiveQualification?.status).toBe('unrecognized')
 expect(before.titles.filter(t => t.titleCode !== 'specialized_sme').map(t => [t.titleCode,t.effectiveQualification?.status])).toEqual([['little_giant','unrecognized'],['innovative_sme','unrecognized']])
 const assignment = (await assignments()).at(-1)!
 await db.insert(platformObservationAssignment).values({ ...assignment, revision: assignment.revision + 1, verificationStatus: 'pending' })
 const changed = await readDetailed(e.id, asOf)
 const after = changed.titles.find(t => t.titleCode === 'specialized_sme')!
 expect(after.effectiveQualification?.status).toBe('unrecognized')
 expect(changed.titles.find(t => t.titleCode === 'innovative_sme')!.effectiveQualification?.status).toBe('unrecognized')
 // Current qualification digests source facts, not the manual assignment revision.
 expect(after.versions.decisions).toBe(own.versions.decisions)
 expect(await readEffective(e.id, asOf)).toBe('unrecognized')
})

it('uses an unassigned same-code directory period without manual qualification and recomputes invalidation', async () => {
 const [saved] = await db.insert(enterprise).values({id:2,name:'独立平台企业',nameNorm:'独立平台企业',usccNorm:'91310115MA1H7KUG93',city:'宁波市'}).returning()
 const subject = saved!
 const capture = (sfyx: string, queriedAt: string) => seedPostgresPlatformQuery(db,syntheticRecognizedQuery({rdjb:'2',queriedAt,rows:[{enterpriseId:null,raw:{id:'independent-directory',qymc:'平台原名',tyshxydm:'91310115MA1H7KUG93',rdjb:'2',rdtime:'2025-07-22',rddqrq:'2028-07-21',sfyx,szsmc:'宁波市'}}]}))
 await capture('1','2026-11-16T00:00:00Z')
 const at = (instant: string) => readQualification(subject.id,Date.parse(instant))
 for (const [instant,status] of [['2025-07-21T15:59:59Z','unrecognized'],['2025-07-21T16:00:00Z','effective'],['2028-07-21T15:59:59Z','effective'],['2028-07-21T16:00:00Z','unrecognized']] as const) {
  expect((await at(instant))!.titles.find(t=>t.titleCode==='specialized_sme')!.effectiveQualification?.status,instant).toBe(status)
 }
 expect((await at('2026-11-16T00:00:00Z'))!.titles.map(t=>[t.titleCode,t.effectiveQualification?.status])).toEqual([['little_giant','unrecognized'],['specialized_sme','effective'],['innovative_sme','effective']])
 const listed = await readCurrent({titleCode:'specialized_sme',q:'91310115MA1H7KUG93',recognitionFrom:'2025-01-01',recognitionTo:'2025-12-31'})
 expect(listed.rows.map(row=>[row.name,row.uscc,row.firstYear])).toEqual([['独立平台企业','91310115MA1H7KUG93',null]])
 expect((await readCurrent({titleCode:'specialized_sme',q:'91310115MA1H7KUG93',recognitionFrom:'2026-01-01',recognitionTo:'2026-12-31'})).rows).toEqual([])
 expect((await decisions()).filter(row=>row.enterpriseId===subject.id)).toEqual([])
 await capture('0','2026-11-17T00:00:00Z')
 const before = await stamp()
 expect((await at('2026-11-18T00:00:00Z'))!.titles.map(t=>t.effectiveQualification?.status)).toEqual(['unrecognized','unrecognized','unrecognized'])
 expect(await readEffective(subject.id, Date.parse('2026-11-18T00:00:00Z'))).toBe('unrecognized')
 expect(await stamp()).toEqual(before)
})
