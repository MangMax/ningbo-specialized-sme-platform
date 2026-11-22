import { expect, it } from 'vitest'
import { useIsolatedPostgresCases } from '../../support/isolated-postgres-cases'
import * as schema from '../fixtures/postgres-tables'
import { seedPostgresPlatformQuery } from '../../platform/fixtures/postgres-query'
import { processFactsFromRow } from '../../../layers/sme-roster/lib/platform/identity'
import { generatePostgresCandidates } from '../../../layers/sme-roster/server/utils/record-correspondence-candidates-postgres'
import { handleRuntimeEventAnnualProcessRequest, dispatchRuntimeEventAnnualProcessMcp } from '../../../layers/sme-roster/server/utils/event-annual-process-runtime'
import { handlePostgresCorrespondenceRequest } from '../../../layers/sme-roster/server/utils/record-correspondence-runtime'
import { dispatchRecordCorrespondenceMcp } from '../../../layers/sme-roster/server/utils/mcp-record-correspondence'
import { startHttpFixture } from '../../support/http'

const createDb = useIsolatedPostgresCases()

async function fixture(options: { eventType?: 'award' | 'review'; year?: number; decidedYear?: number | null; rawYear?: number } = {}) {
  const db = createDb()
  const enterprise = (await db.insert(schema.enterprise).values({ name: '来源事实合成企业', nameNorm: '来源事实合成企业', usccNorm: '91330211255994457P' }).returning())[0]!
  const record = (await db.insert(schema.record).values({ enterpriseId: enterprise.id, titleCode: 'specialized_sme', source: 'jxj', usccRaw: enterprise.usccNorm }).returning())[0]!
  const event = (await db.insert(schema.recordEvent).values({ recordId: record.id, eventType: options.eventType ?? 'award', year: options.year ?? 2024, decidedYear: options.decidedYear ?? null, reviewOutcome: options.eventType === 'review' ? 'passed' : null }).returning())[0]!
  const rawYear = options.rawYear ?? 2024
  const rawFields = { id: 'SQ-320', sblx: options.eventType === 'review' ? '复核' : '申请', year: String(rawYear), sqsj: '2024-03-01 09:00:00', cszt: '终审通过', whpc: '2024-1' }
  const saved = await seedPostgresPlatformQuery(db, { interface: 'business_list', queryKey: enterprise.usccNorm!, rdjb: '2', titleCode: 'specialized_sme', queriedAt: '2026-10-01T00:00:00Z', status: 'success', rawResponse: JSON.stringify({rows:[rawFields]}), relations: [{ sequenceNo: 1, relationKey: rawFields.id, enterpriseId: enterprise.id, usccRaw: enterprise.usccNorm, nameRaw: enterprise.name, verificationStatus: 'confirmed', matchBasis: 'uscc', ...processFactsFromRow(rawFields), rawFields }] })
  const candidates = () => generatePostgresCandidates(db, { eventId: event.id, queryIds: [saved.queryId], exportBatchIds: [], ruleVersion: '320', page: 1, pageSize: 50 })
  return { db, event, candidates, read: () => dispatchRuntimeEventAnnualProcessMcp({ eventId: event.id }) }
}

it.each([
  { decidedYear: 2024, rawYear: 2024, conflict: null },
  { decidedYear: null, rawYear: 2024, conflict: 'official_decision_year_missing' },
  { decidedYear: 2024, rawYear: 2021, conflict: 'year_mismatch' },
])('uses review conclusion $decidedYear with platform year $rawYear', async ({ decidedYear, rawYear, conflict }) => {
  const f = await fixture({ eventType: 'review', year: 2021, decidedYear, rawYear })
  const row = (await f.candidates())!.rows[0]!
  expect(row.evidence).toMatchObject({ temporal: { eventYear: 2021, awardYear: 2021, decisionYear: decidedYear, comparisonYear: decidedYear, relationYear: rawYear } })
  const conflicts = row.conflicts
  if (!Array.isArray(conflicts)) throw new Error('Candidate did not return a conflicts array')
  expect(conflicts.filter(code => code === 'official_decision_year_missing' || code === 'year_mismatch')).toEqual(conflict ? [conflict] : [])
})

it('annual process consumes the typed business year and keeps the review conclusion year', async () => {
  const f = await fixture({ eventType: 'review', year: 2021, decidedYear: 2024, rawYear: 2024 })
  const read = await f.read() as any
  expect(read.process).toMatchObject({ businessYear: 2024, declareKind: 'review', finalCandidateStepId: expect.any(String) })
  expect(read.process.steps[0]).toMatchObject({ awardYear: 2021, decisionYear: 2024, year: 2024, declareKind: 'review', status: '终审通过' })
  expect(read.process.reasons).not.toContain('potential_later_business_unresolved')
})

it('annual process keeps a missing review conclusion year unknown instead of borrowing the award year', async () => {
  const f = await fixture({ eventType: 'review', year: 2021, decidedYear: null, rawYear: 2024 })
  const read = await f.read() as any
  expect(read.process).toMatchObject({ businessYear: null, finalCandidateStepId: null })
  expect(read.process.reasons).toContain('official_business_year_missing')
})

it('serves the review-year annual process and candidate discovery through real HTTP and MCP', async () => {
  const f = await fixture({ eventType: 'review', year: 2021, decidedYear: 2024, rawYear: 2024 })
  const app = await startHttpFixture({ routes: {
    '/annual': request => handleRuntimeEventAnnualProcessRequest({ ...request, id: f.event.id }),
    '/discover': request => handlePostgresCorrespondenceRequest({ ...request, action: 'discover' }),
  } })
  try {
    const annual = await fetch(app.baseUrl + '/annual')
    expect(annual.status).toBe(200)
    const body = await annual.json()
    expect(body.process).toMatchObject({ businessYear: 2024, declareKind: 'review', finalCandidateStepId: expect.any(String) })
    expect(await dispatchRuntimeEventAnnualProcessMcp({ eventId: f.event.id })).toEqual(body)
    const discovered = await fetch(app.baseUrl + '/discover', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ eventId: f.event.id }) })
    expect(discovered.status).toBe(200)
    const candidates = await discovered.json()
    expect(candidates.rows[0].conflicts).not.toContain('year_mismatch')
    expect(candidates.rows[0].evidence.temporal).toMatchObject({ awardYear: 2021, decisionYear: 2024, comparisonYear: 2024 })
    expect(await dispatchRecordCorrespondenceMcp('discover', { eventId: f.event.id })).toEqual(candidates)
  } finally { await app.close() }
})
