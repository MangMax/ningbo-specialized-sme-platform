import { expect, it } from 'vitest'
import { createHash } from 'node:crypto'
// Independent JSON literals for the private cross-request assertion adapter.
import { assertQualificationRowsSnapshotEqual } from '../assertions/current-qualified-rows'
import type { CurrentQualifiedRow } from '../../../layers/sme-roster/lib/roster/current-qualified-page'
import type { CurrentQualificationAssessment } from '../../../layers/sme-roster/lib/roster/current-qualification-model'

function crossRequestLiteralRows(asOf: string): CurrentQualifiedRow[] {
  return [4081, 4082].map(enterpriseId => {
    const titles: CurrentQualificationAssessment[] = ([
      { titleCode: 'little_giant', group: 'eligible', eventId: enterpriseId * 10 + 1 },
      { titleCode: 'specialized_sme', group: 'eligible', eventId: enterpriseId * 10 + 2 },
      { titleCode: 'innovative_sme', group: 'eligible', eventId: enterpriseId * 10 + 3 },
    ] as const).map(({ titleCode, group, eventId }): CurrentQualificationAssessment => ({
      titleCode, group, cycles: [{ originYear: 2025, batchSeq: 1, precision: 'year' }],
      versions: { facts: '1'.repeat(64), sources: '2'.repeat(64), decisions: '3'.repeat(64), observations: '4'.repeat(64) },
      officialQualification: { group, message: 'synthetic_408_formal_status', basis: 'synthetic_408_formal_basis', notes: [] },
      subject: { status: 'not_established', message: '未见主体终止事实', decisionIds: [] },
      region: { status: 'ningbo', message: '合成宁波正式范围', decisionIds: [enterpriseId * 10 + 401] },
      platform: { status: 'not_queried', comparison: 'not_established', message: '未查询不否定正式资格', truncated: false, observations: [] },
      correspondence: { status: 'unmatched', message: '对应不代替资格', refs: [] },
      completeness: { status: 'recorded', message: '合成字段已记录', gaps: [], eventIds: [], fieldGaps: [], publishedNames: [{ evidenceId: eventId + 100, availability: 'captured', nameKnown: true }] },
      evidence: [{ eventId, revision: 1, eventType: 'award', year: 2025, batchSeq: 1, decidedYear: 2025, reviewOutcome: null, evidenceIds: [eventId + 100] }],
      sourceVersions: [{ evidenceId: eventId + 100, eventId, sourceFile: 'synthetic/408/adapter-literal.pdf', storedFileId: null, sha256: null, bytes: null, removedAt: null, capturedRevision: 1, capturedSha256: '5'.repeat(64) }],
      references: [`evidence:${eventId + 100}`], notes: [], shadow: { legacyGroup: group, difference: null },
    }))
    const scope = { enterpriseId, asOf, ruleVersion: 'current-roster-116-v11', assessmentVersion: 'enterprise-qualification-687-v4' }
    return {
      enterpriseId, name: `synthetic_408_adapter_${enterpriseId}`, uscc: null, district: '鄞州区', publishedNames: [`synthetic_408_published_${enterpriseId}`], aliases: ['synthetic_408_confirmed_alias'], firstYear: 2025,
      basis: 'synthetic_408_basis', reviews: '', publication: '已见本称号宁波公布记录', notes: [], references: [`evidence:${enterpriseId * 10 + 103}`], group: 'eligible',
      recognition: { precision: 'year', year: 2025 }, matchedValidYears: [2028], matchedMaintenance: [{ year: 2024, batch: null }],
      qualificationWitnesses: [{ cycle: { originYear: 2025, batchSeq: 1 }, awardEventId: enterpriseId * 10 + 3, recognition: { precision: 'year', year: 2025 }, matchedValidYear: 2028, matchedMaintenance: { year: 2024, batch: null }, correspondenceId: enterpriseId * 10 + 201, conditionQueryId: enterpriseId * 10 + 301 }],
      workbookFacts: { events: [], evidence: [], migration: [{ basis: 'synthetic_408_validity', awardYear: 2025, validFrom: '2025-01-01', validUntil: '2028-12-31', publicationScope: '宁波市' }], platform: [], assessments: [] },
      publishedPresentation: { availability: 'available', error: null, facts: [{ evidenceId: enterpriseId * 10 + 103, eventId: enterpriseId * 10 + 3, revision: 1, availability: 'captured', nameRaw: `synthetic_408_published_${enterpriseId}`, sourceBindingKnown: true }] },
      qualificationAssessment: { ...scope, titles, snapshotId: createHash('sha256').update(JSON.stringify([scope, titles])).digest('hex') },
    }
  })
}
// Independently bind mutated input literals so business controls do not merely
// trip a stale digest. This is not a production assessment/expected generator.
function sealCrossRequestRows(rows: CurrentQualifiedRow[]) {
  for (const { qualificationAssessment: snapshot } of rows) {
    const scope = { enterpriseId: snapshot.enterpriseId, asOf: snapshot.asOf, ruleVersion: snapshot.ruleVersion, assessmentVersion: snapshot.assessmentVersion }
    snapshot.snapshotId = createHash('sha256').update(JSON.stringify([scope, snapshot.titles])).digest('hex')
  }
}
const crossRequestTimes = ['2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.027Z'] as const

