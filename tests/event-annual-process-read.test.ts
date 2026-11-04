import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, it, vi } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { schema, useDb } from '../db'
import { readEventAnnualProcess } from '../server/utils/event-annual-process-read'
import { handleEventAnnualProcessRequest, dispatchEventAnnualProcessMcp } from '../server/utils/event-annual-process-api'
import { handleRosterImportRequest } from '../server/utils/roster-import-http'
import { preflightRecordCorrespondences, commitRecordCorrespondences } from '../server/utils/record-correspondence'
import { normalizePlatformRelation } from '../lib/platform/normalization'
import type { EventAnnualProcessPage } from '../lib/roster/annual-process'
import { startHttpFixture } from './helpers/http-fixture'
import { normalizedUscc } from '../server/utils/event-archive-discovery'

const fixtures: Array<{ dir: string; db: ReturnType<typeof useDb> }> = []
afterAll(() => fixtures.forEach(({ dir, db }) => { db.$client.close(); rmSync(dir, { recursive: true, force: true }) }))
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'annual-250-'))
  const db = useDb({ dbPath: join(dir, 'isolated.db') }); fixtures.push({ dir, db })
  const enterprise = db.insert(schema.enterprise).values({ name: '年度过程合成企业', nameNorm: '年度过程合成企业', usccNorm: '91330211255994457P' }).returning().get()
  const record = db.insert(schema.record).values({ enterpriseId: enterprise.id, titleCode: 'specialized_sme', source: 'jxj', usccRaw: enterprise.usccNorm }).returning().get()
  const event = db.insert(schema.recordEvent).values({ recordId: record.id, eventType: 'award', year: 2024 }).returning().get()
  db.insert(schema.recordEvidence).values({ recordEventId: event.id, sourceFile: 'synthetic/annual.pdf', page: 2, listNo: 1 }).run()
  let querySequence = 0
  const query = (values: Partial<typeof schema.platformQuery.$inferInsert> = {}) => db.insert(schema.platformQuery).values({ interface: 'business_list', queryKey: enterprise.usccNorm!, titleCode: 'specialized_sme', rdjb: '2', queriedAt: `2026-10-01T00:00:${String(querySequence++).padStart(2, '0')}Z`, status: 'success', ...values }).returning().get()
  const row = (queryId: number, values: Partial<typeof schema.platformRelation.$inferInsert> = {}) => db.insert(schema.platformRelation).values({ queryId, sequenceNo: 1, enterpriseId: enterprise.id, usccRaw: enterprise.usccNorm, relationKey: 'SQ-1', verificationStatus: 'confirmed', matchBasis: 'uscc', rawFields: { id: 'SQ-1', sblx: '申请', sqsj: '2024-03-01 09:00:00', cszt: '终审通过', year: 2024 }, ...values }).returning().get()
  async function project() {
    const body = { idempotencyKey: `projection-${querySequence}`, sourceKind: 'platform_archive', sourceIdentity: 'tests/annual-250', payload: { platformRecordObservations: db.select({ relationId: schema.platformRelation.id }).from(schema.platformRelation).all() } }
    const request = { method: 'POST', headers: { authorization: 'Bearer isolated-test' }, body }
    const deps = { db, apiToken: 'isolated-test' }
    const preview = await handleRosterImportRequest('preflight', request, deps)
    expect(preview.status).toBe(200)
    expect((preview.body as any).preflight.conflicts).toEqual([])
    const saved = await handleRosterImportRequest('commit', request, deps)
    expect((saved.body as any).status).toBe('committed')
  }
  const read = () => readEventAnnualProcess(db, event.id)!
  return { db, enterprise, record, event, query, row, project, read }
}

