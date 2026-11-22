import { expect, it } from 'vitest'
import { platformBusinessFact, sourceDate, periodContains } from '../../../layers/sme-roster/lib/roster/platform-qualification'

it('retains day boundaries and exact business timestamps without fabricating precision', () => {
  expect(sourceDate('2026-12-28')).toEqual({ raw: '2026-12-28', value: '2026-12-28', precision: 'day' })
  expect(sourceDate('2023-12-28 08:50:25')).toEqual({ raw: '2023-12-28 08:50:25', value: '2023-12-28T08:50:25', precision: 'second' })
  expect(periodContains(sourceDate('2023-12-28 08:50:25'), sourceDate('2026-12-28'), '2026-12-28T23:59:59')).toBe(true)
  expect(periodContains(sourceDate('2023-12-28 08:50:25'), sourceDate('2026-12-28'), '2026-12-29T00:00:00')).toBe(false)
  expect(periodContains(sourceDate('2023-12-28 08:50:25'), sourceDate('2026-12-28'), '2023-12-28T08:50:24')).toBe(false)
  expect(periodContains(sourceDate('2023-12-28 08:50:25'), sourceDate('2026-12-28'), '2023-12-28T08:50:25')).toBe(true)
  expect(sourceDate('2026-02-30')).toEqual({ raw: '2026-02-30', value: null, precision: 'unknown' })
})

it('interprets archived businessList final review without inventing its missing year', () => {
  // Archived SQ332024082317756: year is empty, sqsj is submission time.
  expect(platformBusinessFact('business_list', { declareKind: 'review', status: '终审通过', year: null, appliedAt: '2024-09-14 13:59:23' })).toMatchObject({ matter: 'review', conclusion: 'passed', businessYear: null, periodReason: 'period_unknown' })
})
it('interprets queryList explicit year separately from intermediate provincial review', () => {
  expect(platformBusinessFact('apply_list', { declareKind: 'apply', status: '终审通过', year: 2021, appliedAt: '2021-05-03 08:06:00' })).toMatchObject({ matter: 'apply', conclusion: 'passed', businessYear: 2021, periodReason: 'explicit_business_year' })
  expect(platformBusinessFact('apply_list', { declareKind: 'review', status: '省已审', year: 2024, appliedAt: null })).toMatchObject({ conclusion: 'processing', statusRaw: '省已审' })
})
it('retains unknown source status and never renews from an update or submission time', () => {
  expect(platformBusinessFact('business_list', { declareKind: 'update', status: '终审通过', year: 2026, appliedAt: '2026-01-01' })).toMatchObject({ matter: 'update', conclusion: 'passed', businessYear: 2026, periodReason: 'update_does_not_renew' })
  expect(platformBusinessFact('apply_list', { declareKind: '新事项', status: '新状态 ', year: null, appliedAt: '2026-01-01' })).toMatchObject({ matter: 'unknown', conclusion: 'unknown', statusRaw: '新状态 ', matterRaw: '新事项', businessYear: null })
})
