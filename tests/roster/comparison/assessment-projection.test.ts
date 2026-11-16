import { currentDecision102, currentDecisionState102, currentDecisions102, currentDecisionStates102 } from '../../../server/utils/decision-lifecycle-102'
import { readEvidenceImpact113, readEvidenceImpacts113 } from '../../../server/utils/evidence-impact-113'
import { submitNativePlatformQuery } from '../../platform/fixtures/native-query'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { initializeDb, schema as s } from '../../../db/client'
import { readWholeComparisonSummary } from '../../../lib/comparison-summary-read'
import { readQueryAssessment, readQueryAssessmentSummaries, readQueryAssessments } from '../../../lib/roster/query-assessment'

const cleanup: Array<() => void> = []
afterEach(() => { vi.restoreAllMocks(); for (const close of cleanup.splice(0)) close() })
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'comparison-assessment-projection-'))
  const db = initializeDb({ create: true,  dbPath: join(dir, 'synthetic.db') })
  cleanup.push(() => { db.$client.close(); rmSync(dir, { recursive: true }) })
  const enterprise = db.insert(s.enterprise).values({ name: '合成投影企业', nameNorm: '合成投影企业', usccNorm: 'SYNTHETIC-PROJECTION' }).returning().get()
  db.insert(s.record).values({ enterpriseId: enterprise.id, titleCode: 'specialized_sme', source: 'jxj' }).run()
  const scope = { enterpriseId: enterprise.id, titleCode: 'specialized_sme' as const, direction: 'missing_in_miit' as const }
  const summary = () => readWholeComparisonSummary(db, { curatedPath: join(dir, 'curated.json'), reconcilePath: join(dir, 'reconcile.json'), showCurated: true, page: 1, pageSize: 1 }).rows[0]!
  return { db, scope, summary }
}

it('keeps private decision bodies out of comparison summary states', () => {
  const { db, scope, summary } = fixture()
  const large = 'SYNTHETIC_PRIVATE_DECISION_'.repeat(40000)
  db.insert(s.differenceReason).values({ ...scope, status: 'needs_review', measureCode: 'manual_review', recordedAt: '2026-10-21T00:00:00Z',
    reasonNote: large, measureNote: large, basis: large, actor: { type: 'agent', id: large },
    currentQualification: { titleCode: scope.titleCode, validFrom: '2026-01-01T00:00:00Z', validUntil: '2027-01-01T00:00:00Z', basis: large, publicationCheck: { status: 'not_checked', scope: large } },
  }).run()
  // Negative control: default/full assessment must still preserve these fields.
  expect(readQueryAssessments(db, [scope])[0]!.currentDecision.current).toMatchObject({ reasonNote: large, measureNote: large, basis: large, actor: { id: large }, currentQualification: { basis: large } })
  const actual = summary()
  expect(actual.assessment).toEqual({ queryCoverage: { status: 'not_queried' }, assessment: 'decided', explanationValidity: { status: 'unknown' } })
  expect(JSON.stringify(actual)).not.toContain('SYNTHETIC_PRIVATE_DECISION_')
})