it('discovers unbound raw USCC variants archived through HTTP before the official enterprise exists', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'annual-292-'))
  const db = useDb({ dbPath: join(dir, 'isolated.db') }); fixtures.push({ dir, db })
  let eventId = 0
  const app = await startHttpFixture({ routes: {
    '/import': request => handleRosterImportRequest('commit', request, { db, apiToken: 'isolated292' }),
    '/annual': request => handleEventAnnualProcessRequest({ ...request, id: eventId }, { db }),
  } })
  const post = async (key: string, payload: unknown) => {
    const response = await fetch(app.baseUrl + '/import', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer isolated292' }, body: JSON.stringify({ idempotencyKey: key, sourceKind: key === '292/official' ? 'announcement' : 'platform_archive', sourceIdentity: 'tests/annual292', payload }) })
    const result = await response.json()
    expect(response.status, JSON.stringify(result)).toBe(200)
    expect(result.status, JSON.stringify(result)).toBe('committed')
  }
  const identity = '91330211255994457P', variant = '91330211\u200b255994457p'
  const archivedQuery = (key: string, usccRaw: string, platformKey: string, appliedAt: string, status: string) => ({ interface: 'business_list', queryKey: key, rdjb: '2', titleCode: 'specialized_sme', queriedAt: '2026-10-01T00:00:00Z', status: 'success', relations: [{ sequenceNo: 1, relationKey: platformKey, usccRaw, nameRaw: '未登记历史名', rawFields: { id: platformKey, sblx: '申请', year: 2024, sqsj: appliedAt, cszt: status } }] })
  try {
    await post('292/archive', { platformQueries: [archivedQuery(identity, identity, 'EARLY292', '2024-03-01 09:00:00', '终审通过')] })
    expect(db.select().from(schema.platformRelation).get()).toMatchObject({ enterpriseId: null, verificationStatus: 'pending' })
    await post('292/later-archive', { platformQueries: [archivedQuery('name:未登记历史名', variant, 'LATE292', '2024-12-01 09:00:00', '待审核')] })
    await post('292/official', { announcement: { sourceDocument: { source: 'jxj', title: '合成正式公布' }, records: [{ enterprise: { name: '合成当前企业', uscc: identity }, titleCode: 'specialized_sme', events: [{ eventType: 'award', year: 2024, batchSeq: 1, evidence: [{ sourceFile: 'synthetic/292.html', listNo: 1 }] }] }] } })
    eventId = db.select().from(schema.recordEvent).get()!.id
    const early = db.select().from(schema.platformRelation).get()!
    const decision = { idempotencyKey: '292/early-decision', sourceIdentity: 'tests/annual292', actor: { type: 'agent' as const, id: 'fixture' }, basis: 'synthetic original observation', ruleId: 'manual', ruleVersion: '1', operations: [{ action: 'create' as const, status: 'confirmed' as const, edge: { type: 'event_process' as const, eventId, relationId: early.id, role: 'context_only' as const } }] }
    commitRecordCorrespondences(db, decision, preflightRecordCorrespondences(db, decision).planHash)
    const originals = db.select().from(schema.platformRelation).all(), later = originals[1]!
    expect(later).toMatchObject({ usccRaw: variant, enterpriseId: null, verificationStatus: 'pending' })
    expect(db.select().from(schema.enterpriseAlias).all()).toEqual([])
    const decisions = db.select().from(schema.recordCorrespondence).all(), audits = db.select().from(schema.recordCorrespondenceAudit).all()
    const businessRecords = db.select().from(schema.platformBusinessRecord).all(), versions = db.select().from(schema.platformBusinessRecordVersion).all()
    db.$client.pragma('query_only=ON')
    const response = await fetch(app.baseUrl + '/annual?pageSize=1')
    expect(response.status).toBe(200)
    const after = await response.json()
    expect(after.total).toBe(2)
    expect(after.process.latestStepSummary).toMatchObject({ appliedAt: '2024-12-01 09:00:00', status: '待审核' })
    expect(after.process.finalCandidateStepId).toBeNull()
    expect(after.process.finalQualification.status).not.toBe('confirmed')
    expect(after.process.reasons).toContain('latest_status_not_terminal')
    expect(after.sourceGeneration).toBe(readEventAnnualProcess(db, eventId)!.sourceGeneration)
    expect(after.sourceRefs.observations.map((r: any) => r.relationId)).toEqual([early.id, later.id])
    expect(after.sourceRefs.coverage.map((q: any) => q.queryId)).toEqual([early.queryId, later.queryId])
    expect(db.select().from(schema.platformRelation).all()).toEqual(originals)
    expect(db.select().from(schema.platformBusinessRecord).all()).toEqual(businessRecords)
    expect(db.select().from(schema.platformBusinessRecordVersion).all()).toEqual(versions)
    expect(db.select().from(schema.recordCorrespondence).all()).toEqual(decisions)
    expect(db.select().from(schema.recordCorrespondenceAudit).all()).toEqual(audits)
    db.$client.pragma('query_only=OFF')
    db.update(schema.platformQuery).set({ status: 'partial' }).where(eq(schema.platformQuery.id, later.queryId)).run()
    expect(readEventAnnualProcess(db, eventId)!.sourceGeneration).not.toBe(after.sourceGeneration)
  } finally { await app.close() }
})

