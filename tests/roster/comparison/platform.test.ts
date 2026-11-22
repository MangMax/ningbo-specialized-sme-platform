import { expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { useIsolatedPostgresCases, singlePostgresFixtureRow } from '../../support/isolated-postgres-cases'
import { seedPostgresPlatformQuery } from '../../platform/fixtures/postgres-query'
import { enterprise, record, differenceReason } from '../fixtures/postgres-tables'
import { readPostgresWholeComparison } from '../../../layers/sme-roster/lib/comparison-postgres'

const openDatabase = useIsolatedPostgresCases()
const at = '2026-10-16T00:00:00Z'

it('keeps all three titles and stored dispositions visible including failed and empty platform queries', async () => {
  const db = openDatabase()
  const fixture = [
    { name: '宁波无统代企业', uscc: null, title: 'innovative_sme' },
    { name: '宁波平台滞后企业', uscc: '91330211000000002Y', title: 'specialized_sme' },
    { name: '宁波尚未解释企业', uscc: '91330211000000003Z', title: 'little_giant' },
    { name: '宁波接口无记录企业', uscc: '91330211000000004A', title: 'specialized_sme' },
  ] as const
  const ids: number[] = []
  for (const item of fixture) {
    const owner = singlePostgresFixtureRow(await db.insert(enterprise).values({ name: item.name, nameNorm: item.name, usccNorm: item.uscc }).returning())
    await db.insert(record).values({ enterpriseId: owner.id, source: 'jxj', titleCode: item.title })
    ids.push(owner.id)
  }
  await db.insert(differenceReason).values([
    { enterpriseId: ids[0]!, titleCode: 'innovative_sme', direction: 'missing_in_miit', status: 'not_queried',
      reasonNote: '本企业无统一社会信用代码', measureCode: 'manual_review', recordedAt: at, createdAt: at },
    { enterpriseId: ids[1]!, titleCode: 'specialized_sme', direction: 'missing_in_miit', status: 'confirmed_reason',
      reasonCode: 'platform_stale', measureCode: 'mark_platform_snapshot', verificationStatus: 'confirmed', recordedAt: at, createdAt: at },
    { enterpriseId: ids[3]!, titleCode: 'specialized_sme', direction: 'missing_in_miit', status: 'no_record',
      measureCode: 'manual_review', recordedAt: at, createdAt: at },
  ])
  const subject = fixture[3].uscc
  await seedPostgresPlatformQuery(db, {
    interface: 'apply_list', queryKey: subject, rdjb: '', queriedAt: at, status: 'no_record', rawResponse: 'synthetic empty response',
  })
  await seedPostgresPlatformQuery(db, {
    interface: 'business_list', queryKey: subject, rdjb: '2', queriedAt: '2026-10-16T00:00:01Z', status: 'failed',
    failureReason: '合成登录超时', rawResponse: 'synthetic failed response',
  })
  const dir = mkdtempSync(join(tmpdir(), 'comparison-platform-display-'))
  try {
    const result = await readPostgresWholeComparison(db, {
      curatedPath: join(dir, 'curation.json'), reconcilePath: join(dir, 'reconcile.json'), page: 1, pageSize: 10, showCurated: true,
    }, 'full')
    expect(result.total).toBe(4)
    expect(new Set(result.rows.map(row => row.titleCode))).toEqual(new Set(['innovative_sme', 'specialized_sme', 'little_giant']))
    const byId = new Map(result.rows.map(row => [row.enterpriseId, row]))
    expect(byId.get(ids[0]!)?.platform.disposition).toMatchObject({ status: 'not_queried', reasonCode: null, measureCode: 'manual_review' })
    expect(byId.get(ids[1]!)?.platform.disposition).toMatchObject({ status: 'confirmed_reason', reasonCode: 'platform_stale', measureCode: 'mark_platform_snapshot' })
    expect(byId.get(ids[2]!)?.platform.disposition).toMatchObject({ status: 'not_queried', explanationId: null })
    expect(byId.get(ids[3]!)?.platform).toMatchObject({
      relationCount: 0,
      queries: [
        { interface: 'apply_list', status: 'no_record', relations: [] },
        { interface: 'business_list', status: 'failed', failureReason: '合成登录超时', relations: [] },
      ],
    })
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
