import { readPostgresQualifiedAnnualProcess } from '../../../layers/sme-roster/server/utils/event-annual-process-postgres'
import { expect, it } from 'vitest'
import { useIsolatedPostgresCases } from '../../support/isolated-postgres-cases'
import * as schema from '../fixtures/postgres-tables'
import { seedPostgresPlatformQuery } from '../../platform/fixtures/postgres-query'
import { processFactsFromRow } from '../../../layers/sme-roster/lib/platform/identity'

const createDb = useIsolatedPostgresCases()

async function fixture(options: { eventType?: 'award' | 'review'; year?: number; decidedYear?: number | null; rawYear?: number } = {}) {
  const db = createDb()
  const enterprise = (await db.insert(schema.enterprise).values({ name: '来源事实合成企业', nameNorm: '来源事实合成企业', usccNorm: '91330211255994457P' }).returning())[0]!
  const record = (await db.insert(schema.record).values({ enterpriseId: enterprise.id, titleCode: 'specialized_sme', source: 'jxj', usccRaw: enterprise.usccNorm }).returning())[0]!
  const event = (await db.insert(schema.recordEvent).values({ recordId: record.id, eventType: options.eventType ?? 'award', year: options.year ?? 2024, decidedYear: options.decidedYear ?? null, reviewOutcome: options.eventType === 'review' ? 'passed' : null }).returning())[0]!
  const rawYear = options.rawYear ?? 2024
  const rawFields = { id: 'SQ-320', sblx: options.eventType === 'review' ? '复核' : '申请', year: String(rawYear), sqsj: '2024-03-01 09:00:00', cszt: '终审通过', whpc: '2024-1' }
  await seedPostgresPlatformQuery(db, { interface: 'business_list', queryKey: enterprise.usccNorm!, rdjb: '2', titleCode: 'specialized_sme', queriedAt: '2026-10-01T00:00:00Z', status: 'success', rawResponse: JSON.stringify({rows:[rawFields]}), relations: [{ sequenceNo: 1, relationKey: rawFields.id, enterpriseId: enterprise.id, usccRaw: enterprise.usccNorm, nameRaw: enterprise.name, verificationStatus: 'confirmed', matchBasis: 'uscc', ...processFactsFromRow(rawFields), rawFields }] })
  return readPostgresQualifiedAnnualProcess(db, event.id)
}

it('annual process consumes the typed business year and keeps the review conclusion year', async () => {
  const read = (await fixture({ eventType: 'review', year: 2021, decidedYear: 2024, rawYear: 2024 }))!
  expect(read.process).toMatchObject({ businessYear: 2024, declareKind: 'review', finalCandidateStepId: expect.any(String) })
  expect(read.process.steps[0]).toMatchObject({ awardYear: 2021, decisionYear: 2024, year: 2024, declareKind: 'review', status: '终审通过' })
  expect(read.process.reasons).not.toContain('potential_later_business_unresolved')
})

it('annual process keeps a missing review conclusion year unknown instead of borrowing the award year', async () => {
  const read = (await fixture({ eventType: 'review', year: 2021, decidedYear: null, rawYear: 2024 }))!
  expect(read.process).toMatchObject({ businessYear: null, finalCandidateStepId: null })
  expect(read.process.reasons).toContain('official_business_year_missing')
})