it('reads the entire scope before paging and keeps original rows source refs and final IDs off-page', async () => {
  const f = fixture()
  const early = f.row(f.query().id, { rawFields: { id: 'SQ-1', sblx: '申请', sqsj: '2024-03-01 09:00:00', cszt: '终审不通过', year: 2024 } })
  const later = f.row(f.query().id, { relationKey: 'SQ-2', rawFields: { id: 'SQ-2', sblx: '申请', sqsj: '2024-12-13 10:00:00', cszt: '终审通过', year: 2024 } })
  await f.project()
  const complete = f.read()
  expect(complete.process.steps.map(s => s.status)).toEqual(['终审不通过', '终审通过'])
  const page = handleEventAnnualProcessRequest({ method: 'GET', id: f.event.id, query: { pageSize: 1 } }, { db: f.db }).body as EventAnnualProcessPage
  expect(page.total).toBe(2); expect(page.process.steps).toHaveLength(1)
  expect(page.process.finalCandidateStepId).toBe(complete.process.steps[1]!.id)
  expect(page.sourceGeneration).toBe(complete.sourceGeneration)
  expect(page.process.latestStepSummary).toEqual({ id: complete.process.steps[1]!.id, year: 2024, declareKind: 'apply', appliedAt: '2024-12-13 10:00:00', status: '终审通过', observedAt: complete.process.steps[1]!.observedAt })
  expect(page.process.steps.some(s => s.id === page.process.latestStepSummary!.id)).toBe(false)
  expect(page.sourceRefs.observations.map(r => r.relationId)).toEqual([early.id, later.id])
  expect(page.process.steps[0]!.groups[0]!.observationRefs[0]).toMatchObject({ relationId: early.id, queryId: early.queryId, sequenceNo: 1, target: { role: 'context_only', titleCode: 'specialized_sme' } })
})

it('uses real shared grouping for duplicate versions and A B A without treating representatives as latest', async () => {
  const f = fixture(), a = f.row(f.query().id)
  const b = f.row(f.query().id, { rawFields: { ...a.rawFields, cszt: '已退回待审核' } })
  const again = f.row(f.query().id)
  await f.project()
  const result = f.read()
  expect(result.process.steps).toHaveLength(1)
  const step = result.process.steps[0]!
  expect(step.groups).toHaveLength(2)
  expect(step.status).toBe('终审通过')
  expect(step.latestObservationRelationIds).toEqual([again.id])
  expect(step.preferredWriteRelationId).toBe(again.id)
  expect(step.groups.find(g => g.observationRefs.some(r => r.relationId === a.id))!.observationRefs.map(r => r.relationId)).toEqual([a.id, again.id])
  expect(step.groups.some(g => g.observationRefs.some(r => r.relationId === b.id))).toBe(true)
})

it('keeps decisions observation-local and source generation stable across correspondence writes', async () => {
  const f = fixture(), first = f.row(f.query().id), again = f.row(f.query().id)
  await f.project()
  const before = f.read()
  const request = { idempotencyKey: 'annual-read-decision', sourceIdentity: 'synthetic', actor: { type: 'agent' as const, id: 'fixture' }, basis: 'isolated test', ruleId: 'manual', ruleVersion: '1', operations: [{ action: 'create' as const, status: 'confirmed' as const, edge: { type: 'event_process' as const, eventId: f.event.id, relationId: first.id, role: 'context_only' as const } }] }
  const plan = preflightRecordCorrespondences(f.db, request)
  const receipt = commitRecordCorrespondences(f.db, request, plan.planHash)
  const after = f.read()
  expect(after.sourceGeneration).toBe(before.sourceGeneration)
  expect(after.sourceRefs).toEqual(before.sourceRefs)
  const refs = after.process.steps[0]!.groups.flatMap(g => g.observationRefs)
  expect(refs.find(r => r.relationId === first.id)!.existingCorrespondences.map(c => c.id)).toEqual(receipt.correspondenceIds)
  expect(refs.find(r => r.relationId === again.id)!.existingCorrespondences).toEqual([])
  expect(after.process.steps[0]!.latestObservationRelationIds).toEqual([again.id])
})

it('changes generation for event evidence coverage versions and scoped observation set changes', async () => {
  const f = fixture(); f.row(f.query().id); await f.project()
  const original = f.read()
  f.db.update(schema.recordEvent).set({ revision: 2 }).where(eq(schema.recordEvent.id, f.event.id)).run()
  const revision = f.read(); expect(revision.sourceGeneration).not.toBe(original.sourceGeneration)
  f.db.update(schema.recordEvidence).set({ page: 3 }).where(eq(schema.recordEvidence.recordEventId, f.event.id)).run()
  const evidence = f.read(); expect(evidence.sourceGeneration).not.toBe(revision.sourceGeneration)
  f.query({ status: 'partial' })
  const coverage = f.read(); expect(coverage.sourceGeneration).not.toBe(evidence.sourceGeneration)
  f.row(f.query().id, { rawFields: { id: 'SQ-1', sblx: '申请', sqsj: '2024-03-01 09:00:00', cszt: '新状态', year: 2024 } }); await f.project()
  const version = f.read(); expect(version.sourceGeneration).not.toBe(coverage.sourceGeneration)
  expect(version.process.steps[0]!.status).toBe('新状态')
  expect(version.sourceRefs.observations).toHaveLength(2)
})

