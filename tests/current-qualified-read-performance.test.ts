import { afterAll, expect, it } from 'vitest'
import { currentExport118Fixture, year } from './helpers/current-export-118'
import { listCurrentQualified } from '../lib/roster/current-qualified-query'
import { readCurrentQualificationAssessment } from '../lib/roster/current-qualification'
const f = currentExport118Fixture()
afterAll(() => f.close())

it('pages a full candidate set while retaining source history and independent cross-title eligibility', async () => {
  await f.resetBusiness()
  const candidates = Array.from({ length: 251 }, (_, i) => f.candidate('Native page ' + i))
  const inherited = f.candidate('Inherited', [{ eventType: 'award', year: year - 8, batchSeq: 1 }])
  f.addRecord(inherited.enterprise.id, inherited.enterprise.name, [{ eventType: 'award', year, batchSeq: 1 }], 'little_giant')
  const first = listCurrentQualified(f.db.$client, { titleCode: 'specialized_sme', page: 1, pageSize: 200 })
  const second = listCurrentQualified(f.db.$client, { titleCode: 'specialized_sme', page: 2, pageSize: 200 })
  expect(first.total).toBe(252)
  expect(second.total).toBe(252)
  expect([...first.rows, ...second.rows].map(row => row.enterpriseId)).toEqual([...candidates.map(c => c.enterprise.id), inherited.enterprise.id])
  expect(second.rows.at(-1)!.qualificationAssessment).toEqual(readCurrentQualificationAssessment(f.db.$client, inherited.enterprise.id, Date.parse(second.rows.at(-1)!.qualificationAssessment.asOf)))
  expect(second.rows.at(-1)!.notes.join(' ')).toContain('按有效小巨人资格计入')
  expect(first.options.recognitionYears).toEqual([year - 8, year])
})
