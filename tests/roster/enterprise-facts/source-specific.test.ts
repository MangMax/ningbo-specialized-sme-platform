import { initializeDb } from '../../../db/client'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import * as schema from '../../../db/schema'
import { submitNativePlatformQuery } from '../../helpers/native-platform-fixture'
import { generateCandidates } from '../../../server/utils/record-correspondence-candidates'
import { readEventAnnualProcess } from '../../../server/utils/event-annual-process-read'
import { handleEventAnnualProcessRequest, dispatchEventAnnualProcessMcp } from '../../../server/utils/event-annual-process-api'
import { handleRecordCorrespondenceRequest } from '../../../server/utils/record-correspondence-api'
import { dispatchRecordCorrespondenceMcp } from '../../../server/utils/mcp-record-correspondence'
import { startHttpFixture } from '../../helpers/http-fixture'

const cleanup: Array<() => void> = []
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close() })

function fixture(options: { eventType?: 'award' | 'review'; year?: number; decidedYear?: number | null; rawYear?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'source-facts-320-'))
  const db = initializeDb({ create: true, dbPath: join(dir, 'roster.db') })
  cleanup.push(() => { db.$client.close(); rmSync(dir, { recursive: true, force: true }) })
  const enterprise = db.insert(schema.enterprise).values({ name: '来源事实合成企业', nameNorm: '来源事实合成企业', usccNorm: '91330211255994457P' }).returning().get()
  const record = db.insert(schema.record).values({ enterpriseId: enterprise.id, titleCode: 'specialized_sme', source: 'jxj', usccRaw: enterprise.usccNorm }).returning().get()
  const event = db.insert(schema.recordEvent).values({ recordId: record.id, eventType: options.eventType ?? 'award', year: options.year ?? 2024, decidedYear: options.decidedYear ?? null, reviewOutcome: options.eventType === 'review' ? 'passed' : null }).returning().get()
  const rawYear = options.rawYear ?? 2024
  const rawFields = { id: 'SQ-320', sblx: options.eventType === 'review' ? '复核' : '申请', year: String(rawYear), sqsj: '2024-03-01 09:00:00', cszt: '终审通过', whpc: '2024-1' }
  const saved = submitNativePlatformQuery(db, { interface: 'business_list', queryKey: enterprise.usccNorm!, rdjb: '2', titleCode: 'specialized_sme', queriedAt: '2026-10-01T00:00:00Z', status: 'success', rawResponse: JSON.stringify({rows:[rawFields]}), relations: [{ sequenceNo: 1, relationKey: rawFields.id, enterpriseId: enterprise.id, usccRaw: enterprise.usccNorm, nameRaw: enterprise.name, verificationStatus: 'confirmed', matchBasis: 'uscc', rawFields }] })
  const candidates = () => generateCandidates(db, { eventId: event.id, queryIds: [saved.queryId], exportBatchIds: [], ruleVersion: '320', page: 1, pageSize: 50 })!
  return { db, event, candidates, read: () => readEventAnnualProcess(db, event.id) }
}

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
  const f = fixture({ eventType: 'review', year: 2021, decidedYear: 2024, rawYear: 2024 })
  const read = f.read()!
  expect(read.process).toMatchObject({ businessYear: 2024, declareKind: 'review', finalCandidateStepId: expect.any(String) })
  expect(read.process.steps[0]).toMatchObject({ awardYear: 2021, decisionYear: 2024, year: 2024, declareKind: 'review', status: '终审通过' })
  expect(read.process.reasons).not.toContain('potential_later_business_unresolved')
})

it('annual process keeps a missing review conclusion year unknown instead of borrowing the award year', () => {
  const f = fixture({ eventType: 'review', year: 2021, decidedYear: null, rawYear: 2024 })
  const read = f.read()!
  expect(read.process).toMatchObject({ businessYear: null, finalCandidateStepId: null })
  expect(read.process.reasons).toContain('official_business_year_missing')
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