it('scopes owner title and process role before grouping and preserves unresolved possible later rows', async () => {
  const f = fixture(), good = f.row(f.query().id)
  f.row(f.query({ titleCode: 'innovative_sme', rdjb: '1' }).id, { relationKey: 'OTHER-TITLE' })
  f.row(f.query().id, { relationKey: 'OTHER-OWNER', enterpriseId: null, usccRaw: '91330211790043112T' })
  f.row(f.query().id, { relationKey: 'OTHER-KIND', rawFields: { id: 'OTHER-KIND', sblx: '复核', year: 2024, cszt: '终审通过', sqsj: '2024-12-01 09:00:00' } })
  const gap = f.row(f.query().id, { relationKey: 'GAP', rawFields: { id: 'GAP', sblx: '申请', sqsj: '2024-12-13 10:00:00', cszt: '终审通过' } })
  await f.project()
  const result = f.read()
  expect(result.sourceRefs.observations.map(r => r.relationId)).toEqual([good.id, gap.id])
  expect(result.process.steps).toHaveLength(2)
  expect(result.process.latestStepId).toBeNull()
  expect(result.process.finalCandidateStepId).toBeNull()
  expect(result.process.reasons).toContain('potential_later_business_unresolved')
})

it('does not write even preflight ledger data during repeated reads on query-only SQLite', async () => {
  const f = fixture(); f.row(f.query().id); await f.project()
  const changes = f.db.get<{ n: number }>(sql`select total_changes() n`)!.n
  f.db.$client.pragma('query_only=ON')
  const first = f.read()
  for (let i = 0; i < 2; i++) {
    expect(f.read()).toEqual(first)
    expect(handleEventAnnualProcessRequest({ method: 'GET', id: f.event.id }, { db: f.db }).status).toBe(200)
  }
  expect(f.db.get<{ n: number }>(sql`select total_changes() n`)!.n).toBe(changes)
  expect(f.db.select().from(schema.recordCorrespondence).all()).toEqual([])
  expect(f.db.select().from(schema.recordCorrespondenceAudit).all()).toEqual([])
})

it('does not hydrate huge raw responses raw rows or collection rows while scanning only identity covering metadata', async () => {
  const f = fixture(), secret = 'DO-NOT-HYDRATE-' + 'X'.repeat(1024 * 1024)
  const query = f.query({ rawResponse: secret, collectionEvidence: { rows: [{ secret }], completeness: 'complete', fullRange: true, pages: [{ status: 'success', fetchedCount: 1, page: 7, rdjb: '2' }] } as any })
  f.row(query.id, { rawFields: { id: 'SQ-1', sblx: '申请', sqsj: '2024-03-01 09:00:00', cszt: '终审通过', year: 2024, secret } })
  await f.project()
  const statements: string[] = []
  const prepare = f.db.$client.prepare.bind(f.db.$client)
  const spy = vi.spyOn(f.db.$client, 'prepare').mockImplementation(((query: string) => { statements.push(query); return prepare(query) }) as typeof f.db.$client.prepare)
  let result
  try { result = f.read() } finally { spy.mockRestore() }
  expect(JSON.stringify(result)).not.toContain('DO-NOT-HYDRATE')
  expect(result!.process.steps[0]!.groups[0]!.observationRefs[0]!.evidence.source).toMatchObject({ sourcePage: 7, sourceRdjb: '2' })
  expect(JSON.stringify(result).length).toBeLessThan(16000)
  expect(statements.join('\n')).not.toMatch(/raw_response|canonical_raw_json/)
  expect(statements.join('\n')).not.toContain("'$.rows'")
  expect(statements.some(q => q.includes('json_extract("platform_relation"."raw_fields"'))).toBe(true)
  const select = statements.find(q => q.includes('identityOnlySource') || q.includes('platform-verify-aclass'))!
  const queryPlan = f.db.$client.prepare('EXPLAIN QUERY PLAN ' + select).all(...Array.from({ length: (select.match(/\?/g) ?? []).length }, () => 1)) as Array<{ detail: string }>
  expect(queryPlan.some(row => /platform_query_(?:identity_uq|key_idx)/.test(row.detail))).toBe(true)
  expect(queryPlan.some(row => /platform_relation_enterprise_idx/.test(row.detail))).toBe(true)
  expect(queryPlan.some(row => /SCAN platform_relation USING COVERING INDEX platform_relation_uscc_query_idx/.test(row.detail)), JSON.stringify(queryPlan)).toBe(true)
  expect(queryPlan.filter(row => /SCAN platform_relation(?:$|\s)/.test(row.detail)).every(row => /USING COVERING INDEX platform_relation_uscc_query_idx/.test(row.detail))).toBe(true)
})

