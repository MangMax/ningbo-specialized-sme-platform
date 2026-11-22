import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pg from 'pg'
import { expect, it, vi } from 'vitest'
import { closePostgresDirectoryDb, usePostgresDirectoryDb } from '../../../db/postgresql/client'
import { closeApplicationLogging } from '../../../layers/core/lib/logging'
import { registerJob } from '../../../layers/core/server/utils/job-spec-registry'
import { getPostgresJob } from '../../../layers/core/server/utils/job-store-postgres'
import { startPostgresJobs, stopPostgresJobs } from '../../../layers/core/server/utils/postgres-jobs'
import { runPostgresMixedImport } from '../../../layers/sme-roster/server/utils/roster-mixed-import-postgres'
import type { RosterImportRequest } from '../../../layers/sme-roster/lib/roster-import-client'
import { postgresRuntimeFixture } from '../../support/postgres-fixture.mjs'

it('persists job completion while another connection waits to import and retains both results', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'job-import-contention-'))
  let postgres: Awaited<ReturnType<typeof postgresRuntimeFixture>> | undefined
  let pool: pg.Pool | undefined
  let blocker: pg.PoolClient | undefined
  let imported: ReturnType<typeof runPostgresMixedImport> | undefined
  const request: RosterImportRequest = {
    idempotencyKey: 'job-import-contention', sourceKind: 'platform_export', sourceIdentity: 'synthetic/contention.xlsx',
    payload: { exportSnapshot: { titleCode: 'specialized_sme', year: 2026, collectedOn: '2026-10-20', originalFilename: 'contention.xlsx',
      sha256: 'contention-v1', rows: [{ sourceRowNo: 3, rawFields: { original: 'retained' } }] } },
  }
  try {
    postgres = await postgresRuntimeFixture({ dir })
    for (const [key, value] of Object.entries(postgres.env)) vi.stubEnv(key, value)
    vi.stubEnv('NUXT_DB_READONLY', '0')
    pool = new pg.Pool({ connectionString: postgres.url })
    const db = usePostgresDirectoryDb()
    expect(await runPostgresMixedImport('preflight', request, dir)).toMatchObject({ status: 'preflight' })
    blocker = await pool.connect()
    await blocker.query('BEGIN')
    await blocker.query('LOCK TABLE business.platform_export_batch IN ACCESS EXCLUSIVE MODE')
    imported = runPostgresMixedImport('commit', request, dir)
    void imported.catch(() => {})
    // Prove the import is waiting on the held lock before submitting the competing job.
    await expect.poll(async () => (await pool!.query(`
      SELECT count(*)::int AS waiting FROM pg_locks
      WHERE relation = 'business.platform_export_batch'::regclass AND NOT granted
    `)).rows[0].waiting).toBeGreaterThan(0)
    registerJob({
      kind: 'synthetic-import-contention', status: 'ready', summary: 'Import contention',
      parse: params => ({ ok: true, params }), postgres: { async run() { return { result: { retained: true } } } },
    })
    const id = (await startPostgresJobs(dir)!.runner.submit({ kind: 'synthetic-import-contention', params: {} })).id
    await expect.poll(async () => (await getPostgresJob(db, id))?.row.state).toBe('done')
    expect((await getPostgresJob(db, id))?.row).toMatchObject({
      state: 'done', result: { retained: true },
    })
    await blocker.query('ROLLBACK')
    blocker.release()
    blocker = undefined
    expect(await imported).toMatchObject({ status: 'committed', summary: { written: 2 } })
  } finally {
    if (blocker) {
      await blocker.query('ROLLBACK')
      blocker.release()
    }
    await imported?.catch(() => {})
    await stopPostgresJobs()
    await closeApplicationLogging()
    await closePostgresDirectoryDb()
    await pool?.end()
    vi.unstubAllEnvs()
    postgres?.close()
    rmSync(dir, { recursive: true, force: true })
  }
}, 60_000)
