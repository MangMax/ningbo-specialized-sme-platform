import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { runPostgresPlatformReconcile } from '../../../layers/sme-roster/server/utils/platform-reconcile-postgres'
import { EMPTY_APPLY_RESPONSE, platformFixture, platformReplay } from '../../platform/fixtures/source-replay'
import { createEnterpriseReadExecutor } from '../../../layers/sme-roster/server/utils/enterprise-read'
import { postgresRuntimeFixture } from '../../support/postgres-fixture.mjs'

it('reads changed facts from PostgreSQL through the qualification worker', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pg-native-worker-'))
  let runtime: Awaited<ReturnType<typeof postgresRuntimeFixture>> | undefined
  let reads: ReturnType<typeof createEnterpriseReadExecutor> | undefined
  try {
    runtime = await postgresRuntimeFixture({ dir })
    runtime.psql(['-c', `
      INSERT INTO business.enterprise (id, name, name_norm) VALUES (1, 'Native current', 'Native current');
      INSERT INTO business.roster_legacy_member (enterprise_id) VALUES (1);
      INSERT INTO business.record (id, enterprise_id, title_code, source, name_raw)
        VALUES (1, 1, 'little_giant', 'jxj', 'Native current');
      INSERT INTO business.record_event (record_id, event_type, year, batch_seq) VALUES (1, 'award', 2025, 1);
    `])
    for (const [key, value] of Object.entries(runtime.env)) vi.stubEnv(key, value)
    reads = createEnterpriseReadExecutor()
    const filter = { titleCode: 'little_giant' as const, pageSize: 5 }
    const read = async () => JSON.parse((await reads!.currentQualifiedJson(filter)).body.toString())
    const current = await read()
    expect(current).toMatchObject({ total: 1, rows: [{ enterpriseId: 1 }] })
    const initial = current.rows[0].qualificationAssessment.titles.find((title: { titleCode: string }) => title.titleCode === 'little_giant')
    expect(initial).toMatchObject({
      effectiveQualification: { status: 'effective' }, evidence: [{ eventType: 'award', year: 2025, batchSeq: 1 }],
    })
    runtime.psql(['-c', 'UPDATE business.record_event SET year = 1999'])
    const fresh = await read()
    expect(fresh).toMatchObject({ total: 1, rows: [{ enterpriseId: 1 }] })
    const updated = fresh.rows[0].qualificationAssessment.titles.find((title: { titleCode: string }) => title.titleCode === 'little_giant')
    expect(updated).toMatchObject({
      effectiveQualification: { status: 'effective' }, evidence: [{ eventType: 'award', year: 1999, batchSeq: 1 }],
    })
    expect(updated.versions.facts).toMatch(/^[a-f0-9]{64}$/)
    expect(updated.versions.facts).not.toBe(initial.versions.facts)
  } finally {
    try { await reads?.close() } finally {
      try { runtime?.close() } finally {
        vi.unstubAllEnvs()
        rmSync(dir, { recursive: true, force: true })
      }
    }
  }
}, 30_000)

it('captures four reconcile slots and commits their distinct PostgreSQL collections', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pg-native-reconcile-'))
  let runtime: Awaited<ReturnType<typeof postgresRuntimeFixture>> | undefined
  let pool: pg.Pool | undefined
  try {
    runtime = await postgresRuntimeFixture({ dir })
    const fixture = runtime
    pool = new pg.Pool({ connectionString: fixture.url, options: '-c search_path=business,public' })
    const db = drizzle(pool)
    const uscc = '91330200712345678C'
    await pool.query(`
      INSERT INTO business.enterprise (id, name, name_norm, uscc_norm)
        VALUES (1, 'Native reconcile', 'Native reconcile', '91330200712345678C');
      INSERT INTO business.roster_legacy_member (enterprise_id) VALUES (1);
      INSERT INTO business.record (enterprise_id, title_code, source, name_raw, uscc_raw)
        VALUES (1, 'specialized_sme', 'jxj', 'Native reconcile', '91330200712345678C');
    `)
    const replay = platformReplay(({ interface: source }) => ({
      text: source === 'apply_list' ? EMPTY_APPLY_RESPONSE : platformFixture('business-list-rdjb1-empty.html'),
    }))
    const options = {
      titles: ['specialized_sme'], usccs: [uscc], now: () => new Date('2026-11-14T04:00:00Z'),
      cookie: 'synthetic-native=1', fetchImpl: replay.fetchImpl, retries: 0,
    }
    expect(await runPostgresPlatformReconcile(db, options)).toMatchObject({
      targetCount: 1, queries: { network: 4 },
      collection: { complete: 4, partial: 0, failed: 0, unknown: 0 }, write: { status: 'committed' },
    })
    const calls = replay.calls.map(call => [call.interface, call.rdjb, call.uscc])
    expect(calls).toHaveLength(4)
    expect(calls).toEqual(expect.arrayContaining([
      ['apply_list', '', uscc], ['business_list', '1', uscc], ['business_list', '2', uscc], ['business_list', '3', uscc],
    ]))
    const persisted = fixture.psql(['-At', '-c', `SELECT interface, rdjb FROM business.platform_collection
      ORDER BY interface, rdjb`]).trim().split('\n')
    expect(persisted).toEqual(['apply_list|', 'business_list|1', 'business_list|2', 'business_list|3'])
  } finally {
    try { await pool?.end() } finally {
      try { runtime?.close() } finally { rmSync(dir, { recursive: true, force: true }) }
    }
  }
}, 30_000)