it('bounds hydrated output with two thousand unrelated large rows and measures exact versus normalized discovery cost', async () => {
  const f = fixture(); f.row(f.query().id); await f.project()
  const before = f.read(), unrelated = f.query({ queryKey: 'name:无关大档', rawResponse: 'PRIVATE-UNRELATED-' + 'R'.repeat(1024 * 1024) })
  const secret = 'PRIVATE-UNRELATED-' + 'X'.repeat(16 * 1024)
  f.db.transaction(() => {
    for (let n = 0; n < 2000; n++) f.row(unrelated.id, { sequenceNo: n + 1, enterpriseId: null, usccRaw: `92${String(n).padStart(16, '0')}`, rawFields: { secret } })
  })
  const r = schema.platformRelation
  const old = f.db.select({ id: r.queryId }).from(r).where(eq(r.usccRaw, f.enterprise.usccNorm!)).toSQL()
  const current = f.db.select({ id: r.queryId }).from(r).where(sql`${normalizedUscc(r.usccRaw)} = ${f.enterprise.usccNorm}`).toSQL()
  const measure = (query: typeof old) => {
    const statement = f.db.$client.prepare(query.sql), plan = f.db.$client.prepare('EXPLAIN QUERY PLAN ' + query.sql).all(...query.params) as Array<{ detail: string }>
    const timings = Array.from({ length: 7 }, () => { const start = performance.now(); expect(statement.all(...query.params)).toHaveLength(1); return performance.now() - start }).sort((a, b) => a - b)
    return { medianMs: timings[3], plan: plan.map(p => p.detail) }
  }
  const exact = measure(old), normalized = measure(current), start = performance.now(), after = f.read(), readMs = performance.now() - start
  expect(exact.plan.some(p => p.includes('SEARCH platform_relation USING COVERING INDEX platform_relation_uscc_query_idx'))).toBe(true)
  expect(normalized.plan).toEqual(['SCAN platform_relation USING COVERING INDEX platform_relation_uscc_query_idx'])
  expect(after).toEqual(before)
  expect(JSON.stringify(after)).not.toContain('PRIVATE-UNRELATED')
  expect(JSON.stringify(after).length).toBeLessThan(16000)
  console.info('annual292-discovery-cost', JSON.stringify({ relationCount: 2001, unrelatedRawBytes: Buffer.byteLength(secret) * 2000, exact, normalized, readMs, resultBytes: Buffer.byteLength(JSON.stringify(after)) }))
})

it.each(['conflicting-status', 'unknown-title'])('retains normalized archived %s without widening other owner title or process kind', async partition => {
  const f = fixture(), early = f.row(f.query().id), variant = '91330211\u200b255994457p'
  const late = f.row(f.query({ queryKey: 'name:未登记旧名', ...(partition === 'unknown-title' ? { interface: 'apply_list', titleCode: null, rdjb: '' } : {}) }).id, { enterpriseId: null, usccRaw: variant, relationKey: 'LATE', status: partition === 'conflicting-status' ? '终审通过' : null, rawFields: { id: 'LATE', sblx: '申请', year: 2024, sqsj: '2024-12-01 09:00:00', cszt: '待审核' } })
  const foreign = f.db.insert(schema.enterprise).values({ name: '其他企业', nameNorm: '其他企业', usccNorm: '91330211790043112T' }).returning().get()
  for (const [name, queryValues, rowValues] of [
    ['owner', {}, { enterpriseId: foreign.id }],
    ['code', {}, { enterpriseId: null, usccRaw: foreign.usccNorm }],
    ['title', { titleCode: 'innovative_sme', rdjb: '1' }, { enterpriseId: null }],
    ['kind', {}, { enterpriseId: null, rawFields: { id: 'kind', sblx: '复核', year: 2024, sqsj: '2024-12-31 09:00:00', cszt: '待审核' } }],
  ] as const) f.row(f.query({ queryKey: `name:unregistered-${name}`, ...queryValues }).id, { usccRaw: variant, relationKey: name, ...rowValues })
  await f.project()
  const result = f.read()
  expect(result.sourceRefs.observations.map(r => r.relationId)).toEqual([early.id, late.id])
  expect(result.process.finalCandidateStepId).toBeNull()
  if (partition === 'unknown-title') expect(result.process.scopeGaps).toMatchObject([{ relationId: late.id, reasons: ['title_scope_unknown'] }])
  else expect(result.process.steps.flatMap(s => s.groups.flatMap(g => g.observationRefs)).find(r => r.relationId === late.id)!.evidence.process).toMatchObject({ status: '待审核', normalizationConflicts: [{ field: 'status', storedValue: '终审通过', rawValue: '待审核' }] })
})

