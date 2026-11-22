import { expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { enterprise, differenceReason, record } from '../fixtures/postgres-tables'
import { useIsolatedPostgresCases, singlePostgresFixtureRow } from '../../support/isolated-postgres-cases'
import { readPostgresWholeComparison } from '../../../layers/sme-roster/lib/comparison-postgres'
import { readPostgresQueryAssessments } from '../../../layers/sme-roster/lib/roster/query-assessment-postgres'

const createDb = useIsolatedPostgresCases()

it('keeps private active and historical decision bodies out of comparison summary states', async () => {
  const db = createDb()
  const [subject] = await db.insert(enterprise).values({
    name: '合成投影企业', nameNorm: '合成投影企业', usccNorm: 'SYNTHETIC-PROJECTION',
  }).returning()
  await db.insert(record).values({ enterpriseId: subject!.id, source: 'jxj', titleCode: 'specialized_sme' })
  const scope = { enterpriseId: subject!.id, titleCode: 'specialized_sme', direction: 'missing_in_miit' } as const
  const marker = 'SYNTHETIC_PRIVATE_DECISION_'
  const note = marker.repeat(40_000)
  const active = singlePostgresFixtureRow(await db.insert(differenceReason).values({
    ...scope, id: 100, status: 'needs_review', lifecycleAction: 'replace', reasonNote: note, basis: note,
    recordedAt: '2026-11-01', createdAt: '2026-11-01',
  }).returning())
  await db.insert(differenceReason).values({
    ...scope, id: 200, status: 'not_queried', reasonNote: note, recordedAt: '2026-10-01', createdAt: '2026-10-01',
  })
  const [full] = await readPostgresQueryAssessments(db, [scope])
  expect(full!.currentDecision.current).toMatchObject({ id: active.id, reasonNote: note, basis: note })
  const dir = mkdtempSync(join(tmpdir(), 'comparison-assessment-projection-'))
  try {
    const result = await readPostgresWholeComparison(db, {
      curatedPath: join(dir, 'curated.json'), reconcilePath: join(dir, 'reconcile.json'), showCurated: true, page: 1, pageSize: 1,
    }, 'summary')
    expect(result.rows).toMatchObject([{ assessment: {
      assessment: 'decided', queryCoverage: { status: 'not_queried' }, explanationValidity: { status: 'unknown' },
    } }])
    expect(JSON.stringify(result)).not.toContain(marker)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
