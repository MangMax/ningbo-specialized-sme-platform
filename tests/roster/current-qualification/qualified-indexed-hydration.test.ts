import { afterAll, expect, it } from 'vitest'
import { specializedExportFixture, year } from '../current-export/fixtures/specialized-export'
import { seedPostgresPlatformQuery } from '../../platform/fixtures/postgres-query'
import { listPostgresCurrentQualified } from '../../../layers/sme-roster/lib/roster/current-qualified-query-postgres'
import { readPostgresCurrentDetailBatch } from '../../../layers/sme-roster/lib/roster/current-qualification-postgres'
const f = specializedExportFixture()
afterAll(() => f.close())

it.each([50, 51, 52])('retains only the latest same-scope attempt in qualification after %i collections', async count => {
  await f.resetBusiness()
  const c = await f.candidate('Native coverage ' + count)
  const ids = []
  for (let i = 0; i < count; i++) ids.push((await seedPostgresPlatformQuery(f.db, { interface: 'business_list', queryKey: c.enterprise.usccNorm!, rdjb: '2', titleCode: 'specialized_sme', queriedAt: new Date(Date.UTC(year, 0, 1, 0, 0, i)).toISOString(), status: 'failed', rawResponse: 'Synthetic failed query' })).queryId)
  const actual = (await listPostgresCurrentQualified(f.db, { titleCode: 'specialized_sme' })).rows[0]!.qualificationAssessment
  expect(actual).toEqual(await f.db.transaction(async tx => (await readPostgresCurrentDetailBatch(tx, [c.enterprise.id], 'specialized_sme', Date.parse(actual.asOf))).get(c.enterprise.id)?.snapshot, { isolationLevel: 'repeatable read' }))
  const platform = actual.titles.find(t => t.titleCode === 'specialized_sme')!.platform
  expect(platform.observations.map(q => q.queryId)).toEqual([ids.at(-1)])
  expect(platform.truncated).toBe(false)
})

it('retains name and explicitly assigned native observations when credit code is absent', async () => {
  await f.resetBusiness()
  const c = await f.candidate('No credit code')
  await f.runtimeQuery('update business.enterprise set uscc_norm = null where id = $1', [c.enterprise.id])
  const named = await seedPostgresPlatformQuery(f.db, { interface: 'apply_list', queryKey: 'name:' + c.enterprise.nameNorm, queriedAt: `${year}-01-01T00:00:00Z`, status: 'failed', rawResponse: 'Synthetic name-query failure' })
  const linked = await seedPostgresPlatformQuery(f.db, { interface: 'apply_list', queryKey: 'different-name', queriedAt: `${year}-01-02T00:00:00Z`, status: 'success', rawResponse: 'Synthetic assigned row', relations: [{ sequenceNo: 1, enterpriseId: c.enterprise.id, matchBasis: 'manual', verificationStatus: 'confirmed' }] })
  const actual = (await listPostgresCurrentQualified(f.db, { titleCode: 'specialized_sme' })).rows[0]!.qualificationAssessment
  expect(actual.titles.map(title => title.platform.observations.map(q => q.queryId))).toEqual([[linked.queryId, named.queryId], [linked.queryId, named.queryId], [linked.queryId, named.queryId]])
})

it('uses only current stored facts when two queries share the same process content', async () => {
  await f.resetBusiness()
  const { enterprise } = await f.candidate('Repeated process version')
  const query = {
    interface: 'business_list', queryKey: enterprise.usccNorm!, rdjb: '2', titleCode: 'specialized_sme',
    status: 'success', rawResponse: '{}',
  } as const
  const relation = {
    sequenceNo: 1, relationKey: 'same-process', enterpriseId: enterprise.id,
    usccRaw: enterprise.usccNorm!, nameRaw: enterprise.name, matchBasis: 'uscc', verificationStatus: 'confirmed',
    rawFields: { id: 'same-process', rdjb: '2', qymc: enterprise.name, tyshxydm: enterprise.usccNorm!, year: 2024 },
  } as const
  await seedPostgresPlatformQuery(f.db, {
    ...query, queriedAt: `${year}-01-01T00:00:00Z`, relations: [relation],
  })
  const second = await seedPostgresPlatformQuery(f.db, {
    ...query, queriedAt: `${year}-01-02T00:00:00Z`,
    relations: [{ ...relation, status: '终审未通过', batch: '2023-3' }],
  })

  const result = await listPostgresCurrentQualified(f.db, { titleCode: 'specialized_sme' })
  const observations = result.rows[0]!.qualificationAssessment.titles
    .find(title => title.titleCode === 'specialized_sme')!.platform.observations
  expect(observations.map(({ queryId, rows }) => ({ queryId, rows }))).toEqual([
    { queryId: second.queryId, rows: [{ relationId: second.relationIds[0], status: '终审未通过', year: 2024, batch: '2023-3' }] },
  ])
})