it.each([
  { name: 'absent decision', expectedAssessment: 'not_queried', expectedValidity: 'not_applicable', decision: false, failed: false, withdrawn: false, reviewed: null, latest: 0, pending: 0, classification: 'evidence_changed' },
  { name: 'failed query', expectedAssessment: 'unknown', expectedValidity: 'not_applicable', decision: false, failed: true, withdrawn: false, reviewed: null, latest: 0, pending: 0, classification: 'evidence_changed' },
  { name: 'withdrawn decision', expectedAssessment: 'withdrawn', expectedValidity: 'not_applicable', decision: true, failed: false, withdrawn: true, reviewed: null, latest: 0, pending: 0, classification: 'evidence_changed' },
  { name: 'invalid not-queried premise', expectedAssessment: 'decided', expectedValidity: 'premise_invalid', decision: true, failed: true, withdrawn: false, reviewed: null, latest: 0, pending: 0, classification: 'evidence_changed' },
  { name: 'reviewed valid baseline', expectedAssessment: 'decided', expectedValidity: 'valid', decision: true, failed: false, withdrawn: false, reviewed: 10, latest: 10, pending: 0, classification: 'evidence_changed' },
  { name: 'changed evidence', expectedAssessment: 'decided', expectedValidity: 'evidence_changed', decision: true, failed: false, withdrawn: false, reviewed: 10, latest: 11, pending: 0, classification: 'evidence_changed' },
  { name: 'invalidated premise', expectedAssessment: 'decided', expectedValidity: 'premise_invalid', decision: true, failed: false, withdrawn: false, reviewed: 10, latest: 11, pending: 0, classification: 'premise_invalid' },
  { name: 'unfinished evidence projection', expectedAssessment: 'decided', expectedValidity: 'evidence_changed', decision: true, failed: false, withdrawn: false, reviewed: 10, latest: 10, pending: 1, classification: 'evidence_changed' },
] as const)('keeps summary and full assessment semantics equal for $name', ({ decision, failed, withdrawn, reviewed, latest, pending, classification, expectedAssessment, expectedValidity }) => {
  const { db, scope, summary } = fixture()
  if (failed) submitNativePlatformQuery(db, { rawResponse: '{}', interface: 'business_list', queryKey: 'SYNTHETIC-PROJECTION', rdjb: '2', titleCode: scope.titleCode, queriedAt: '2026-10-21T00:00:00Z', status: 'failed' })
  if (decision) {
    const row = db.insert(s.differenceReason).values({ ...scope, status: 'not_queried', recordedAt: '2026-10-21T00:00:00Z', lifecycleAction: withdrawn ? 'withdraw' : 'replace' }).returning().get()
    if (latest) db.insert(s.explanationImpact113).values({ ...scope, decisionId: row.id, latestRevisionId: latest, pendingSinceRevisionId: 1, reviewedRevisionId: reviewed, classification }).run()
    if (pending) db.insert(s.evidenceScopeVersion113).values({ scopeKey: JSON.stringify([scope.enterpriseId, scope.titleCode, scope.direction]), latestRevisionId: latest, pendingCount: pending }).run()
  }
  const full = readQueryAssessments(db, [scope])[0]!
  const actual = summary().assessment
  expect(actual).toEqual({ queryCoverage: { status: failed ? 'failed' : 'not_queried' }, assessment: expectedAssessment, explanationValidity: { status: expectedValidity } })
  expect(actual).toEqual({ queryCoverage: { status: full.queryCoverage.status }, assessment: full.assessment, explanationValidity: { status: full.explanationValidity.status } })
})


it('selects time then ID heads before loading bodies and preserves withdrawal positions', () => {
  const { db, scope } = fixture()
  const opposite = { ...scope, direction: 'extra_in_miit' as const }
  // Higher IDs are deliberately older. A max(ID) reader selects private history.
  db.insert(s.differenceReason).values({ ...scope, id: 100, status: 'needs_review', recordedAt: '2026-11-01', reasonNote: 'active original', lifecycleAction: 'replace' }).run()
  db.insert(s.differenceReason).values({ ...opposite, id: 101, status: 'needs_review', recordedAt: '2026-11-01', lifecycleAction: 'replace' }).run()
  db.insert(s.differenceReason).values({ ...opposite, id: 102, status: 'not_queried', recordedAt: '2026-11-02', lifecycleAction: 'withdraw' }).run()
  for (let id = 200; id < 400; id++) db.insert(s.differenceReason).values({ ...scope, id, status: 'not_queried', recordedAt: new Date(Date.UTC(2026, 9, 1, 0, 0, 0, id - 200)).toISOString(), reasonNote: 'private-history-'.repeat(1000) }).run()
  const absent = { ...scope, titleCode: 'little_giant' }
  const scopes = [opposite, absent, scope, opposite]
  // Observe native result bytes, not just the final projection: hydrating all
  // history and discarding it in JS must fail this independent assertion.
  const prepare = db.$client.prepare.bind(db.$client)
  const returned: string[] = []
  const capture = vi.spyOn(db.$client, 'prepare').mockImplementation(((...args: Parameters<typeof prepare>) => {
    const stmt = prepare(...args)
    for (const method of ['get', 'all'] as const) {
      const run = stmt[method].bind(stmt)
      Object.defineProperty(stmt, method, { value: (...params: unknown[]) => {
        const result = run(...params)
        returned.push(JSON.stringify(result) ?? '')
        return result
      } })
    }
    return stmt
  }) as typeof db.$client.prepare)
  const actual = currentDecisions102(db, scopes)
  capture.mockRestore()
  expect(returned.join('')).not.toContain('private-history-')
  expect(actual.map(row => [row.versionId, row.current?.id ?? null])).toEqual([[102, null], [null, null], [100, 100], [102, null]])
  expect(actual[2]!.current).toMatchObject({ reasonNote: 'active original', origin: 'lifecycle', isCurrent: true })
  expect(actual).toEqual(scopes.map(item => currentDecision102(db, item)))
  expect(JSON.stringify(actual)).toBe(JSON.stringify(scopes.map(item => currentDecision102(db, item))))
  expect(currentDecisionStates102(db, scopes)).toEqual(scopes.map(item => currentDecisionState102(db, item)))
  expect(JSON.stringify(currentDecisionStates102(db, scopes))).toBe(JSON.stringify(scopes.map(item => currentDecisionState102(db, item))))
  expect(currentDecisionStates102(db, scopes).map(row => [row.versionId, row.current?.id ?? null])).toEqual([[102, null], [null, null], [100, 100], [102, null]])
  expect(currentDecisions102(db, [])).toEqual([])
  expect(() => currentDecisions102(db, [{ ...scope, enterpriseId: 999999 }])).toThrow('Enterprise not found')
  const assessments = readQueryAssessments(db, scopes)
  expect(assessments.map(row => row.assessment)).toEqual(['withdrawn', 'not_queried', 'decided', 'withdrawn'])
  expect(assessments).toEqual(scopes.map(item => readQueryAssessment(db, item)))
  expect(readQueryAssessmentSummaries(db, scopes).map(row => row.assessment)).toEqual(['withdrawn', 'not_queried', 'decided', 'withdrawn'])
})

