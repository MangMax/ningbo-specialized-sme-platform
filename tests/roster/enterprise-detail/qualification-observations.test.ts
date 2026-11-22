import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { expect, it, vi } from 'vitest'
import { closePostgresDirectoryDb, usePostgresDirectoryDb } from '../../../db/postgresql/client'
import { enterprise } from '../../../db/postgresql/enterprise-tables'
import { platformBusinessObservation, platformObservationAssignment } from '../../../db/postgresql/platform-tables'
import { readPostgresRosterEnterpriseDetail } from '../../../layers/sme-roster/lib/roster/enterprise-detail-postgres'
import { platformQueryResultShape } from '../../../layers/sme-roster/lib/platform/live-query'
import { seedPostgresPlatformQuery } from '../../platform/fixtures/postgres-query'
import { postgresRuntimeFixture } from '../../support/postgres-fixture.mjs'

it('preserves source title scope and ordered qualification observations after a matching correction', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'roster-qualification-observations-'))
  let postgres: Awaited<ReturnType<typeof postgresRuntimeFixture>> | undefined
  try {
    postgres = await postgresRuntimeFixture({ dir })
    vi.stubEnv('NUXT_POSTGRES_DIRECTORY_URL', postgres.url)
    const db = usePostgresDirectoryDb()
    const uscc = '91330110MA2GMDFH58'
    const [subject] = await db.insert(enterprise).values({ name: '合成企业', nameNorm: '合成企业', usccNorm: uscc }).returning()
    const queriedAt = '2026-05-31T00:00:00Z'
    const rows = [
      { id: 'giant-first', tyshxydm: uscc, cszt: '终审通过', year: '2024', whpc: '2024-1' },
      { id: 'giant-second', tyshxydm: uscc, cszt: '待审核', year: '2025' },
      { id: 'specialized', tyshxydm: uscc, cszt: '已退回', year: '2025', whpc: '2025-2' },
    ]
    const collection = await seedPostgresPlatformQuery(db, {
      interface: 'business_list', queryKey: uscc, rdjb: '1,2,3', queriedAt, status: 'success',
      collectionEvidence: {
        source: 'businessList', status: 'success', effectiveConditions: { uscc, combination: 'and' },
        titleScope: { mode: 'selected', rdjb: ['1', '2', '3'] }, queriedAt, completedAt: queriedAt,
        dataRows: platformQueryResultShape.dataRows.parse(rows),
        rows: rows.map(row => Object.fromEntries(Object.entries(row).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))),
        pages: [
          { source: 'businessList', rdjb: '3', page: 1, fetchedCount: 2, declaredTotal: 2, error: null, status: 'success' },
          { source: 'businessList', rdjb: '2', page: 1, fetchedCount: 1, declaredTotal: 1, error: null, status: 'success' },
          { source: 'businessList', rdjb: '1', page: 1, fetchedCount: 0, declaredTotal: 0, error: null, status: 'success' },
        ],
        fetchedCount: 3, declaredTotal: 3, completeness: 'complete', fullRange: true, unfinished: [], error: null,
        limits: { pageSize: 50, maxRows: 5000, maxRequests: 100, maxDurationMs: 60_000 },
      },
      relations: rows.map((rawFields, index) => ({
        sequenceNo: index + 1, relationKey: rawFields.id, enterpriseId: index === 1 ? null : subject!.id,
        usccRaw: uscc, rawFields,
      })),
    })
    const [observation] = await db.select({ id: platformBusinessObservation.id }).from(platformBusinessObservation)
      .where(eq(platformBusinessObservation.publicId, collection.relationIds[1]!))
    await db.insert(platformObservationAssignment).values({
      observationId: observation!.id, revision: 2, enterpriseId: null, usccRaw: '91330110MA2GMDFH59',
      matchBasis: 'none', verificationStatus: 'pending', origin: 'command',
      actor: JSON.stringify({ type: 'agent', id: 'fixture' }), basis: '更正匹配线索', recordedAt: '2026-06-01T00:00:00Z',
    })

    const detail = await readPostgresRosterEnterpriseDetail(db, subject!.id, Date.parse('2026-06-02T00:00:00Z'))
    const observationRows = (title: string) => detail?.qualificationAssessment.titles
      .find(item => item.titleCode === title)?.platform.observations.find(item => item.queryId === collection.queryId)?.rows
    expect(observationRows('little_giant')).toEqual([
      { relationId: collection.relationIds[0], status: '终审通过', year: 2024, batch: '2024-1' },
      { relationId: collection.relationIds[1], status: '待审核', year: 2025, batch: null },
    ])
    expect(observationRows('specialized_sme')).toEqual([
      { relationId: collection.relationIds[2], status: '已退回', year: 2025, batch: '2025-2' },
    ])
  } finally {
    await closePostgresDirectoryDb()
    postgres?.close()
    vi.unstubAllEnvs()
    rmSync(dir, { recursive: true, force: true })
  }
}, 30_000)
