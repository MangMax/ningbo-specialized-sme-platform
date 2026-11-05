import { afterAll, expect, it } from 'vitest'
import { currentExport409Fixture } from './helpers/current-export-409'
import { createCurrentQualificationAssessmentReader, PREVIOUS_QUALIFICATION_ASSESSMENT_VERSION } from '../lib/roster/current-qualification'
const f = currentExport409Fixture()
afterAll(() => f.close())
it('default effective reader survives unavailable legacy decisions while explicit old versions remain readable', () => {
  const c = f.candidate('retired484', [{eventType:'award',year:2025,batchSeq:1}])
  const asOf = Date.parse('2026-11-05T12:00:00Z')
  const old = createCurrentQualificationAssessmentReader(f.db.$client).read(c.enterprise.id,asOf,{assessmentVersion:PREVIOUS_QUALIFICATION_ASSESSMENT_VERSION}).snapshot
  expect(old.assessmentVersion).toBe('enterprise-qualification-407-v2')
  const retired = ['difference_reason','evidence_review_receipt_114']
  for (const table of retired) f.db.$client.exec(`alter table ${table} rename to retired_${table}_484`)
  try {
    const snapshot = createCurrentQualificationAssessmentReader(f.db.$client).read(c.enterprise.id,asOf).snapshot
    expect(snapshot.titles.find(t=>t.titleCode==='specialized_sme')).toMatchObject({group:'eligible',effectiveQualification:{status:'effective'}})
  } finally {
    for (const table of retired.reverse()) f.db.$client.exec(`alter table retired_${table}_484 rename to ${table}`)
  }
})
