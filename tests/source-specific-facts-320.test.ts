import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { schema, useDb } from '../db'
import { ensurePlatformObservation } from '../server/utils/platform-business-record'
import { generateCandidates } from '../server/utils/record-correspondence-candidates'
import { readEventAnnualProcess } from '../server/utils/event-annual-process-read'
import { handleEventAnnualProcessRequest, dispatchEventAnnualProcessMcp } from '../server/utils/event-annual-process-api'
import { handleRecordCorrespondenceRequest } from '../server/utils/record-correspondence-api'
import { dispatchRecordCorrespondenceMcp } from '../server/utils/mcp-record-correspondence'
import { startHttpFixture } from './helpers/http-fixture'

const cleanup: Array<() => void> = []
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close() })

function fixture(options: { eventType?: 'award' | 'review'; year?: number; decidedYear?: number | null; rawYear?: number; storedYear?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'source-facts-320-'))
  const db = useDb({ dbPath: join(dir, 'roster.db') })
  cleanup.push(() => { db.$client.close(); rmSync(dir, { recursive: true, force: true }) })
  const enterprise = db.insert(schema.enterprise).values({ name: '来源事实合成企业', nameNorm: '来源事实合成企业', usccNorm: '91330211255994457P' }).returning().get()
  const record = db.insert(schema.record).values({ enterpriseId: enterprise.id, titleCode: 'specialized_sme', source: 'jxj', usccRaw: enterprise.usccNorm }).returning().get()
  const event = db.insert(schema.recordEvent).values({ recordId: record.id, eventType: options.eventType ?? 'award', year: options.year ?? 2024, decidedYear: options.decidedYear ?? null, reviewOutcome: options.eventType === 'review' ? 'passed' : null }).returning().get()
  const query = db.insert(schema.platformQuery).values({ interface: 'business_list', queryKey: enterprise.usccNorm!, rdjb: '2', titleCode: 'specialized_sme', queriedAt: '2026-10-01T00:00:00Z', status: 'success' }).returning().get()
  const rawYear = options.rawYear ?? 2024
  const relation = db.insert(schema.platformRelation).values({ queryId: query.id, sequenceNo: 1, relationKey: 'SQ-320', enterpriseId: enterprise.id, usccRaw: enterprise.usccNorm, nameRaw: enterprise.name, verificationStatus: 'confirmed', matchBasis: 'uscc', declareKind: 'review', year: options.storedYear ?? rawYear, status: '已退回', appliedAt: '2020-01-01', rawFields: { id: 'SQ-320', sblx: options.eventType === 'review' ? '复核' : '申请', year: String(rawYear), sqsj: '2024-03-01 09:00:00', cszt: '终审通过', whpc: '2024-1' } }).returning().get()
  ensurePlatformObservation(db, relation.id)
  const candidates = () => generateCandidates(db, { eventId: event.id, queryIds: [query.id], exportBatchIds: [], ruleVersion: '320', page: 1, pageSize: 50 })!
  return { db, event, query, relation, candidates, read: () => readEventAnnualProcess(db, event.id) }
}

it('candidate facts come from the typed projection, not legacy stored columns', () => {
  const f = fixture({ rawYear: 2024, storedYear: 2023 })
  const row = f.candidates().rows[0] as any
  expect(row.evidence.temporal).toMatchObject({ relationYear: 2024, awardYear: 2024, decisionYear: null, comparisonYear: 2024 })
  expect(row.evidence.process).toMatchObject({ declareKind: 'apply', appliedAt: '2024-03-01 09:00:00', status: '终审通过', normalizationConflicts: [] })
  expect(row.conflicts).not.toContain('year_mismatch')
  expect(row.conflicts).not.toContain('platform_field_conflict')
})

it('uses the review conclusion year, never the original award year, for year_mismatch', () => {
  const matching = fixture({ eventType: 'review', year: 2021, decidedYear: 2024, rawYear: 2024 })
  const row = matching.candidates().rows[0] as any
  expect(row.evidence.temporal).toMatchObject({ eventYear: 2021, awardYear: 2021, decisionYear: 2024, comparisonYear: 2024, relationYear: 2024 })
  expect(row.conflicts).not.toContain('year_mismatch')
  expect(row.conflicts).not.toContain('official_decision_year_missing')

  const unknown = fixture({ eventType: 'review', year: 2021, decidedYear: null, rawYear: 2024 })
  const unknownRow = unknown.candidates().rows[0] as any
  expect(unknownRow.conflicts).toContain('official_decision_year_missing')
  expect(unknownRow.conflicts).not.toContain('year_mismatch')

  const mismatch = fixture({ eventType: 'review', year: 2021, decidedYear: 2024, rawYear: 2021 })
  const mismatchRow = mismatch.candidates().rows[0] as any
  expect(mismatchRow.evidence.temporal).toMatchObject({ decisionYear: 2024, comparisonYear: 2024, relationYear: 2021 })
  expect(mismatchRow.conflicts).toContain('year_mismatch')
})