it('unions token keys without leaking other scopes or losing lower revision pending work', () => {
  const { db, scope } = fixture()
  const opposite = { ...scope, direction: 'extra_in_miit' as const }
  const active = db.insert(s.differenceReason).values({ ...scope, status: 'needs_review', recordedAt: '2026-11-01' }).returning().get()
  const withdrawn = db.insert(s.differenceReason).values({ ...opposite, status: 'not_queried', recordedAt: '2026-11-01', lifecycleAction: 'withdraw' }).returning().get()
  const state = db.insert(s.explanationImpact113).values({ ...scope, decisionId: active.id, latestRevisionId: 20, pendingSinceRevisionId: 19, reviewedRevisionId: 20, classification: 'premise_invalid' }).returning().get()
  // Literal eight wildcard combinations, independent of the production key builder.
  const versions = [
    [scope.enterpriseId, 'specialized_sme', 'missing_in_miit', 80, 0],
    [scope.enterpriseId, 'specialized_sme', null, 70, 0],
    [scope.enterpriseId, null, 'missing_in_miit', 60, 0],
    [scope.enterpriseId, null, null, 50, 0],
    [null, 'specialized_sme', 'missing_in_miit', 40, 0],
    [null, 'specialized_sme', null, 30, 0],
    [null, null, 'missing_in_miit', 20, 0],
    [null, null, null, 10, 1],
    [999999, 'specialized_sme', 'missing_in_miit', 999, 1],
    [scope.enterpriseId, 'little_giant', 'extra_in_miit', 998, 1],
  ] as const
  for (const [e, t, d, revision, pending] of versions) db.insert(s.evidenceScopeVersion113).values({ scopeKey: JSON.stringify([e, t, d]), latestRevisionId: revision, pendingCount: pending }).run()
  const inputs = [
    { scope, decisionId: active.id, latestDecisionId: active.id },
    { scope: opposite, decisionId: null, latestDecisionId: withdrawn.id },
    { scope, decisionId: active.id, latestDecisionId: active.id },
  ]
  const actual = readEvidenceImpacts113(db, inputs)
  expect(actual[0]).toEqual({ state, token: { ...scope, decisionId: active.id, latestRevisionId: 80, projectionReady: false }, hasReviewedBaseline: true })
  expect(actual[1]).toEqual({ state: null, token: { ...opposite, decisionId: withdrawn.id, latestRevisionId: 70, projectionReady: false }, hasReviewedBaseline: false })
  expect(actual[2]).toEqual(actual[0])
  expect(actual).toEqual(inputs.map(input => readEvidenceImpact113(db, input.scope, input.decisionId)))
  expect(readEvidenceImpacts113(db, [])).toEqual([])
  const result = readQueryAssessments(db, [scope, opposite])
  expect(result.map(row => [row.assessment, row.explanationValidity.status])).toEqual([['decided', 'evidence_changed'], ['withdrawn', 'not_applicable']])
})


it.each([0, 1, 2, 3, 4, 5, 6, 7])('retains revision and pending contribution of wildcard key %i', slot => {
  const { db, scope } = fixture()
  const keys = [
    [scope.enterpriseId, 'specialized_sme', 'missing_in_miit'],
    [scope.enterpriseId, 'specialized_sme', null],
    [scope.enterpriseId, null, 'missing_in_miit'],
    [scope.enterpriseId, null, null],
    [null, 'specialized_sme', 'missing_in_miit'],
    [null, 'specialized_sme', null],
    [null, null, 'missing_in_miit'],
    [null, null, null],
  ]
  db.insert(s.evidenceScopeVersion113).values({ scopeKey: JSON.stringify(keys[slot]), latestRevisionId: 17, pendingCount: 1 }).run()
  expect(readEvidenceImpacts113(db, [{ scope, decisionId: null, latestDecisionId: null }])).toEqual([
    { state: null, token: { ...scope, decisionId: null, latestRevisionId: 17, projectionReady: false }, hasReviewedBaseline: false },
  ])
})