it('excludes only proven identity transcriptions while retaining unindexed unknown business gaps', () => {
  const f = fixture()
  const identity = f.row(f.query().id, { relationKey: null, rawFields: null, sourceText: 'platform-verify-aclass 转写：qymc 名称取证' })
  let result = f.read()
  expect(result.process.steps).toEqual([])
  expect(result.process.excludedIdentityRelationIds).toEqual([identity.id])
  const unknown = f.row(f.query().id, { relationKey: null, rawFields: null, sourceText: '归档说明未知' })
  result = f.read()
  expect(result.process.steps).toHaveLength(1)
  expect(result.process.steps[0]!.groups[0]!.businessRecord.groupState).toBe('not_indexed')
  expect(result.sourceRefs.observations.map(r => r.relationId)).toEqual([identity.id, unknown.id])
  expect(result.process.finalCandidateStepId).toBeNull()
})

it('serves identical read-only HTTP and MCP results with strict bounded parameters and sanitized failures', async () => {
  const f = fixture(); f.row(f.query().id); await f.project()
  const app = await startHttpFixture({ routes: { '/annual': request => handleEventAnnualProcessRequest({ ...request, id: f.event.id }, { db: f.db }) } })
  try {
    const response = await fetch(app.baseUrl + '/annual?pageSize=1')
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual(dispatchEventAnnualProcessMcp({ eventId: f.event.id, pageSize: 1 }, { db: f.db }))
    for (const query of [{ page: 0 }, { pageSize: 201 }, { page: ['1', '2'] }, { asOf: '2026' }, { sourceSet: '1' }, { page: true }]) {
      expect(handleEventAnnualProcessRequest({ method: 'GET', id: f.event.id, query }, { db: f.db }).status).toBe(400)
    }
    expect(handleEventAnnualProcessRequest({ method: 'GET', id: 9007199254740992 }, { db: f.db }).status).toBe(400)
    expect(handleEventAnnualProcessRequest({ method: 'GET', id: 999999 }, { db: f.db }).status).toBe(404)
    expect((await fetch(app.baseUrl + '/annual', { method: 'POST' })).status).toBe(405)
    const fail = { get db(): typeof f.db { throw new Error('SECRET INTERNAL ERROR') } }
    expect(handleEventAnnualProcessRequest({ method: 'GET', id: f.event.id }, fail)).toMatchObject({ status: 500, body: { error: { code: 'internal_error', message: 'Annual process read failed' } } })
    expect(JSON.stringify(dispatchEventAnnualProcessMcp({ eventId: f.event.id }, fail))).not.toContain('SECRET')
  } finally { await app.close() }
})

it('matches typed facts for all seven fields and keeps legacy column drift as a blocking conflict', async () => {
  const f = fixture()
  const raw = { id: 'SQ-1', sblx: '申请', sqsj: '2024-03-01 09:00:00', cszt: '终审通过', year: '2024', whpc: '2024-7', personuuid: '第三批', szsfmc: '浙江省', extra: 'not-a-process-fact' }
  const row = f.row(f.query().id, { rawFields: raw })
  await f.project()
  const source = f.read().process.steps[0]!.groups[0]!.observationRefs[0]!
  expect(source.evidence).toMatchObject({ process: { declareKind: 'apply', appliedAt: '2024-03-01 09:00:00', status: '终审通过', province: '浙江省', normalizationConflicts: [] }, temporal: { relationYear: 2024, relationBatch: '2024-7', awardBatchLabel: '第三批' } })
  f.db.update(schema.platformRelation).set({ status: '终审不通过' }).where(eq(schema.platformRelation.id, row.id)).run()
  const changed = f.read()
  expect(changed.process.finalCandidateStepId).toBeNull()
  expect(changed.process.steps[0]!.groups[0]!.observationRefs[0]!.evidence.process).toMatchObject({ status: '终审通过', normalizationConflicts: [{ field: 'status', storedValue: '终审不通过', rawValue: '终审通过' }] })
})

it('normalizes stored and raw synonyms through the shared seam before annual qualification', async () => {
  const f = fixture()
  f.row(f.query().id, { declareKind: '申请' as any, year: 2024, status: '终审通过', appliedAt: '2024-03-01 09:00:00', rawFields: { id: 'SQ-1', sblx: 'apply', sqsj: '2024-03-01 09:00:00', cszt: '终审通过', year: 2024 } })
  await f.project()
  const result = f.read()
  expect(result.process.steps[0]!.declareKind).toBe('apply')
  expect(result.process.steps[0]!.groups[0]!.observationRefs[0]!.evidence.process).toMatchObject({ normalizationConflicts: [] })
  expect(result.process.finalCandidateStepId).not.toBeNull()
})

