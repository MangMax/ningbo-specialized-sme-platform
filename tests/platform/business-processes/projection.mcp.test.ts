import { closeApplicationLogging } from '../../../layers/core/lib/logging'
import { closePostgresDirectoryDb, usePostgresDirectoryDb } from '../../../db/postgresql/client'
import { postgresRuntimeFixture } from '../../support/postgres-fixture.mjs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createError } from 'h3'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { sql } from 'drizzle-orm'

vi.mock('@nuxtjs/mcp-toolkit/server', () => ({ defineMcpTool: (tool: unknown) => tool }))

const dir = mkdtempSync(join(tmpdir(), 'business-projection-mcp-'))
let postgres: Awaited<ReturnType<typeof postgresRuntimeFixture>> | undefined
let preflight: typeof import('../../../layers/sme-roster/server/mcp/tools/preflight_roster_batch').default
let commit: typeof import('../../../layers/sme-roster/server/mcp/tools/save_roster_batch').default

beforeAll(async () => {
  postgres = await postgresRuntimeFixture({ dir })
  for (const [key, value] of Object.entries(postgres.env)) vi.stubEnv(key, value)
  vi.stubEnv('NUXT_DB_READONLY', '0')
  vi.stubGlobal('createError', createError)
  vi.stubGlobal('useRuntimeConfig', () => ({ filesDir: join(dir, 'files'), mcpToken: 'synthetic-mcp-token' }))
  preflight = (await import('../../../layers/sme-roster/server/mcp/tools/preflight_roster_batch')).default
  commit = (await import('../../../layers/sme-roster/server/mcp/tools/save_roster_batch')).default
}, 30_000)
afterAll(async () => {
  await closeApplicationLogging()
  await closePostgresDirectoryDb()
  postgres?.close()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  rmSync(dir, { recursive: true, force: true })
})

const raw = { id: 'SQ-MCP-B', qymc: 'MCP 办理企业', tyshxydm: '91330211255994457P', sblx: '复核', year: '2023', sqsj: '2023-02-01', cszt: '终审通过', whpc: '2023-2', personuuid: '第三批', szsfmc: '浙江省' }
const payload = { platformQueries: [{ interface: 'business_list' as const, queryKey: '91330211255994457P', rdjb: '2', queriedAt: '2026-10-01T00:00:00Z', status: 'success' as const, rawResponse: JSON.stringify({rows:[raw]}), relations: [{ sequenceNo: 1, relationKey: raw.id, rawFields: raw }] }] }
const input = { idempotencyKey: 'mcp-business-projection', sourceKind: 'platform_archive' as const, sourceIdentity: 'tests/business-projection-mcp', payload }

describe('business_list typed projection through public MCP import tools', () => {
  it('plans only, then commits typed fields and returns typed receipt counts', async () => {
    const db = usePostgresDirectoryDb()
    const plan = await preflight.handler(input as never, {} as never) as { preflight: { canonicalProjection: unknown[] } }
    expect(plan.preflight.canonicalProjection[0]).toMatchObject({
      businessProjection: { declareKind: 'review', businessYear: 2023, status: '终审通过', batch: '2023-2', awardBatchLabel: '第三批', province: '浙江省', ruleVersion: 'platform-business-v1' },
    })
    expect(Number((await db.execute<{ n: string }>(sql`SELECT count(*) n FROM business.platform_business_projection WHERE observation_id IS NULL`)).rows[0]!.n)).toBe(0)

    const saved = await commit.handler(input as never, {} as never) as { summary: { canonicalProjection: Record<string, number> } }
    expect(saved.summary.canonicalProjection).toMatchObject({ businessProjectionsCreated: 1, businessProjectionsReused: 0 })
    expect((await db.execute(sql`SELECT declare_kind AS "declareKind", business_year::integer AS "businessYear", status, batch, award_batch_label AS "awardBatchLabel", province FROM business.platform_business_projection WHERE observation_id IS NULL`)).rows[0]).toEqual({
      declareKind: 'review', businessYear: 2023, status: '终审通过', batch: '2023-2', awardBatchLabel: '第三批', province: '浙江省',
    })

    expect(await commit.handler(input as never, {} as never)).toEqual(saved)
    const legacyReplay = await commit.handler({ ...input, idempotencyKey: 'mcp-business-projection-replay' } as never, {} as never)
    expect(legacyReplay).toMatchObject({ status: 'failed', items: [{ error: { code: 'query_replay_offline' } }] })
    const { rawResponse: _original, relations, ...coordinates } = payload.platformQueries[0]!
    const reference = await commit.handler({
      ...input, idempotencyKey: 'mcp-business-projection-reference',
      payload: { platformQueries: [{ ...coordinates, reuseExisting: true,
        relations: relations.map(({ sequenceNo, relationKey }) => ({ sequenceNo, relationKey })) }] },
    } as never, {} as never)
    expect(reference).toMatchObject({ status: 'committed', summary: { written: 0, skipped: 1 },
      items: [{ detail: { reuseExisting: true, rowsWritten: 0 } }] })
    expect(Number((await db.execute<{ n: string }>(sql`SELECT count(*) n FROM business.platform_business_projection WHERE observation_id IS NULL`)).rows[0]!.n)).toBe(1)
  })
})
