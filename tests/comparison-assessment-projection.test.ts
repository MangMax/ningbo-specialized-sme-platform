import { submitNativePlatformQuery } from './helpers/native-platform-fixture'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { initializeDb, schema as s } from '../db/client'
import { readWholeComparisonSummary } from '../lib/comparison-summary-read'
import { readQueryAssessments } from '../lib/roster/query-assessment'

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
