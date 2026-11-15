import { initializeDb } from '../db/client'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createError } from 'h3'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { sql } from 'drizzle-orm'
import { useDb } from '../db'

vi.mock('@nuxtjs/mcp-toolkit/server', () => ({ defineMcpTool: (tool: unknown) => tool }))

const dirs: string[] = []
const dir = mkdtempSync(join(tmpdir(), 'business457-mcp-')); dirs.push(dir)
const dbPath = join(dir, 'roster.db')
let preflight: typeof import('../server/mcp/tools/preflight_roster_batch').default
let commit: typeof import('../server/mcp/tools/save_roster_batch').default

beforeAll(async () => {
  vi.stubEnv('NUXT_DB_PATH', dbPath)
  vi.stubEnv('NUXT_DB_READONLY', '0')
  vi.stubGlobal('createError', createError)
  vi.stubGlobal('useRuntimeConfig', () => ({ filesDir: join(dir, 'files'), mcpToken: 'synthetic-mcp-token' }))
  preflight = (await import('../server/mcp/tools/preflight_roster_batch')).default
  commit = (await import('../server/mcp/tools/save_roster_batch')).default
})
afterAll(() => {
  try { useDb({ dbPath }).$client.close() } catch { /* already closed */ }
  vi.unstubAllGlobals(); vi.unstubAllEnvs()
  dirs.forEach(path => rmSync(path, { recursive: true, force: true }))
})

const raw = { id: 'SQ-MCP-B', qymc: 'MCP 办理企业', tyshxydm: '91330211255994457P', sblx: '复核', year: '2023', sqsj: '2023-02-01', cszt: '终审通过', whpc: '2023-2', personuuid: '第三批', szsfmc: '浙江省' }
const payload = { platformQueries: [{ interface: 'business_list' as const, queryKey: '91330211255994457P', rdjb: '2', queriedAt: '2026-10-01T00:00:00Z', status: 'success' as const, rawResponse: JSON.stringify({rows:[raw]}), relations: [{ sequenceNo: 1, relationKey: raw.id, rawFields: raw }] }] }
const input = { idempotencyKey: 'mcp-business-projection', sourceKind: 'platform_archive' as const, sourceIdentity: 'tests/business-projection-mcp', payload }

describe('business_list typed projection through public MCP import tools', () => {
  it('plans only, then commits typed fields and returns typed receipt counts', async () => {
    const db = initializeDb({ create: true, dbPath })
    const plan = await preflight.handler(input as never, {} as never) as { preflight: { canonicalProjection: unknown[] } }
    expect(plan.preflight.canonicalProjection[0]).toMatchObject({
      businessProjection: { declareKind: 'review', businessYear: 2023, status: '终审通过', batch: '2023-2', awardBatchLabel: '第三批', province: '浙江省', ruleVersion: 'platform-business-v1' },
    })
    expect(db.get<{ n: number }>(sql`SELECT count(*) n FROM platform_business_projection WHERE observation_id IS NULL`)!.n).toBe(0)

    const saved = await commit.handler(input as never, {} as never) as { summary: { canonicalProjection: Record<string, number> } }
    expect(saved.summary.canonicalProjection).toMatchObject({ businessProjectionsCreated: 1, businessProjectionsReused: 0 })
    expect(db.get(sql`SELECT declare_kind AS declareKind, business_year AS businessYear, status, batch, award_batch_label AS awardBatchLabel, province FROM platform_business_projection WHERE observation_id IS NULL`)).toEqual({
      declareKind: 'review', businessYear: 2023, status: '终审通过', batch: '2023-2', awardBatchLabel: '第三批', province: '浙江省',
    })

    const replay = await commit.handler({ ...input, idempotencyKey: 'mcp-business-projection-replay' } as never, {} as never) as { summary: { canonicalProjection: Record<string, number> } }
    expect(replay.summary.canonicalProjection).toMatchObject({ businessProjectionsCreated: 0, businessProjectionsReused: 1 })
    expect(db.get<{ n: number }>(sql`SELECT count(*) n FROM platform_business_projection WHERE observation_id IS NULL`)!.n).toBe(1)
  })
})
