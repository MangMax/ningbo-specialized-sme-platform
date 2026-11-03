import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createError } from 'h3'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { sql } from 'drizzle-orm'
import { schema, useDb } from '../db'

vi.mock('@nuxtjs/mcp-toolkit/server', () => ({ defineMcpTool: (tool: unknown) => tool }))

const dirs: string[] = []
const dir = mkdtempSync(join(tmpdir(), 'recognized461-mcp-')); dirs.push(dir)
const dbPath = join(dir, 'roster.db')
let preflight: typeof import('../server/mcp/tools/preflight_roster_batch').default
let commit: typeof import('../server/mcp/tools/save_roster_batch').default
let relationId = 0

beforeAll(async () => {
  vi.stubEnv('NUXT_DB_PATH', dbPath)
  vi.stubEnv('NUXT_DB_READONLY', '0')
  vi.stubGlobal('createError', createError)
  vi.stubGlobal('useRuntimeConfig', () => ({ filesDir: join(dir, 'files'), mcpToken: 'synthetic-mcp-token' }))
  preflight = (await import('../server/mcp/tools/preflight_roster_batch')).default
  commit = (await import('../server/mcp/tools/save_roster_batch')).default
  const db = useDb({ dbPath })
  const query = db.insert(schema.platformQuery).values({
    interface: 'recognized_list', queryKey: '91330200RECOGNIZEDMCP', rdjb: '3', titleCode: 'little_giant', queriedAt: '2026-09-01T00:00:00Z', status: 'success',
  }).returning().get()
  relationId = db.insert(schema.platformRelation).values({
    queryId: query.id, sequenceNo: 1, relationKey: 'UUID-MCP',
    rawFields: { id: 'UUID-MCP', qymc: 'MCP 认定企业', tyshxydm: '91330211255994457P', rddqrq: '2027-12-31', whpcyear: '2023', whpc: '4', szq: '33028100', rdxx: 'MCP 认定说明', rdjb: '1' },
  }).returning().get().id
})
afterAll(() => {
  try { useDb({ dbPath }).$client.close() } catch { /* already closed */ }
  vi.unstubAllGlobals(); vi.unstubAllEnvs()
  dirs.forEach(path => rmSync(path, { recursive: true, force: true }))
})

const input = () => ({ idempotencyKey: 'mcp-recognized-projection', sourceKind: 'platform_archive' as const, sourceIdentity: 'tests/recognized-projection-mcp', payload: { platformRecordObservations: [{ relationId }] } })

describe('recognized_list typed projection through public MCP import tools', () => {
  it('plans only, then commits typed fields and returns typed receipt counts', async () => {
    const db = useDb({ dbPath })
    const plan = await preflight.handler(input() as never, {} as never) as { preflight: { canonicalProjection: unknown[] } }
    expect(plan.preflight.canonicalProjection[0]).toMatchObject({
      relationId,
      recognizedProjection: {
        validityDateRaw: '2027-12-31', maintenanceYear: 2023, maintenanceBatch: '4', district: '33028100',
        awardNote: 'MCP 认定说明', titleRaw: '1', nameRaw: 'MCP 认定企业', usccRaw: '91330211255994457P', ruleVersion: 'platform-recognized-v1',
      },
    })
    expect(db.get<{ n: number }>(sql`SELECT count(*) n FROM platform_recognized_projection`)!.n).toBe(0)

    const saved = await commit.handler(input() as never, {} as never) as { summary: { canonicalProjection: Record<string, number> } }
    expect(saved.summary.canonicalProjection).toMatchObject({ recognizedProjectionsCreated: 1, recognizedProjectionsReused: 0 })
    expect(db.get(sql`SELECT validity_date_raw AS validityDateRaw, maintenance_year AS maintenanceYear, maintenance_batch AS maintenanceBatch, district, award_note AS awardNote, title_raw AS titleRaw FROM platform_recognized_projection`)).toEqual({
      validityDateRaw: '2027-12-31', maintenanceYear: 2023, maintenanceBatch: '4', district: '33028100', awardNote: 'MCP 认定说明', titleRaw: '1',
    })
    // Query title scope remains a separate query fact.
    expect(db.get(sql`SELECT rdjb FROM platform_query`)).toEqual({ rdjb: '3' })

    const replay = await commit.handler({ ...input(), idempotencyKey: 'mcp-recognized-projection-replay' } as never, {} as never) as { summary: { canonicalProjection: Record<string, number> } }
    expect(replay.summary.canonicalProjection).toMatchObject({ recognizedProjectionsCreated: 0, recognizedProjectionsReused: 1 })
    expect(db.get<{ n: number }>(sql`SELECT count(*) n FROM platform_recognized_projection`)!.n).toBe(1)
  })
})
