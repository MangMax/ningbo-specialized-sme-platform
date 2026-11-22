import { closeApplicationLogging } from '../../../layers/core/lib/logging'
import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closePostgresDirectoryDb } from '../../../db/postgresql/client'
import { postgresRuntimeFixture } from '../../support/postgres-fixture.mjs'
import { nativeCatalogFixture } from '../fixtures/native-catalog'

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
  const fixture = nativeCatalogFixture()
  try {
    const raw = fixture.raw('MCP', { rddqrq: '2028/12/31', whpcyear: '2024', whpc: '原批次', private: 'PRIVATE-MCP' })
    fixture.seed('recognized_list', raw)
    const expected = fixture.list('recognized_list', { rddqrq: '2028/12/31' })
    postgres = await postgresRuntimeFixture({ dir, sourcePath: join(fixture.dir, 'isolated.db') })
    for (const [key, value] of Object.entries(postgres.env)) vi.stubEnv(key, value)
    const tool = (await import('../../../layers/sme-roster/server/mcp/tools/list_platform_recognized_directory')).default
    expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false })
    const result = await tool.handler({ rddqrq: '2028/12/31' } as never, {} as never) as { structuredContent: { rows: unknown[] } }
    expect(result.structuredContent).toEqual(expected)
    expect(result.structuredContent.rows[0]).toMatchObject({ matchedVersion: { validityDateRaw: '2028/12/31', maintenanceYear: 2024, maintenanceBatch: '原批次' } })
    expect(JSON.stringify(result)).not.toContain('PRIVATE-MCP')
  } finally {
    fixture.close()
  }
}, 30_000)