it('cross_request_rows_empty_arrays_remain_exact', () => {
  expect(() => assertQualificationRowsSnapshotEqual([], [])).not.toThrow()
})

it('cross_request_rows_validated_times_preserve_complete_input', () => {
  const actual = crossRequestLiteralRows(crossRequestTimes[1]), expected = crossRequestLiteralRows(crossRequestTimes[0])
  // Deliberate top-level collisions must remain nested, not be overwritten by wrapping.
  for (const rows of [actual, expected]) Object.assign(rows[0]!, { enterprise: { originalRowField: 'preserved' }, currentQualifiedRow: { originalRowField: 'preserved' }, futureField: { value: null } })
  const before = structuredClone({ actual, expected })
  expect(() => assertQualificationRowsSnapshotEqual(actual, expected)).not.toThrow()
  expect({ actual, expected }).toStrictEqual(before)
})

it.each<{ id: string; mutate: (rows: CurrentQualifiedRow[]) => void; seal?: boolean }>([
  { id: 'invalid_digest', mutate: rows => { rows[0]!.qualificationAssessment.snapshotId = '0'.repeat(64) } },
  { id: 'identity_mismatch', mutate: rows => { rows[0]!.qualificationAssessment.enterpriseId = 9999 }, seal: true },
  { id: 'nonplain_row', mutate: rows => { Object.setPrototypeOf(rows[0]!, null) } },
])('cross_request_rows_reject_invalid_snapshot_$id', ({ mutate, seal }) => {
  const actual = crossRequestLiteralRows(crossRequestTimes[1]), expected = crossRequestLiteralRows(crossRequestTimes[0])
  mutate(actual)
  if (seal) sealCrossRequestRows(actual)
  const invalidExpected = crossRequestLiteralRows(crossRequestTimes[0])
  mutate(invalidExpected)
  if (seal) sealCrossRequestRows(invalidExpected)
  const before = JSON.stringify({ actual, expected, invalidExpected })
  expect(() => assertQualificationRowsSnapshotEqual(actual, expected)).toThrow()
  // Symmetric validation: neither expected nor actual may contain an invalid T2.
  expect(() => assertQualificationRowsSnapshotEqual(expected, actual)).toThrow()
  // Equally malformed inputs must also fail, rather than passing deep equality.
  expect(() => assertQualificationRowsSnapshotEqual(actual, invalidExpected)).toThrow()
  expect(JSON.stringify({ actual, expected, invalidExpected })).toBe(before)
})

it.each<{ id: string; mutate: (rows: CurrentQualifiedRow[]) => void }>([
  { id: 'row_unknown_extra', mutate: rows => { Object.assign(rows[0]!, { futureContractField: { flag: true } }) } },
  { id: 'row_wrapper_collision', mutate: rows => { Object.assign(rows[0]!, { currentQualifiedRow: { originalRowField: 'new' } }) } },
])('cross_request_rows_reject_business_change_$id', ({ id, mutate }) => {
  const actual = crossRequestLiteralRows(crossRequestTimes[1]), expected = crossRequestLiteralRows(crossRequestTimes[0])
  if (id === 'row_enterprise_collision' || id === 'row_wrapper_collision') {
    for (const rows of [actual, expected]) Object.assign(rows[0]!, { enterprise: { originalRowField: 'old' }, currentQualifiedRow: { originalRowField: 'old' } })
  }
  if (id === 'row_unknown_missing') for (const rows of [actual, expected]) Object.assign(rows[0]!, { futureContractField: { flag: true } })
  mutate(actual)
  sealCrossRequestRows(actual)
  const before = structuredClone({ actual, expected })
  expect(() => assertQualificationRowsSnapshotEqual(actual, expected)).toThrow()
  expect({ actual, expected }).toStrictEqual(before)
})

it.each<{ id: string; mutate: (rows: CurrentQualifiedRow[]) => void }>([
  { id: 'missing_row', mutate: rows => { rows.pop() } },
  { id: 'extra_row', mutate: rows => { rows.push(structuredClone(rows[0]!)) } },
  { id: 'row_order', mutate: rows => { rows.reverse() } },
])('cross_request_rows_reject_array_difference_$id', ({ mutate }) => {
  const actual = crossRequestLiteralRows(crossRequestTimes[1]), expected = crossRequestLiteralRows(crossRequestTimes[0])
  mutate(actual)
  const before = structuredClone({ actual, expected })
  expect(() => assertQualificationRowsSnapshotEqual(actual, expected)).toThrow()
  expect({ actual, expected }).toStrictEqual(before)
})