it('establishes annual title lineage for native untitled queryList and fills business year without merging interface records', async () => {
  const f = fixture()
  const seed = f.row(f.query().id, { rawFields: { id: 'SQ-1', sblx: '申请', sqsj: '2024-03-01 09:00:00', cszt: '终审通过' } })
  const recipient = f.row(f.query({ interface: 'apply_list', titleCode: null, rdjb: '' }).id)
  await f.project()
  const result = f.read(), step = result.process.steps[0]!
  expect(result.process.steps).toHaveLength(1)
  expect(step.year).toBe(2024)
  expect(result.process.finalCandidateStepId).toBe(step.id)
  expect(step.groups).toHaveLength(2)
  expect(new Set(step.groups.map(g => g.businessRecord.recordId)).size).toBe(2)
  const apply = step.groups.flatMap(g => g.observationRefs).find(r => r.relationId === recipient.id)!
  expect(apply.queryTitleCode).toBeNull()
  expect(apply.evidence.title).toEqual({ official: 'specialized_sme', row: null, corroboratedByRelationIds: [seed.id], basis: 'same_uscc_key_stable_facts' })
  expect(step.corroborationRefs).toContainEqual({ field: 'year', fromRelationIds: [recipient.id], toRelationIds: [seed.id] })
  expect(step.preferredWriteRelationId).toBe(seed.id)
  expect(step.latestVersionRefs.some(v => v.relationIds.includes(seed.id))).toBe(true)
  expect(result.sourceRefs.titleScopeRefs).toEqual([expect.objectContaining({ relationId: seed.id, titleCode: 'specialized_sme' })])
  const originalGeneration = result.sourceGeneration
  f.db.update(schema.platformQuery).set({ titleCode: 'innovative_sme', rdjb: '1' }).where(eq(schema.platformQuery.id, seed.queryId)).run()
  expect(f.read().sourceGeneration).not.toBe(originalGeneration)
})

it('refuses annual title corroboration across two explicit titles keys USCC kinds or application-time conflicts', async () => {
  for (const partition of ['two-titles', 'different-key', 'different-uscc', 'different-kind', 'different-time']) {
    const f = fixture()
    f.row(f.query().id, { rawFields: { id: 'SQ-1', sblx: '申请', sqsj: '2024-03-01 09:00:00', cszt: '终审通过' } })
    if (partition === 'two-titles') f.row(f.query({ titleCode: 'innovative_sme', rdjb: '1' }).id)
    const peer = f.row(f.query({ interface: 'apply_list', titleCode: null, rdjb: '' }).id, { relationKey: partition === 'different-key' ? 'SQ-OTHER' : 'SQ-1', usccRaw: partition === 'different-uscc' ? '91330211790043112T' : f.enterprise.usccNorm, rawFields: { id: partition === 'different-key' ? 'SQ-OTHER' : 'SQ-1', sblx: partition === 'different-kind' ? '复核' : '申请', sqsj: partition === 'different-time' ? '2024-04-01 09:00:00' : '2024-03-01 09:00:00', cszt: '终审通过', year: 2024 } })
    await f.project()
    const result = f.read()
    expect(result.process.steps.flatMap(s => s.groups.flatMap(g => g.observationRefs)).some(r => r.relationId === peer.id)).toBe(false)
    expect(result.process.finalCandidateStepId).toBeNull()
  }
})

it('retains unknown-title possible newer businesses as source gaps instead of choosing an old pass around them', async () => {
  const f = fixture(), seed = f.row(f.query().id)
  const gap = f.row(f.query({ interface: 'apply_list', rdjb: '', titleCode: null }).id, { relationKey: 'SQ-UNKNOWN', rawFields: { id: 'SQ-UNKNOWN', sblx: '申请', year: 2024, sqsj: '2024-12-13 10:00:00', cszt: '待审核' } })
  await f.project()
  const result = f.read()
  expect(result.process.steps).toHaveLength(1)
  expect(result.process.scopeGaps).toEqual([{ relationId: gap.id, queryId: gap.queryId, interface: 'apply_list', year: 2024, declareKind: 'apply', appliedAt: '2024-12-13 10:00:00', reasons: ['title_scope_unknown'] }])
  expect(result.sourceRefs.observations.map(r => r.relationId)).toEqual([seed.id, gap.id])
  expect(result.process.finalCandidateStepId).toBeNull()
  expect(result.process.reasons).toContain('potential_later_title_unknown')
})

