import { spawnCompiledApp } from '../../support/owned-process.mjs'
import { submitNativePlatformQuery } from '../fixtures/native-query'
import type { RosterImportPlatformQuery } from '../../../lib/roster-import-client'
import { assertEnterpriseDetailSnapshotEqual } from '../../roster/assertions/enterprise-detail-snapshot'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterAll, beforeAll, expect, it } from 'vitest'
import { initializeDb, schema } from '../../../db/client'
import { spawnOwnedChild as spawn, reserveLoopbackPort, waitForHttp, stopOwnedChild } from '../../support/owned-process.mjs'

const dir = mkdtempSync(join(tmpdir(), 'coverage109-'))
const path = join(dir, 'roster.db')
const db = initializeDb({ create: true,  dbPath: path })
let base: string, stop: () => Promise<void>
let sequence = 0
function company() {
  const n = ++sequence
  const e = db.insert(schema.enterprise).values({ name: `合成覆盖${n}`, nameNorm: `合成覆盖${n}`, usccNorm: `913300000000${String(n).padStart(6, '0')}` }).returning().get()
  db.insert(schema.record).values({ enterpriseId: e.id, source: 'jxj', titleCode: 'specialized_sme' }).run()
  return e
}
beforeAll(async () => {
  const cwd = resolve(import.meta.dirname, '../../..'), port = await reserveLoopbackPort()
  const child = spawnCompiledApp(port, {
    cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NUXT_BUILD_DIR: join(dir, 'build'), NUXT_DB_PATH: path, NUXT_FILES_DIR: join(dir, 'files'), NUXT_INCOMING_DIR: join(dir, 'incoming'), NUXT_API_TOKEN: 'synthetic-http109', NUXT_MCP_TOKEN: 'synthetic-mcp109' },
  })
  let output = ''
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { output = (output + data).slice(-8000) })
  base = `http://127.0.0.1:${port}`; stop = () => stopOwnedChild(child)
  try { await waitForHttp(`${base}/api/roster/differences`, { timeoutMs: 60000, child }) }
  catch (error) { await stop(); throw new Error(`${error}\n${output}`) }
}, 90000)
afterAll(async () => { if (stop) await stop(); db.$client.close(); rmSync(dir, { recursive: true, force: true }) })
async function get(url: string) {
  const response = await fetch(base + url)
  expect(response.status).toBe(200)
  return response.json()
}
async function mcp(name: string, args: Record<string, unknown>) {
  const response = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) })
  expect(response.status).toBe(200)
  expect(response.headers.get('cache-control')).toContain('no-store')
  const raw = await response.text()
  const rpc = JSON.parse(raw.startsWith('event:') ? raw.split('\n').find(line => line.startsWith('data: '))!.slice(6) : raw)
  expect(rpc.result.isError).not.toBe(true)
  return JSON.parse(rpc.result.content[0].text)
}
const scope = (e: { id: number }) => ({ enterpriseId: e.id, titleCode: 'specialized_sme', direction: 'missing_in_miit' })
const assessment = (detail: any, title = 'specialized_sme', direction = 'missing_in_miit') => detail.titleAssessments.find((r: any) => r.titleCode === title && r.direction === direction)

it('empty reads and unqueried coordinates retain legacy status and expose independent absent decisions over HTTP and MCP', async () => {
  expect(await get('/api/roster/differences')).toMatchObject({ total: 0, rows: [] })
  const e = company()
  const detail = await get(`/api/roster/enterprises/${e.id}`)
  expect(detail.differences[0]).toMatchObject({ status: 'not_queried', explanationId: null, assessment: 'not_queried', queryCoverage: { status: 'not_queried', sources: [], truncated: false }, currentDecision: { ...scope(e), versionId: null, current: null }, explanationValidity: { status: 'not_applicable', reasons: [], explanationId: null, evidenceQueryIds: [] } })
  expect(assessment(detail)).toMatchObject({ assessment: 'not_queried' })
  assertEnterpriseDetailSnapshotEqual(await mcp('get_enterprise_detail', { enterpriseId: e.id }), detail)
})

