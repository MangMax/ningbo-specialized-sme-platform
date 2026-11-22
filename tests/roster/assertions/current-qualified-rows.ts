import assert408 from 'node:assert/strict'
import { assertEnterpriseDetailSnapshotEqual } from './enterprise-detail-snapshot'

function currentQualifiedObject408(value: unknown, label: string): Record<string, unknown> {
  assert408(value !== null && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`)
  assert408.equal(Object.getPrototypeOf(value), Object.prototype, `${label} must be a plain object`)
  return value as Record<string, unknown>
}

/** Validate complete T2 first; only the shared helper may normalize asOf/digest.
 * Every other own enumerable row field, including future or wrapper-named keys,
 * stays inside currentQualifiedRow and participates in strict deep equality.
 */
export function assertQualificationRowsSnapshotEqual(actual: unknown, expected: unknown): void {
  assert408(Array.isArray(actual), 'actual current-qualified rows must be an array')
  assert408(Array.isArray(expected), 'expected current-qualified rows must be an array')
  assert408.equal(actual.length, expected.length, 'current-qualified row counts must agree')
  const wrap = (value: unknown, label: string) => {
    const row = currentQualifiedObject408(value, label)
    assert408(Object.hasOwn(row, 'enterpriseId'), `${label} must own enterpriseId`)
    assert408(Object.hasOwn(row, 'qualificationAssessment'), `${label} must own qualificationAssessment`)
    const { qualificationAssessment, ...currentQualifiedRow } = row
    const assessment = currentQualifiedObject408(qualificationAssessment, `${label}.qualificationAssessment`)
    assert408(Array.isArray(assessment.titles), `${label}.titles must be an array`)
    const titles: unknown[] = assessment.titles
    const titleCodes = titles.map((value, index) => {
      const title = currentQualifiedObject408(value, `${label}.titles[${index}]`)
      const versions = currentQualifiedObject408(title.versions, `${label}.titles[${index}].versions`)
      for (const field of ['facts', 'sources', 'decisions', 'observations'] as const) {
        const version = versions[field]
        assert408(Object.hasOwn(versions, field) && typeof version === 'string' && version.trim().length > 0, `${label}.${field} version is required`)
      }
      return title.titleCode
    })
    assert408.deepStrictEqual(titleCodes, ['little_giant', 'specialized_sme', 'innovative_sme'], `${label} must retain all three titles in canonical order`)
    return { enterprise: { enterpriseId: row.enterpriseId }, qualificationAssessment: assessment, currentQualifiedRow }
  }
  for (let index = 0; index < actual.length; index++) {
    assertEnterpriseDetailSnapshotEqual(wrap(actual[index], `actual row ${index}`), wrap(expected[index], `expected row ${index}`))
  }
}
