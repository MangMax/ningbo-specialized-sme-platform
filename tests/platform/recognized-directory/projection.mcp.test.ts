import { closeApplicationLogging } from '../../../layers/core/lib/logging'
import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closePostgresDirectoryDb, usePostgresDirectoryDb } from '../../../db/postgresql/client'
import { postgresRuntimeFixture } from '../../support/postgres-fixture.mjs'
import { seedPostgresPlatformQuery } from '../fixtures/postgres-query'

const dir = mkdtempSync(join(tmpdir(), 'recognized-projection-mcp-'))
let postgres: Awaited<ReturnType<typeof postgresRuntimeFixture>> | undefined
vi.mock('@nuxtjs/mcp-toolkit/server', () => ({ defineMcpTool: (definition: unknown) => definition }))

afterEach(async () => {
  await closeApplicationLogging()
  await closePostgresDirectoryDb()
  postgres?.close()
  vi.unstubAllEnvs()
  rmSync(dir, { recursive: true, force: true })
})

it('native recognized MCP publishes literal source values and read-only annotations', async () => {
  postgres = await postgresRuntimeFixture({ dir })
  vi.stubEnv('NUXT_POSTGRES_DIRECTORY_URL', postgres.url)
  const queriedAt = '2026-10-21T00:00:01Z'
  const raw = { id: 'MCP', qymc: '合成企业', rdjb: '2', rddqrq: '2028/12/31', whpcyear: '2024', whpc: '原批次', private: 'PRIVATE-MCP' }
  await seedPostgresPlatformQuery(usePostgresDirectoryDb(), {
    interface: 'recognized_list', queryKey: 'MCP', rdjb: '2', titleCode: 'specialized_sme', queriedAt, status: 'success',
    relations: [{ sequenceNo: 1, relationKey: raw.id, nameRaw: raw.qymc, rawFields: raw }],
    collectionEvidence: {
      source: 'queryBusList', status: 'success', effectiveConditions: { combination: 'and' },
      titleScope: { mode: 'selected', rdjb: ['2'] }, queriedAt, completedAt: queriedAt, rows: [raw],
      pages: [{ source: 'queryBusList', rdjb: '2', page: 1, status: 'success', fetchedCount: 1, declaredTotal: 1, maxPage: 1, error: null }],
      fetchedCount: 1, declaredTotal: 1, completeness: 'complete', fullRange: true, unfinished: [], error: null,
      limits: { maxRequests: 1, maxRows: 50, maxDurationMs: 1000, pageSize: 50 },
    },
  })
  const tool = (await import('../../../layers/sme-roster/server/mcp/tools/list_platform_recognized_directory')).default
  expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false })
  const result = await tool.handler({ rddqrq: '2028/12/31' } as never, {} as never) as { structuredContent: { rows: unknown[] } }
  expect(result.structuredContent.rows[0]).toMatchObject({ matchedVersion: { validityDateRaw: '2028/12/31', maintenanceYear: 2024, maintenanceBatch: '原批次' } })
  expect(JSON.stringify(result)).not.toContain('PRIVATE-MCP')
}, 30_000)