function query(e: ReturnType<typeof company>, changes: Partial<RosterImportPlatformQuery> = {}, evidenceChanges: Record<string, unknown> = {}) {
  const input: RosterImportPlatformQuery = { interface: 'business_list', queryKey: e.usccNorm!, rdjb: '2', titleCode: 'specialized_sme', queriedAt: new Date(Date.UTC(2026, 9, 19, 10, 0, ++sequence)).toISOString(), status: 'no_record', rawResponse: 'PRIVATE_RAW_109', collectionEvidence: {
    source: 'businessList', status: 'no_record', effectiveConditions: { uscc: e.usccNorm!, combination: 'and' }, titleScope: { mode: 'selected', rdjb: ['2'] }, queriedAt: '2026-10-19T10:00:00Z', completedAt: '2026-10-19T10:00:01Z', rows: [], dataRows: [], pages: [{ source: 'businessList', rdjb: '2', page: 1, status: 'success', fetchedCount: 0, declaredTotal: 0, error: null }], fetchedCount: 0, declaredTotal: 0, completeness: 'complete', fullRange: true, unfinished: [], error: null, limits: { pageSize: 50, maxRequests: 100, maxRows: 5000, maxDurationMs: 60000 }, ...evidenceChanges,
  } as never, ...changes }
  if (input.collectionEvidence) {
    input.collectionEvidence.queriedAt = input.queriedAt
    input.collectionEvidence.completedAt = new Date(Date.parse(input.queriedAt) + 1000).toISOString()
    for (const page of input.collectionEvidence.pages) page.source = input.collectionEvidence.source
    if (input.collectionEvidence.source === 'queryBusList') delete input.collectionEvidence.dataRows
  }
  const native = submitNativePlatformQuery(db, input)
  return { id: native.queryId, relationIds: native.relationIds }
}
it('complete exact-title coverage reports queried unjudged while preserving the legacy not queried field', async () => {
  const e = company(), q = query(e)
  const detail = await get(`/api/roster/enterprises/${e.id}`)
  expect(assessment(detail)).toMatchObject({ assessment: 'queried_unjudged', currentDecision: { current: null }, queryCoverage: { status: 'complete', sources: [{ queryId: q.id, interface: 'business_list', status: 'complete', outcome: 'no_record', subjectMatch: 'exact_uscc' }] } })
  expect(detail.differences[0]).toMatchObject({ status: 'not_queried', reasonCode: null, explanationId: null, assessment: 'queried_unjudged' })
  expect(assessment(detail, 'little_giant')).toMatchObject({ queryCoverage: { status: 'not_queried' } })
  assertEnterpriseDetailSnapshotEqual(await mcp('get_enterprise_detail', { enterpriseId: e.id }), detail)
})

it('old missing-code explanation becomes premise invalid without changing its ID reason or evidence across REST and MCP', async () => {
  const e = company()
  const reason = db.insert(schema.differenceReason).values({ ...scope(e), direction: 'missing_in_miit', status: 'not_queried', reasonNote: '缺代码无法查询', recordedAt: '2026-10-18T00:00:00Z' }).returning().get()
  const q = query(e, { status: 'partial' }, { status: 'partial', completeness: 'partial', pages: [], unfinished: [{ source: 'businessList', rdjb: '2', page: 1 }] })
  const response = await fetch(`${base}/api/roster/differences?q=${encodeURIComponent(e.name)}`)
  expect(response.headers.get('cache-control')).toContain('no-store')
  const result = await response.json()
  const row = result.rows[0]
  expect(row).toMatchObject({ explanationId: reason.id, status: 'not_queried', reasonCode: null, reasonNote: '缺代码无法查询', currentDecision: { versionId: reason.id, current: { id: reason.id, status: 'not_queried' } }, explanationValidity: { status: 'premise_invalid', reasons: ['query_executed'], explanationId: reason.id, evidenceQueryIds: [q.id] } })
  const tool = await mcp('list_differences', { title: 'specialized_sme' })
  const mrow = tool.rows.find((r: any) => r.enterpriseId === e.id)
  for (const field of ['queryCoverage', 'currentDecision', 'explanationValidity', 'assessment']) expect(mrow[field]).toEqual(row[field])
  expect((await get(`/api/roster/enterprises/${e.id}`)).differences[0].explanationValidity).toEqual(row.explanationValidity)
})