it('annual process consumes the typed business year and keeps the review conclusion year', () => {
  const f = fixture({ eventType: 'review', year: 2021, decidedYear: 2024, rawYear: 2024, storedYear: 2023 })
  const read = f.read()!
  expect(read.process).toMatchObject({ businessYear: 2024, declareKind: 'review', finalCandidateStepId: expect.any(String) })
  expect(read.process.steps[0]).toMatchObject({ year: 2024, declareKind: 'review', status: '终审通过' })
  expect(read.process.reasons).not.toContain('potential_later_business_unresolved')
})

it('annual process keeps a missing review conclusion year unknown instead of borrowing the award year', () => {
  const f = fixture({ eventType: 'review', year: 2021, decidedYear: null, rawYear: 2024 })
  const read = f.read()!
  expect(read.process).toMatchObject({ businessYear: null, finalCandidateStepId: null })
  expect(read.process.reasons).toContain('official_business_year_missing')
})

it('reads source facts only for the already-scoped relations', () => {
  const f = fixture()
  const otherQuery = f.db.insert(schema.platformQuery).values({ interface: 'business_list', queryKey: '91330211790043112T', rdjb: '2', titleCode: 'specialized_sme', queriedAt: '2026-10-02T00:00:00Z', status: 'success' }).returning().get()
  const other = f.db.insert(schema.platformRelation).values({ queryId: otherQuery.id, sequenceNo: 1, relationKey: 'OTHER-320', enterpriseId: null, usccRaw: '91330211790043112T', verificationStatus: 'pending', matchBasis: 'none', rawFields: { id: 'OTHER-320', sblx: '申请', year: '2024', sqsj: '2024-03-01 09:00:00', cszt: '终审通过' } }).returning().get()
  ensurePlatformObservation(f.db, other.id)
  const calls: Array<{ sql: string; params: unknown[] }> = []
  const prepare = f.db.$client.prepare.bind(f.db.$client)
  f.db.$client.prepare = ((sql: string) => {
    const statement = prepare(sql)
    for (const method of ['all', 'get'] as const) {
      const run = statement[method].bind(statement)
      Object.assign(statement, { [method]: (...params: unknown[]) => { calls.push({ sql, params }); return run(...params) } })
    }
    return statement
  }) as typeof prepare
  try { f.candidates() } finally { f.db.$client.prepare = prepare }
  const factCalls = calls.filter(call => call.sql.includes('platform_business_projection'))
  expect(factCalls.length).toBeGreaterThan(0)
  expect(factCalls.flatMap(call => call.params)).toEqual([f.relation.id])
  expect(factCalls.flatMap(call => call.params)).not.toContain(other.id)
})

it('serves the review-year annual process and candidate discovery through real HTTP and MCP', async () => {
  const f = fixture({ eventType: 'review', year: 2021, decidedYear: 2024, rawYear: 2024 })
  const app = await startHttpFixture({ routes: {
    '/annual': request => handleEventAnnualProcessRequest({ ...request, id: f.event.id }, { db: f.db }),
    '/discover': request => handleRecordCorrespondenceRequest({ ...request, action: 'discover' }, { db: f.db }),
  } })
  try {
    const annual = await fetch(app.baseUrl + '/annual')
    expect(annual.status).toBe(200)
    const body = await annual.json()
    expect(body.process).toMatchObject({ businessYear: 2024, declareKind: 'review', finalCandidateStepId: expect.any(String) })
    expect(dispatchEventAnnualProcessMcp({ eventId: f.event.id }, { db: f.db })).toEqual(body)
    const discovered = await fetch(app.baseUrl + '/discover', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ eventId: f.event.id }) })
    expect(discovered.status).toBe(200)
    const candidates = await discovered.json()
    expect(candidates.rows[0].conflicts).not.toContain('year_mismatch')
    expect(candidates.rows[0].evidence.temporal).toMatchObject({ awardYear: 2021, decisionYear: 2024, comparisonYear: 2024 })
    expect(dispatchRecordCorrespondenceMcp('discover', { eventId: f.event.id }, { db: f.db })).toEqual(candidates)
  } finally { await app.close() }
})
