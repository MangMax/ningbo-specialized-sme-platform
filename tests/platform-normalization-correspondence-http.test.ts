import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { createHash } from 'node:crypto'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { schema, useDb } from '../db'
import { spawnOwnedChild as spawn, reserveLoopbackPort, waitForHttp, stopOwnedChild } from '../scripts/lib/isolated-local-services.mjs'

// Legacy archive state is seeded before startup. Decisions are made only over
// the real public HTTP/MCP routes; no live business database is used.
const dir = mkdtempSync(join(tmpdir(), 'normalization-correspondence-http-'))
const db = useDb({ dbPath: join(dir, 'roster.db') })
const enterprise = db.insert(schema.enterprise).values({ name: '流程事实测试', nameNorm: '流程事实测试', usccNorm: '91330211000000001A' }).returning().get()
const doc = db.insert(schema.sourceDocument).values({ source: 'jxj', title: '合成公布', path: 'synthetic/notice.pdf', issueDate: '2025-12-01' }).returning().get()
const record = db.insert(schema.record).values({ enterpriseId: enterprise.id, source: 'jxj', titleCode: 'innovative_sme', usccRaw: enterprise.usccNorm }).returning().get()
const award = db.insert(schema.recordEvent).values({ recordId: record.id, eventType: 'award', year: 2025 }).returning().get()
const awardEvidence = db.insert(schema.recordEvidence).values({ recordEventId: award.id, sourceFile: doc.path, page: 1 }).returning().get()
const query = db.insert(schema.platformQuery).values({ interface: 'apply_list', queryKey: enterprise.usccNorm!, rdjb: '1', titleCode: 'innovative_sme', queriedAt: '2026-01-01T00:00:00Z', status: 'success', rawResponse: '原始响应 🙂\n' }).returning().get()
function legacyRow(sequenceNo: number, rawFields: Record<string, unknown>, stored: Partial<typeof schema.platformRelation.$inferInsert> = {}) {
  return db.insert(schema.platformRelation).values({ queryId: query.id, sequenceNo, enterpriseId: enterprise.id, usccRaw: enterprise.usccNorm, matchBasis: 'uscc', verificationStatus: 'confirmed', rawFields, ...stored }).returning().get()
}
const cases = [
  { label: 'raw-type', row: legacyRow(1, { sblx: '复核', sqsj: '2025-01-01' }) },
  { label: 'raw-time', row: legacyRow(2, { sblx: '申请', sqsj: '2026-01-01' }) },
  { label: 'stored-conflict', row: legacyRow(3, { sblx: '复核', sqsj: '2025-01-01', cszt: '已退回' }, { declareKind: 'apply', status: '终审通过', year: 2025 }) },
  { label: 'status-conflict', row: legacyRow(5, { sblx: '申请', cszt: '已退回' }, { declareKind: 'apply', status: '终审通过' }) },
  { label: 'time-conflict', row: legacyRow(6, { sblx: '申请', sqsj: '2026-01-01' }, { declareKind: 'apply', appliedAt: '2025-01-01' }) },
]
const review = db.insert(schema.recordEvent).values({ recordId: record.id, eventType: 'review', year: 2022, decidedYear: 2025, reviewOutcome: 'passed' }).returning().get()
db.insert(schema.recordEvidence).values({ recordEventId: review.id, sourceFile: doc.path, page: 2 }).run()
const reviewRow = legacyRow(4, { sblx: '复核', sqsj: '2025-11-21 09:54:16', cszt: '终审通过', year: '2025', whpc: '2025-2', unrelated: 'UNEXPOSED'.repeat(32768) })
const precedingRow = legacyRow(7, { sblx: '申请', sqsj: '2024-01-01' })
const mixedAward = db.insert(schema.recordEvent).values({ recordId: record.id, eventType: 'award', year: 2025 }).returning().get()
db.insert(schema.recordEvidence).values({ recordEventId: mixedAward.id, sourceFile: doc.path, page: 3 }).run()
const contradictoryRow = legacyRow(8, { sblx: '申请', cszt: '已退回', year: '2025' })
const contextConflictRow = legacyRow(9, { sblx: '申请', cszt: '终审通过', year: '2025', szsfmc: '宁波市' }, { province: '浙江省' })
const conflictCombinations = [
  { label: 'supported-plus-province-conflict', supported: true, stored: { province: '浙江省' }, expected: { field: 'province', storedValue: '浙江省', rawValue: '宁波市' } },
  { label: 'only-province-conflict', supported: false, stored: { province: '浙江省' }, expected: { field: 'province', storedValue: '浙江省', rawValue: '宁波市' } },
  { label: 'only-status-conflict', supported: false, stored: { status: '终审通过' }, expected: { field: 'status', storedValue: '终审通过', rawValue: '已退回' } },
  { label: 'only-type-conflict', supported: false, stored: { declareKind: 'review' as const }, expected: { field: 'declareKind', storedValue: 'review', rawValue: 'apply' } },
  { label: 'only-time-conflict', supported: false, stored: { appliedAt: '2024-01-01' }, expected: { field: 'appliedAt', storedValue: '2024-01-01', rawValue: '2025-01-01' } },
  { label: 'only-year-conflict', supported: false, stored: { year: 2024 }, expected: { field: 'year', storedValue: 2024, rawValue: 2025 } },
].map((testCase, index) => {
  const event = db.insert(schema.recordEvent).values({ recordId: record.id, eventType: 'award', year: 2025 }).returning().get()
  db.insert(schema.recordEvidence).values({ recordEventId: event.id, sourceFile: doc.path, page: 4 + index }).run()
  const context = legacyRow(10 + 2 * index, { sblx: '申请', cszt: '已退回', year: '2025', sqsj: '2025-01-01', szsfmc: '宁波市' }, testCase.stored)
  const support = testCase.supported ? legacyRow(11 + 2 * index, { sblx: '申请', cszt: '终审通过', year: '2025' }) : null
  return { ...testCase, event, context, support }
})
// Pre-normalization confirmed history, with its original raw-source fingerprint.
// This is fixture construction, not a runtime bypass of the write contract.
const { revision: _revision, ...legacyAward } = award
const legacySource = { event: legacyAward, record, officialEnterprise: enterprise, officialEvidence: [{ evidence: awardEvidence, storedFile: null }], predecessor: null, relation: cases[2]!.row, query, exportRow: null, exportBatch: null }
const legacyEdge = db.insert(schema.recordCorrespondence).values({ edgeKey: 'legacy-support', type: 'event_process', role: 'supports_award', eventId: award.id, relationId: cases[2]!.row.id, enterpriseId: enterprise.id, titleCode: 'innovative_sme', status: 'confirmed', revision: 2, targetIdentity: {}, provenance: { ...legacySource, comparisonProofIds: [] }, sourceFingerprint: createHash('sha256').update(JSON.stringify(legacySource)).digest('hex'), ruleId: 'manual', ruleVersion: '1', createdAt: '2026-01-02T00:00:00Z', decidedAt: '2026-01-02T00:00:00Z' }).returning().get()
let service: { baseUrl: string; stop: () => Promise<void> }
beforeAll(async () => {
  const cwd = resolve(import.meta.dirname, '..'), port = await reserveLoopbackPort()
  const child = spawn(process.execPath, [join(cwd, 'node_modules/nuxt/bin/nuxt.mjs'), 'dev', '--host', '127.0.0.1', '--port', String(port)], { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NUXT_BUILD_DIR: join(dir, 'build'), NUXT_DB_PATH: join(dir, 'roster.db'), NUXT_FILES_DIR: join(dir, 'files'), NUXT_INCOMING_DIR: join(dir, 'incoming'), NUXT_API_TOKEN: 'synthetic-normalization', NUXT_MCP_TOKEN: 'synthetic-normalization' } })
  let output = ''
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { output = (output + data).slice(-8000) })
  service = { baseUrl: `http://127.0.0.1:${port}`, stop: () => stopOwnedChild(child) }
  try { await waitForHttp(`${service.baseUrl}/_openapi.json`, { timeoutMs: 60000, child }) }
  catch (error) { await service.stop(); throw new Error(`${String(error)}\n${output}`) }
  const response = await fetch(`${service.baseUrl}/_openapi.json`)
  expect(response.status).toBe(200)
  expect((await response.json()).paths['/api/roster/correspondences/preflight']).toBeDefined()
}, 90000)
afterAll(async () => { await service?.stop(); db.$client.close(); rmSync(dir, { recursive: true, force: true }) })
async function rest(path: string, body?: unknown) {
  const response = await fetch(service.baseUrl + path, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', authorization: 'Bearer synthetic-normalization' }, ...(body ? { body: JSON.stringify(body) } : {}) })
  return { status: response.status, body: await response.json() }
}
async function mcp(name: string, args: unknown) {
  const response = await fetch(`${service.baseUrl}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: 'Bearer synthetic-normalization', 'mcp-protocol-version': '2025-06-18' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) })
  expect(response.status).toBe(200)
  const raw = await response.text()
  const payload = JSON.parse(raw.startsWith('event:') ? raw.split('\n').find(line => line.startsWith('data: '))!.slice(6) : raw)
  return { isError: payload.result.isError, body: JSON.parse(payload.result.content[0].text) }
}
function request(label: string, operations: unknown[]) {
  return { idempotencyKey: label, sourceIdentity: `synthetic:${label}`, actor: { type: 'agent', id: 'test' }, basis: '核对原始流程事实', ruleId: 'manual', ruleVersion: '1', operations }
}
function edge(relationId: number, role = 'supports_award', eventId = award.id) { return { type: 'event_process', eventId, relationId, role } }
async function save(input: ReturnType<typeof request>) {
  const plan = await rest('/api/roster/correspondences/preflight', input)
  expect(plan.status).toBe(200)
  const committed = await rest('/api/roster/correspondences/commit', { request: input, planHash: plan.body.planHash })
  expect(committed.status).toBe(200)
  return committed.body
}

it.each(cases)('support confirmation rejects contradictory normalized facts over HTTP and MCP: $label', async ({ label, row }) => {
  const input = request(`reject:${label}`, [{ action: 'create', status: 'confirmed', edge: edge(row.id) }])
  expect(await rest('/api/roster/correspondences/preflight', input)).toMatchObject({ status: 422, body: { error: { code: 'invalid_endpoint_type' } } })
  expect(await mcp('preflight_record_correspondences', input)).toMatchObject({ isError: true, body: { error: { code: 'invalid_endpoint_type' } } })
  expect(await rest('/api/roster/correspondences/commit', { request: input, planHash: '0'.repeat(64) })).toMatchObject({ status: 409, body: { error: { code: 'plan_mismatch' } } })
  const expectedIds = label === 'stored-conflict' ? [legacyEdge.id] : []
  expect((await rest(`/api/roster/correspondences?relationId=${row.id}`)).body.rows.map((edge: { id: number }) => edge.id)).toEqual(expectedIds)
})

it('normalized review facts align through HTTP and MCP without rewriting archive evidence', async () => {
  const receipt = await save(request('review-support', [{ action: 'create', status: 'confirmed', edge: edge(reviewRow.id, 'supports_review', review.id) }]))
  const input = { queryIds: [query.id], exportBatchIds: [], officialSourceDocumentIds: [doc.id] }
  const http = await rest(`/api/roster/record-comparison?queryIds=${query.id}&exportBatchIds=&officialSourceDocumentIds=${doc.id}`)
  expect(http.status).toBe(200)
  expect(http.body.rows.find((row: { event: { id: number } }) => row.event.id === review.id)).toMatchObject({ classification: 'historical_aligned', reasons: [], platformRows: [{ id: reviewRow.id, declareKind: 'review', status: '终审通过', year: 2025, appliedAt: '2025-11-21 09:54:16', normalizationConflicts: [] }] })
  expect(await mcp('list_record_comparison', input)).toMatchObject({ body: http.body })
  expect(JSON.stringify(http.body)).not.toContain('UNEXPOSED')
  const audit = (await rest(`/api/roster/correspondences/${receipt.correspondenceIds[0]}/audit`)).body
  expect(audit.rows).toHaveLength(2)
  expect(audit.rows[1].evidence.relation).toMatchObject({ id: reviewRow.id, status: null, declareKind: null, year: null, rawFields: reviewRow.rawFields })
  expect((await rest(`/api/platform/queries?queryId=${query.id}&includeRawResponse=true`)).body.rows[0].query.rawResponse).toBe('原始响应 🙂\n')
})

it('legacy confirmed raw conflicts stay explicit and cannot become historical aligned', async () => {
  const result = await rest(`/api/roster/record-comparison?queryIds=${query.id}&exportBatchIds=&officialSourceDocumentIds=${doc.id}`)
  expect(result.status).toBe(200)
  const row = result.body.rows.find((row: { event: { id: number } }) => row.event.id === award.id)
  expect(row).toMatchObject({ classification: 'unresolved', reasons: ['platform_field_conflict'], platformRows: expect.arrayContaining([expect.objectContaining({ id: cases[2]!.row.id, declareKind: null, status: null, normalizationConflicts: [{ field: 'status', storedValue: '终审通过', rawValue: '已退回' }, { field: 'declareKind', storedValue: 'apply', rawValue: 'review' }] })]) })
  expect(await mcp('list_record_comparison', { queryIds: [query.id], exportBatchIds: [], officialSourceDocumentIds: [doc.id] })).toMatchObject({ body: result.body })
})

it('valid historical contradiction survives a confirmed context field conflict over HTTP and MCP', async () => {
  await save(request('mixed-contradiction', [{ action: 'create', status: 'confirmed', edge: edge(contradictoryRow.id, 'supports_award', mixedAward.id) }]))
  const path = `/api/roster/record-comparison?queryIds=${query.id}&exportBatchIds=&officialSourceDocumentIds=${doc.id}`
  const before = await rest(path)
  expect(before.body.rows.find((row: { event: { id: number } }) => row.event.id === mixedAward.id)).toMatchObject({ classification: 'historical_conflict', reasons: ['confirmed_same_event_status_conflict'] })
  const context = await save(request('mixed-context', [{ action: 'create', status: 'confirmed', edge: edge(contextConflictRow.id, 'context_only', mixedAward.id) }]))
  expect((await rest(`/api/roster/correspondences/${context.correspondenceIds[0]}`)).body).toMatchObject({ status: 'confirmed', requiresRevalidation: false })
  const after = await rest(path)
  const remote = await mcp('list_record_comparison', { queryIds: [query.id], exportBatchIds: [], officialSourceDocumentIds: [doc.id] })
  expect(after.status).toBe(200)
  const expected = {
    classification: 'historical_conflict', reasons: ['confirmed_same_event_status_conflict', 'platform_field_conflict'],
    platformRows: expect.arrayContaining([expect.objectContaining({ id: contextConflictRow.id, normalizationConflicts: [{ field: 'province', storedValue: '浙江省', rawValue: '宁波市' }] })]),
  }
  expect.soft(after.body.rows.find((row: { event: { id: number } }) => row.event.id === mixedAward.id)).toMatchObject(expected)
  expect.soft(remote.body.rows.find((row: { event: { id: number } }) => row.event.id === mixedAward.id)).toMatchObject(expected)
  expect(after.body.counts.historical_conflict).toBe(before.body.counts.historical_conflict)
  expect(remote).toMatchObject({ body: after.body })
  const filtered = await rest(`${path}&classification=historical_conflict`)
  expect(filtered.body.rows.map((row: { event: { id: number } }) => row.event.id)).toContain(mixedAward.id)
  expect(filtered.body.counts).toEqual(after.body.counts)
})

it.each(conflictCombinations)('conflicted context cannot prove alignment or contradiction over HTTP and MCP: $label', async ({ label, event, context, support, expected }) => {
  const path = `/api/roster/record-comparison?queryIds=${query.id}&exportBatchIds=&officialSourceDocumentIds=${doc.id}`
  if (support) {
    await save(request(`${label}:support`, [{ action: 'create', status: 'confirmed', edge: edge(support.id, 'supports_award', event.id) }]))
    expect((await rest(path)).body.rows.find((row: { event: { id: number } }) => row.event.id === event.id)).toMatchObject({ classification: 'historical_aligned', reasons: [] })
  }
  const receipt = await save(request(`${label}:context`, [{ action: 'create', status: 'confirmed', edge: edge(context.id, 'context_only', event.id) }]))
  expect((await rest(`/api/roster/correspondences/${receipt.correspondenceIds[0]}`)).body).toMatchObject({ status: 'confirmed', requiresRevalidation: false })
  const http = await rest(path)
  expect(http.status).toBe(200)
  expect(http.body.rows.find((row: { event: { id: number } }) => row.event.id === event.id)).toMatchObject({
    classification: 'unresolved', reasons: ['platform_field_conflict'],
    platformRows: expect.arrayContaining([expect.objectContaining({ id: context.id, normalizationConflicts: [expected] })]),
  })
  expect(await mcp('list_record_comparison', { queryIds: [query.id], exportBatchIds: [], officialSourceDocumentIds: [doc.id] })).toMatchObject({ body: http.body })
})

it('asOf excludes future decisions and rejects sources beyond the cutoff', async () => {
  const path = `/api/roster/record-comparison?queryIds=${query.id}&exportBatchIds=&officialSourceDocumentIds=${doc.id}`
  const past = await rest(`${path}&asOf=2026-01-01T12:00:00Z`)
  expect(past.status).toBe(200)
  expect(past.body.rows.find((row: { event: { id: number } }) => row.event.id === award.id)).toMatchObject({ classification: 'unresolved', reasons: ['official_coverage_unproved'], correspondences: [], platformRows: [] })
  expect((await rest(`${path}&asOf=2025-12-31T23:59:59Z`)).status).toBe(400)
})

it('candidate promotion rejects normalized contradictions while context remains confirmable and audited', async () => {
  const row = cases[0]!.row
  const candidate = await save(request('candidate', [{ action: 'create', status: 'candidate', edge: edge(row.id) }]))
  const id = candidate.correspondenceIds[0]
  const input = request('promote', [{ action: 'decide', correspondenceId: id, expectedRevision: 1, status: 'confirmed' }])
  expect(await mcp('preflight_record_correspondences', input)).toMatchObject({ isError: true, body: { error: { code: 'invalid_endpoint_type' } } })
  expect((await rest(`/api/roster/correspondences/${id}`)).body).toMatchObject({ status: 'candidate', revision: 1 })
  expect((await rest(`/api/roster/correspondences/${id}/audit`)).body).toMatchObject({ total: 1, rows: [{ toStatus: 'candidate' }] })
  const contextRow = cases[2]!.row
  const context = await save(request('context', [{ action: 'create', status: 'confirmed', edge: edge(contextRow.id, 'context_only') }]))
  expect((await rest(`/api/roster/correspondences/${context.correspondenceIds[0]}`)).body).toMatchObject({ status: 'confirmed', requiresRevalidation: false })
  expect((await rest(`/api/roster/correspondences/relations/${row.id}`)).body.source).toMatchObject({ id: row.id, declareKind: 'review', rawFields: row.rawFields })
})

it('follow-up validation retains original role and predecessor timing rules on normalized facts', async () => {
  const followup = (relationId: number) => ({ type: 'later_process', enterpriseId: enterprise.id, titleCode: 'innovative_sme', predecessorEventId: award.id, relationId, role: 'followup_apply' })
  for (const [label, row] of [['type', cases[0]!.row], ['conflict', cases[2]!.row], ['predates', precedingRow]] as const) {
    const input = request(`followup:${label}`, [{ action: 'create', status: 'confirmed', edge: followup(row.id) }])
    expect(await rest('/api/roster/correspondences/preflight', input)).toMatchObject({ status: 422, body: { error: { code: 'invalid_endpoint_type' } } })
    expect(await mcp('preflight_record_correspondences', input)).toMatchObject({ isError: true, body: { error: { code: 'invalid_endpoint_type' } } })
  }
  const receipt = await save(request('followup:valid', [{ action: 'create', status: 'confirmed', edge: followup(cases[1]!.row.id) }]))
  expect((await rest(`/api/roster/correspondences/${receipt.correspondenceIds[0]}`)).body).toMatchObject({ status: 'confirmed', requiresRevalidation: false, predecessorEventId: award.id })
})

it.each([
  { label: 'missing', raw: {}, expected: { status: null, declareKind: null, appliedAt: null, awardBatchLabel: null, year: null } },
  { label: 'null', raw: { cszt: null, sblx: null, sqsj: null, personuuid: null, year: null }, expected: { status: null, declareKind: null, appliedAt: null, awardBatchLabel: null, year: null } },
  { label: 'boolean', raw: { cszt: true, sblx: false, sqsj: true, personuuid: false, year: true }, expected: { status: null, declareKind: null, appliedAt: null, awardBatchLabel: null, year: null } },
  { label: 'object-array', raw: { cszt: { nested: true }, sblx: ['申请'], sqsj: {}, personuuid: [], year: [2025] }, expected: { status: null, declareKind: null, appliedAt: null, awardBatchLabel: null, year: null } },
  { label: 'prototype-enum', raw: { cszt: ' 未知 ', sblx: '__proto__', sqsj: ' 2025-01-01 ', personuuid: ' 第一批 ', year: '2025' }, expected: { status: '未知', declareKind: '__proto__', appliedAt: '2025-01-01', awardBatchLabel: '第一批', year: 2025 } },
])('process JSON types agree across full archives, candidates and comparison over HTTP/MCP: $label', async ({ label, raw, expected }) => {
  const q = db.insert(schema.platformQuery).values({ interface: 'business_list', queryKey: `json-types:${label}`, rdjb: '1', queriedAt: '2026-01-01T00:00:00Z', status: 'success' }).returning().get()
  const rawFields = { ...raw, szsfmc: ' 宁波市 ', whpc: ' 2025-2 ', unrelated: 'UNEXPOSED'.repeat(32768) }
  const relation = db.insert(schema.platformRelation).values({ queryId: q.id, sequenceNo: 1, enterpriseId: enterprise.id, usccRaw: enterprise.usccNorm, rawFields }).returning().get()
  const full = await rest(`/api/platform/queries?queryId=${q.id}`)
  expect(full.status).toBe(200)
  expect(full.body.rows[0].relations[0]).toMatchObject({ ...expected, province: '宁波市', batch: '2025-2', id: relation.id, rawFields, normalizationConflicts: [] })
  const input = { eventId: award.id, queryIds: [q.id], exportBatchIds: [], ruleVersion: 'json-types' }
  const candidates = await rest('/api/roster/correspondences/candidates', input)
  expect(candidates.status).toBe(200)
  expect(candidates.body.rows).toHaveLength(1)
  expect(candidates.body.rows[0]).toMatchObject({ edge: { relationId: relation.id }, evidence: { process: { status: expected.status, declareKind: expected.declareKind, appliedAt: expected.appliedAt, normalizationConflicts: [] }, temporal: { relationYear: expected.year, relationBatch: '2025-2', awardBatchLabel: expected.awardBatchLabel } } })
  expect(await mcp('find_record_correspondence_candidates', input)).toMatchObject({ body: candidates.body })
  const comparison = await rest(`/api/roster/record-comparison?queryIds=${q.id}&exportBatchIds=&officialSourceDocumentIds=${doc.id}`)
  expect(comparison.status).toBe(200)
  expect(comparison.body.platformWithoutOfficial.rows).toEqual(expect.arrayContaining([expect.objectContaining({ relation: expect.objectContaining({ ...expected, id: relation.id, normalizationConflicts: [] }) })]))
  expect(await mcp('list_record_comparison', { queryIds: [q.id], exportBatchIds: [], officialSourceDocumentIds: [doc.id] })).toMatchObject({ body: comparison.body })
  expect(JSON.stringify([candidates.body, comparison.body])).not.toContain('UNEXPOSED')
})