it.each([
  ['partial', 'partial', { status: 'partial', completeness: 'partial', pages: [], unfinished: [{ source: 'businessList', rdjb: '2', page: 1 }] }],
  ['failed', 'failed', { status: 'failed', completeness: 'partial', error: { code: 'invalid_response', message: 'synthetic login HTML' }, pages: [], unfinished: [{ source: 'businessList', rdjb: '2', page: 1 }] }],
  ['login', 'failed', { status: 'auth_failed', completeness: 'partial', error: { code: 'auth_failed', message: 'synthetic login required' }, pages: [{ source: 'businessList', rdjb: '2', page: 1, status: 'auth_failed', fetchedCount: 0, declaredTotal: null, error: null }], unfinished: [{ source: 'businessList', rdjb: '2', page: 1 }] }],
] as const)('%s query never becomes zero records or a business reason', async (label, expected, metadata) => {
  const e = company(), q = query(e, { status: label === 'partial' ? 'partial' : 'failed' }, metadata)
  const detail = await get(`/api/roster/enterprises/${e.id}`)
  expect(assessment(detail)).toMatchObject({ assessment: 'unknown', currentDecision: { current: null }, queryCoverage: { status: expected, sources: [{ queryId: q.id, status: expected, outcome: 'unknown' }] } })
  expect(detail.differences[0]).toMatchObject({ reasonCode: null, status: 'not_queried' })
})
it('title neutral apply queries restricted filters and continuations do not complete a title', async () => {
  const e = company()
  query(e, { interface: 'apply_list', rdjb: '', titleCode: null }, { source: 'queryList', titleScope: { mode: 'source_default', rdjb: [] }, pages: [{ source: 'queryList', rdjb: null, page: 1, status: 'success', fetchedCount: 0, declaredTotal: 0, error: null }] })
  expect(assessment(await get(`/api/roster/enterprises/${e.id}`))).toMatchObject({ queryCoverage: { status: 'unknown', sources: [{ interface: 'apply_list', titleCode: null }] } })
  query(e, { interface: 'recognized_list' }, { source: 'queryBusList', effectiveConditions: { uscc: e.usccNorm, rddqrq: '2025', combination: 'and' } })
  query(e, { status: 'partial' }, { fullRange: false, pages: [{ source: 'businessList', rdjb: '2', page: 2, status: 'success', fetchedCount: 0, declaredTotal: null, error: null }] })
  const a = assessment(await get(`/api/roster/enterprises/${e.id}`))
  expect(a).toMatchObject({ assessment: 'unknown', queryCoverage: { status: 'partial' } })
  expect(a.queryCoverage.sources).toEqual(expect.arrayContaining([expect.objectContaining({ conditions: { uscc: e.usccNorm, rddqrq: '2025', combination: 'and' } }), expect.objectContaining({ fullRange: false, pages: [expect.objectContaining({ page: 2 })] })]))
})
it('name keyword query and unmatched rows retain unknown subject coverage', async () => {
  const e = company(), q = query(e, { queryKey: `name:${e.nameNorm}`, interface: 'recognized_list', status: 'success', relations: [{ sequenceNo: 1, nameRaw: '未匹配主体', usccRaw: 'UNKNOWN109', rawFields: { qymc: '未匹配主体', tyshxydm: 'UNKNOWN109' } }] }, { source: 'queryBusList', status: 'success', rows: [{ qymc: '未匹配主体', tyshxydm: 'UNKNOWN109' }], fetchedCount: 1, declaredTotal: 1, pages: [{ source: 'queryBusList', rdjb: '2', page: 1, status: 'success', fetchedCount: 1, declaredTotal: 1, error: null }], effectiveConditions: { name: e.name, combination: 'and' } })
  const row = { id: q.relationIds[0]! }
  const detail = await get(`/api/roster/enterprises/${e.id}`)
  expect(assessment(detail)).toMatchObject({ assessment: 'unknown', queryCoverage: { status: 'unknown', sources: [{ subjectMatch: 'name_only', outcome: 'unknown' }] } })
  expect(detail.platform.relations.find((r: any) => r.id === row.id).enterpriseId).toBeNull()
})
it('coarse legacy success has unknown completeness but contradicts an old unqueried premise', async () => {
  const e = company()
  const d = db.insert(schema.differenceReason).values({ ...scope(e), direction: 'missing_in_miit', status: 'not_queried', reasonNote: '缺代码无法查询', recordedAt: '2026-10-18' }).returning().get()
  const q = query(e, { status: 'success', collectionEvidence: null })
  expect(assessment(await get(`/api/roster/enterprises/${e.id}`))).toMatchObject({ queryCoverage: { status: 'unknown', sources: [{ status: 'unknown', outcome: 'unknown' }] }, explanationValidity: { status: 'premise_invalid', explanationId: d.id, evidenceQueryIds: [q.id] } })
})

