import { afterAll, expect, it } from 'vitest'
import { specializedExportFixture, year } from '../current-export/fixtures/specialized-export'
import { listPostgresCurrentQualified } from '../../../layers/sme-roster/lib/roster/current-qualified-query-postgres'
import { readPostgresCurrentDetailBatch } from '../../../layers/sme-roster/lib/roster/current-qualification-postgres'
const f = specializedExportFixture()
afterAll(() => f.close())

it('pages a full candidate set while retaining source history and independent cross-title eligibility', async () => {
  await f.resetBusiness()
  const candidates = []
  for (let i = 0; i < 251; i++) candidates.push(await f.candidate('Native page ' + i))
  const inherited = await f.candidate('Inherited', [{ eventType: 'award', year: year - 8, batchSeq: 1 }])
  await f.addRecord(inherited.enterprise.id, inherited.enterprise.name, [{ eventType: 'award', year, batchSeq: 1 }], 'little_giant')
  const first = await listPostgresCurrentQualified(f.db, { titleCode: 'specialized_sme', page: 1, pageSize: 200 })
  const second = await listPostgresCurrentQualified(f.db, { titleCode: 'specialized_sme', page: 2, pageSize: 200 })
  expect(first.total).toBe(252)
  expect(second.total).toBe(252)
  expect([...first.rows, ...second.rows].map(row => row.enterpriseId)).toEqual([...candidates.map(c => c.enterprise.id), inherited.enterprise.id])
  expect(second.rows.at(-1)!.qualificationAssessment).toEqual(await f.db.transaction(async tx => (await readPostgresCurrentDetailBatch(tx, [inherited.enterprise.id], 'specialized_sme', Date.parse(second.rows.at(-1)!.qualificationAssessment.asOf))).get(inherited.enterprise.id)?.snapshot, { isolationLevel: 'repeatable read' }))
  expect(second.rows.at(-1)!.notes.join(' ')).toContain('按有效小巨人资格计入')
  expect(first.options.recognitionYears).toEqual([year - 8, year])
})
