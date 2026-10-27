import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

function object(value: unknown, label: string): Record<string, unknown> {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`)
  assert.equal(Object.getPrototypeOf(value), Object.prototype, `${label} must be a plain detail object`)
  return value as Record<string, unknown>
}

function checkedAssessment(detail: Record<string, unknown>) {
  const assessment = object(detail.qualificationAssessment, 'qualificationAssessment')
  const { enterpriseId, asOf, ruleVersion, assessmentVersion, snapshotId, titles } = assessment
  assert(Number.isSafeInteger(enterpriseId) && (enterpriseId as number) > 0, 'enterpriseId must be a stable positive integer')
  assert.equal(object(detail.enterprise, 'enterprise').id, enterpriseId, 'assessment must belong to the detail enterprise')
  assert(typeof asOf === 'string' && Number.isFinite(Date.parse(asOf)), 'asOf must be a valid ISO execution time')
  assert.equal(new Date(asOf).toISOString(), asOf, 'asOf must use the canonical ISO execution time')
  assert(typeof ruleVersion === 'string' && ruleVersion.trim().length > 0, 'ruleVersion is required')
  assert(typeof assessmentVersion === 'string' && assessmentVersion.trim().length > 0, 'assessmentVersion is required')
  assert(Array.isArray(titles), 'titles must be an array')
  // Property order is part of #406's digest contract. Hash every title field,
  // including versions and fields this helper does not yet know about.
  const scope = { enterpriseId, asOf, ruleVersion, assessmentVersion }
  const digest = createHash('sha256').update(JSON.stringify([scope, titles])).digest('hex')
  assert.equal(snapshotId, digest, 'snapshotId must bind its own complete scope and titles')
  return assessment
}

/**
 * Test-only comparison of enterprise details from current-fact reads.
 * Different execution times are allowed only when every business field agrees.
 * This cannot equate results across a validity boundary or replay historical DB state.
 * Inputs are never changed; legacy details retain ordinary strict deep equality.
 */
export function assertEnterpriseDetailSnapshotEqual(actual: unknown, expected: unknown): void {
  const hasAssessment = (value: unknown) => value !== null && typeof value === 'object'
    && Object.hasOwn(value, 'qualificationAssessment')
  if (!hasAssessment(actual) && !hasAssessment(expected)) {
    assert.deepStrictEqual(actual, expected)
    return
  }
  assert(hasAssessment(actual) && hasAssessment(expected), 'both details must contain qualificationAssessment')
  const actualDetail = object(actual, 'actual detail')
  const expectedDetail = object(expected, 'expected detail')
  const actualAssessment = checkedAssessment(actualDetail)
  const expectedAssessment = checkedAssessment(expectedDetail)
  // Validate first, then replace only the two permitted execution identities.
  // Spreads retain all other own enumerable DTO fields, including unknown additions.
  assert.deepStrictEqual(
    { ...actualDetail, qualificationAssessment: { ...actualAssessment, asOf: null, snapshotId: null } },
    { ...expectedDetail, qualificationAssessment: { ...expectedAssessment, asOf: null, snapshotId: null } },
  )
}