async function command(e: ReturnType<typeof company>, action: 'replace' | 'withdraw', expectedCurrentId: number | null, extra: Record<string, unknown> = {}, expectedStatus = 200) {
  const request = { ...scope(e), action, expectedCurrentId, idempotencyKey: `synthetic109-${++sequence}`, actor: { type: 'user', id: 'fixture109' }, basis: 'Synthetic public acceptance', ruleVersion: 'synthetic109-v1', effectiveAt: '2026-10-19T00:00:00Z', ...(action === 'replace' ? { decision: { status: 'confirmed_no_diff', measureCode: 'none', verificationStatus: 'confirmed' } } : {}), ...extra }
  const response = await fetch(`${base}/api/roster/decision-lifecycle/commands`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer synthetic-http109' }, body: JSON.stringify(request) })
  expect(response.status).toBe(expectedStatus)
  return { body: await response.json(), request }
}
it('confirmed decision and its evidence remain readable independently from later failed coverage and other directions', async () => {
  const e = company(), q = query(e)
  const saved = await command(e, 'replace', null, { decision: { status: 'confirmed_reason', reasonCode: 'other', reasonNote: '用户已确认的解释', measureCode: 'manual_review', verificationStatus: 'confirmed', evidenceQueryId: q.id } })
  query(e, { status: 'failed' }, { status: 'auth_failed', completeness: 'partial', error: { code: 'auth_failed', message: 'synthetic login' }, pages: [], unfinished: [{ source: 'businessList', rdjb: '2', page: 1 }] })
  const detail = await get(`/api/roster/enterprises/${e.id}`), a = assessment(detail)
  expect(a).toMatchObject({ assessment: 'decided', currentDecision: { versionId: saved.body.versionId, current: { id: saved.body.versionId, reasonCode: 'other', reasonNote: '用户已确认的解释', evidenceQueryId: q.id } }, queryCoverage: { status: 'failed' }, explanationValidity: { status: 'unknown', reasons: ['no_evidence_baseline'], evidenceQueryIds: [q.id] } })
  expect(assessment(detail, 'specialized_sme', 'extra_in_miit')).toMatchObject({ currentDecision: { versionId: null, current: null }, queryCoverage: { status: 'failed' } })
  expect(assessment(detail, 'little_giant')).toMatchObject({ currentDecision: { current: null }, queryCoverage: { status: 'not_queried' } })
  const invalid = await command(e, 'replace', null, {}, 409)
  expect(invalid.body.error.code).toBe('stale_version')
  expect(assessment(await get(`/api/roster/enterprises/${e.id}`)).currentDecision).toEqual(a.currentDecision)
  assertEnterpriseDetailSnapshotEqual(await mcp('get_enterprise_detail', { enterpriseId: e.id }), detail)
})
it('withdrawal retains the lifecycle version without reviving its old decision or changing complete query coverage', async () => {
  const e = company(); query(e)
  const first = await command(e, 'replace', null)
  const withdrawn = await command(e, 'withdraw', first.body.versionId)
  const detail = await get(`/api/roster/enterprises/${e.id}`)
  expect(assessment(detail)).toMatchObject({ assessment: 'withdrawn', currentDecision: { versionId: withdrawn.body.versionId, current: null }, queryCoverage: { status: 'complete' }, explanationValidity: { status: 'not_applicable', explanationId: null } })
  expect(detail.differences[0]).toMatchObject({ status: 'not_queried', explanationId: withdrawn.body.versionId })
  const replay = await fetch(`${base}/api/roster/decision-lifecycle/commands`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer synthetic-http109' }, body: JSON.stringify(withdrawn.request) })
  expect(replay.status).toBe(200); expect(await replay.json()).toEqual(withdrawn.body)
  expect(assessment(await mcp('get_enterprise_detail', { enterpriseId: e.id })).currentDecision).toEqual(assessment(detail).currentDecision)
  const denied = await fetch(`${base}/api/roster/decision-lifecycle/commands`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(withdrawn.request) })
  expect(denied.status).toBe(401)
})
it('latest retry updates both transports and repeated evidence leaves the original explanation untouched', async () => {
  const e = company(); query(e, { status: 'partial' }, { status: 'partial', completeness: 'partial', pages: [], unfinished: [{ source: 'businessList', rdjb: '2', page: 1 }] })
  expect(assessment(await get(`/api/roster/enterprises/${e.id}`)).queryCoverage.status).toBe('partial')
  query(e)
  const detail = await get(`/api/roster/enterprises/${e.id}`)
  expect(assessment(detail)).toMatchObject({ assessment: 'queried_unjudged', queryCoverage: { status: 'complete' }, currentDecision: { current: null } })
  query(e)
  const again = await mcp('get_enterprise_detail', { enterpriseId: e.id })
  expect(assessment(again)).toMatchObject({ assessment: 'queried_unjudged', queryCoverage: { status: 'complete' }, currentDecision: { versionId: null, current: null }, explanationValidity: { status: 'not_applicable' } })
})
it('coverage caps related attempts and excludes unrelated large archive bodies on differences and MCP reads', async () => {
  const e = company(), other = company()
  const unused = query(other, { rawResponse: 'PRIVATE_UNRELATED_109'.repeat(100000) })
  for (let n = 0; n < 51; n++) query(e)
  const rows = (await get(`/api/roster/differences?q=${encodeURIComponent(e.name)}`)).rows
  expect(rows[0].queryCoverage).toMatchObject({ status: 'partial', truncated: true })
  expect(rows[0].queryCoverage.sources).toHaveLength(50)
  expect(JSON.stringify(rows)).not.toContain('PRIVATE_')
  const d = db.insert(schema.differenceReason).values({ ...scope(e), direction: 'missing_in_miit', status: 'not_queried', recordedAt: '2026-10-19' }).returning().get()
  const tool = await mcp('list_differences', { title: 'specialized_sme', pageSize: 200 })
  expect(tool.rows.find((r: any) => r.enterpriseId === e.id)).toMatchObject({ currentDecision: { versionId: d.id }, queryCoverage: { truncated: true } })
  expect(JSON.stringify(tool)).not.toContain('PRIVATE_')
})
it('another title decision and successful query do not invalidate the unqueried title explanation', async () => {
  const e = company()
  const old = db.insert(schema.differenceReason).values({ ...scope(e), direction: 'missing_in_miit', status: 'not_queried', reasonNote: '旧解释', recordedAt: '2026-10-18' }).returning().get()
  query(e, { rdjb: '3', titleCode: 'little_giant' }, { titleScope: { mode: 'selected', rdjb: ['3'] }, pages: [{ source: 'businessList', rdjb: '3', page: 1, status: 'success', fetchedCount: 0, declaredTotal: 0, error: null }] })
  const giant = await command(e, 'replace', null, { titleCode: 'little_giant' })
  const detail = await get(`/api/roster/enterprises/${e.id}`)
  expect(assessment(detail)).toMatchObject({ queryCoverage: { status: 'not_queried', sources: [] }, currentDecision: { versionId: old.id }, explanationValidity: { status: 'unknown', reasons: ['no_evidence_baseline'] } })
  expect(assessment(detail, 'little_giant')).toMatchObject({ queryCoverage: { status: 'complete' }, currentDecision: { versionId: giant.body.versionId }, assessment: 'decided' })
})
it('exact query coverage keeps unmatched returned subjects unknown rather than asserting owned records', async () => {
  const e = company(), q = query(e, { interface: 'recognized_list', status: 'success', relations: [{ sequenceNo: 1, nameRaw: '无法归属原行', rawFields: { qymc: '无法归属原行' } }] }, { source: 'queryBusList', status: 'success', rows: [{ qymc: '无法归属原行' }], fetchedCount: 1, declaredTotal: 1, pages: [{ source: 'queryBusList', rdjb: '2', page: 1, status: 'success', fetchedCount: 1, declaredTotal: 1, error: null }] })
  const row = { id: q.relationIds[0]! }
  const detail = await get(`/api/roster/enterprises/${e.id}`)
  expect(assessment(detail)).toMatchObject({ queryCoverage: { status: 'complete', sources: [{ outcome: 'unknown' }] } })
  expect(detail.platform.relations.find((r: any) => r.id === row.id).enterpriseId).toBeNull()
})
it('stable difference pages preserve counts and hydrate only selected original explanation fields', async () => {
  const e = company()
  for (const direction of ['missing_in_miit', 'extra_in_miit'] as const) db.insert(schema.differenceReason).values({ enterpriseId: e.id, titleCode: 'specialized_sme', direction, status: 'needs_review', reasonCode: 'other', reasonNote: `独立原说明${direction}`, measureCode: 'manual_review', measureNote: '独立原措施', recordedAt: '2026-10-18' }).run()
  const q = encodeURIComponent(e.name)
  const all = await get(`/api/roster/differences?q=${q}`), first = await get(`/api/roster/differences?q=${q}&pageSize=1`), second = await get(`/api/roster/differences?q=${q}&pageSize=1&page=2`)
  expect(all.total).toBe(2)
  expect([...first.rows, ...second.rows]).toEqual(all.rows)
  expect(first.counts).toEqual(all.counts); expect(second.counts).toEqual(all.counts)
  expect(all.rows.map((r: any) => [r.reasonNote, r.measureNote])).toEqual([['独立原说明extra_in_miit', '独立原措施'], ['独立原说明missing_in_miit', '独立原措施']])
})
