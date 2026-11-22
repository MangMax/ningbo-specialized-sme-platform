import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { closePostgresDirectoryDb, usePostgresDirectoryDb } from '../../../db/postgresql/client'
import { platformFilterOptionsQueryFromQuery } from '../../../layers/sme-roster/lib/platform/filter-options'
it('filter option query validation rejects unsupported source and repeated view',()=>{
 expect(()=>platformFilterOptionsQueryFromQuery({source:'unknown'})).toThrow()
 expect(()=>platformFilterOptionsQueryFromQuery({source:'declarations',view:['records','isolated']})).toThrow()
})

import { readPlatformArchiveOptions } from '../../../layers/sme-roster/server/utils/platform-archive-read'
import { postgresRuntimeFixture } from '../../support/postgres-fixture.mjs'
import { seedPostgresPlatformQuery } from '../fixtures/postgres-query'

it('exposes source-specific filter options without inventing facts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'platform-filter-options-'))
  let postgres: Awaited<ReturnType<typeof postgresRuntimeFixture>> | undefined
  try {
    postgres = await postgresRuntimeFixture({ dir })
    vi.stubEnv('NUXT_POSTGRES_DIRECTORY_URL', postgres.url)
    const db = usePostgresDirectoryDb()
    const queriedAt = '2026-10-21T00:00:01Z'
    const apply = { id: 'APPLY', sblx: '申请', year: 2024, cszt: '原状态' }
    const business = { id: 'PROCESS', sblx: '复核', year: 2025, whpc: '原批次' }
    const recognized = { id: 'DIRECTORY', rddqrq: '非日期', whpcyear: '2026', whpc: '目录批次', szq: '3302' }
    await seedPostgresPlatformQuery(db, {
      interface: 'apply_list', queryKey: apply.id, queriedAt, status: 'success', rawResponse: '{}',
      relations: [{ sequenceNo: 1, relationKey: apply.id, rawFields: apply }],
    })
    await seedPostgresPlatformQuery(db, {
      interface: 'business_list', queryKey: business.id, queriedAt, status: 'success', rawResponse: '{}',
      relations: [{ sequenceNo: 1, relationKey: business.id, rawFields: business }],
    })
    await seedPostgresPlatformQuery(db, {
      interface: 'recognized_list', queryKey: recognized.id, queriedAt, status: 'success', rdjb: '2', titleCode: 'specialized_sme',
      relations: [{ sequenceNo: 1, relationKey: recognized.id, rawFields: recognized }],
      collectionEvidence: {
        source: 'queryBusList', status: 'success', effectiveConditions: { combination: 'and' },
        titleScope: { mode: 'selected', rdjb: ['2'] }, queriedAt, completedAt: queriedAt, rows: [recognized],
        pages: [{ source: 'queryBusList', rdjb: '2', page: 1, status: 'success', fetchedCount: 1, declaredTotal: 1, maxPage: 1, error: null }],
        fetchedCount: 1, declaredTotal: 1, completeness: 'complete', fullRange: true, unfinished: [], error: null,
        limits: { maxRequests: 1, maxRows: 50, maxDurationMs: 1000, pageSize: 50 },
      },
    })
    expect(await readPlatformArchiveOptions({ source: 'declarations', view: 'records' }))
      .toMatchObject({ declareKinds: ['apply'], years: [2024], statuses: ['原状态'] })
    expect(await readPlatformArchiveOptions({ source: 'business-processes', view: 'records' }))
      .toMatchObject({ declareKinds: ['review'], years: [2025], batches: ['原批次'] })
    expect(await readPlatformArchiveOptions({ source: 'recognized-directory', view: 'records' }))
      .toMatchObject({ validityDates: ['非日期'], batches: ['目录批次'], districts: ['3302'] })
  } finally {
    await closePostgresDirectoryDb()
    postgres?.close()
    vi.unstubAllEnvs()
    rmSync(dir, { recursive: true, force: true })
  }
}, 30_000)
