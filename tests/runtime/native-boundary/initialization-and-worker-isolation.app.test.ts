import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
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
