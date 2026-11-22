import { expect, it } from 'vitest'
import { enterprise } from '../../../db/postgresql/enterprise-tables'
import { record, recordEvent } from '../../../db/postgresql/ledger-tables'
import { platformExportBatch, platformExportRow } from '../../../db/postgresql/platform-tables'
import { rosterLegacyMember } from '../../../db/postgresql/roster-selection-tables'
import { listPostgresRosterEnterprises } from '../../../layers/sme-roster/lib/roster/enterprise-list-postgres'
import { singlePostgresFixtureRow as single, useIsolatedPostgresCases } from '../../support/isolated-postgres-cases'

const createDb = useIsolatedPostgresCases()

it('uses actual cross-title USCC presence to distinguish current membership from old-only membership', async () => {
  const db = createDb()
  const createdAt = '2026-01-01T00:00:00Z'
  const cross = { name: '宁波跨称号快照企业', code: '91330211BBBBBBB001X' }
  const old = { name: '宁波仅旧快照企业', code: '91330211BBBBBBB002X' }

  for (const { name, code } of [cross, old]) {
    const owner = single(await db.insert(enterprise).values({ name, nameNorm: name, usccNorm: code }).returning())
    await db.insert(rosterLegacyMember).values({ enterpriseId: owner.id })
    const row = single(await db.insert(record).values({ enterpriseId: owner.id, titleCode: 'innovative_sme', source: 'miit' }).returning())
    await db.insert(recordEvent).values({ recordId: row.id, eventType: 'maintain', year: 2025, batchSeq: 1, sortKey: 2025 })
  }

  // Neither enterprise has a record with the export's title.
  for (const [year, owner] of [[2025, old], [2026, cross]] as const) {
    const batch = single(await db.insert(platformExportBatch).values({
      titleCode: 'specialized_sme', year, sha256: String(year % 10).repeat(64),
      collectedOn: `${year}-06-30`, originalFilename: `specialized-${year}.xlsx`,
      rowCount: 1, importStatus: 'imported', createdAt,
    }).returning())
    await db.insert(platformExportRow).values({ batchId: batch.id, sourceRowNo: 1, usccRaw: owner.code, nameRaw: owner.name, createdAt })
  }

  const all = await listPostgresRosterEnterprises(db, { pageSize: 200 })
  expect(Object.fromEntries(all.rows.map(row => [row.name, row.rosterState]))).toEqual({
    [cross.name]: 'current', [old.name]: 'removed_platform_only',
  })
  for (const [rosterState, name] of [['current', cross.name], ['removed_platform_only', old.name]] as const) {
    const result = await listPostgresRosterEnterprises(db, { rosterState, pageSize: 200 })
    expect(result.rows.map(row => row.name)).toEqual([name])
  }
})