it('keeps boolean raw year unknown exactly like full normalization rather than coercing it to a business year', async () => {
  const f = fixture(), row = f.row(f.query().id, { rawFields: { id: 'SQ-1', sblx: '申请', sqsj: '2024-03-01 09:00:00', cszt: '终审通过', year: true } })
  await f.project()
  expect(normalizePlatformRelation('business_list', row).year).toBeNull()
  expect(f.read().process.steps[0]!.year).toBeNull()
  expect(f.read().process.finalCandidateStepId).toBeNull()
})

it('does not turn a missing official USCC into a global blank-USCC archive search', async () => {
  const f = fixture(), own = f.row(f.query().id)
  f.db.update(schema.record).set({ usccRaw: null }).where(eq(schema.record.id, f.record.id)).run()
  f.db.update(schema.enterprise).set({ usccNorm: null }).where(eq(schema.enterprise.id, f.enterprise.id)).run()
  const foreign = f.query({ queryKey: 'name:无关主体' })
  f.row(foreign.id, { enterpriseId: null, usccRaw: null, relationKey: 'UNRELATED', rawFields: { id: 'UNRELATED', sblx: '申请', year: 2024, cszt: '待审核', sqsj: '2024-12-13 10:00:00' } })
  await f.project()
  const result = f.read()
  expect(result.process.coverage.map(q => q.queryId)).toEqual([own.queryId])
  expect(result.sourceRefs.observations.map(r => r.relationId)).toEqual([own.id])
  expect(result.process.finalCandidateStepId).not.toBeNull()
})

it('does not let a later uniquely different-title business become an unknown-title competitor', async () => {
  const f = fixture(), own = f.row(f.query().id)
  const foreignRaw = { id: 'SQ-OTHER', sblx: '申请', year: 2024, sqsj: '2024-12-13 10:00:00', cszt: '待审核' }
  f.row(f.query({ titleCode: 'innovative_sme', rdjb: '1' }).id, { relationKey: 'SQ-OTHER', rawFields: foreignRaw })
  f.row(f.query({ interface: 'apply_list', titleCode: null, rdjb: '' }).id, { relationKey: 'SQ-OTHER', rawFields: foreignRaw })
  await f.project()
  const result = f.read()
  expect(result.process.scopeGaps).toEqual([])
  expect(result.process.latestStepSummary).toMatchObject({ status: '终审通过' })
  expect(result.process.finalCandidateStepId).not.toBeNull()
  expect(result.process.steps.flatMap(s => s.groups.flatMap(g => g.observationRefs.map(r => r.relationId)))).toEqual([own.id])
})

it.each(['query-title', 'native-rdjb'])('rejects dual-title year corroboration even when both observations already have explicit titles: %s', async titleSource => {
  for (const doubleTitle of [false, true]) {
    const f = fixture()
    const seed = f.row(f.query().id, { rawFields: { id: 'SQ-1', sblx: '申请', sqsj: '2024-03-01 09:00:00', cszt: '终审通过' } })
    const recipient = f.row(f.query({ interface: 'apply_list', titleCode: titleSource === 'query-title' ? 'specialized_sme' : null, rdjb: titleSource === 'native-rdjb' ? '2' : '' }).id)
    if (doubleTitle) f.row(f.query({ titleCode: 'innovative_sme', rdjb: '1' }).id)
    await f.project()
    f.db.$client.pragma('query_only=ON')
    const result = f.read(), steps = result.process.steps
    // Independent native-title observations remain visible in either case.
    expect(steps.flatMap(s => s.groups.flatMap(g => g.observationRefs.map(r => r.relationId))).sort((a, b) => a - b)).toEqual([seed.id, recipient.id])
    if (!doubleTitle) {
      expect(steps).toHaveLength(1)
      expect(steps[0]!.year).toBe(2024)
      expect(steps[0]!.corroborationRefs).toContainEqual({ field: 'year', fromRelationIds: [recipient.id], toRelationIds: [seed.id] })
      expect(result.process.finalCandidateStepId).toBe(steps[0]!.id)
    } else {
      expect(steps).toHaveLength(2)
      expect(steps.find(s => s.groups.some(g => g.observationRefs.some(r => r.relationId === seed.id)))!.year).toBeNull()
      expect(steps.find(s => s.groups.some(g => g.observationRefs.some(r => r.relationId === recipient.id)))!.year).toBe(2024)
      expect(steps.flatMap(s => s.corroborationRefs)).toEqual([])
      expect(steps.flatMap(s => s.groups.flatMap(g => g.observationRefs)).map(r => r.conflicts)).toEqual([['title_scope_conflict'], ['title_scope_conflict']])
      expect(new Set(result.sourceRefs.titleScopeRefs.map(r => r.titleCode))).toEqual(new Set(['specialized_sme', 'innovative_sme']))
      expect(result.process.finalCandidateStepId).toBeNull()
    }
  }
})
