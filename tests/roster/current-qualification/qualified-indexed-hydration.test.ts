import { afterAll, expect, it } from 'vitest'
import { specializedExportFixture, year } from '../current-export/fixtures/specialized-export'
import { submitNativePlatformQuery } from '../../platform/fixtures/native-query'
import { listCurrentQualified } from '../../../layers/sme-roster/lib/roster/current-qualified-query'
import { readCurrentQualificationAssessment } from '../../../layers/sme-roster/lib/roster/current-qualification'
const f = specializedExportFixture()
afterAll(() => f.close())

it.each([50, 51, 52])('preserves native observation ordering and the public 50-attempt boundary for %i collections', async count => {
  await f.resetBusiness()
  const c = f.candidate('Native coverage ' + count)
  const ids = Array.from({ length: count }, (_, i) => submitNativePlatformQuery(f.db, { interface: 'business_list', queryKey: c.enterprise.usccNorm!, rdjb: '2', titleCode: 'specialized_sme', queriedAt: new Date(Date.UTC(year, 0, 1, 0, 0, i)).toISOString(), status: 'failed', rawResponse: 'Synthetic failed query' }).queryId)
  const actual = listCurrentQualified(f.db.$client, { titleCode: 'specialized_sme' }).rows[0]!.qualificationAssessment
  expect(actual).toEqual(readCurrentQualificationAssessment(f.db.$client, c.enterprise.id, Date.parse(actual.asOf)))
  const platform = actual.titles.find(t => t.titleCode === 'specialized_sme')!.platform
  expect(platform.observations.map(q => q.queryId)).toEqual(ids.reverse().slice(0, 50))
  expect(platform.truncated).toBe(count > 50)
})

it('retains name and explicitly assigned native observations when credit code is absent', async () => {
  await f.resetBusiness()
  const c = f.candidate('No credit code')
  f.db.$client.prepare('update enterprise set uscc_norm=null where id=?').run(c.enterprise.id)
  const named = submitNativePlatformQuery(f.db, { interface: 'apply_list', queryKey: 'name:' + c.enterprise.nameNorm, queriedAt: `${year}-01-01T00:00:00Z`, status: 'failed', rawResponse: 'Synthetic name-query failure' })
  const linked = submitNativePlatformQuery(f.db, { interface: 'apply_list', queryKey: 'different-name', queriedAt: `${year}-01-02T00:00:00Z`, status: 'success', rawResponse: 'Synthetic assigned row', relations: [{ sequenceNo: 1, enterpriseId: c.enterprise.id, matchBasis: 'manual', verificationStatus: 'confirmed' }] })
  const actual = listCurrentQualified(f.db.$client, { titleCode: 'specialized_sme' }).rows[0]!.qualificationAssessment
  expect(actual.titles.map(title => title.platform.observations.map(q => q.queryId))).toEqual([[linked.queryId, named.queryId], [linked.queryId, named.queryId], [linked.queryId, named.queryId]])
})
