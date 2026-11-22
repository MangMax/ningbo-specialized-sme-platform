import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { drizzle } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import { job } from '../../../db/postgresql/job-tables'
import { pruneRosterTaskHistory } from '../../../layers/sme-roster/server/utils/jobs/roster-task-history-cleanup'
import { postgresRuntimeFixture } from '../../support/postgres-fixture.mjs'

it.skipIf(!process.env.ROSTER_TEST_POSTGRES_BIN)('prunes old roster background work and keeps active, recent and export jobs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'roster-task-retention-'))
  let runtime: Awaited<ReturnType<typeof postgresRuntimeFixture>> | undefined
  let pool: pg.Pool | undefined
  try {
    runtime = await postgresRuntimeFixture({ dir })
    pool = new pg.Pool({ connectionString: runtime.url })
    const db = drizzle({ client: pool })
    const candidate = 'event-archive-candidates'
    const annual = 'event-annual-correspondence'
    const unit = { params: '{}', createdAt: '2026-11-01T00:00:00.000Z' }
    const old = { ...unit, finishedAt: '2026-11-08T00:00:00.000Z' }
    await db.insert(job).values([
      { ...old, id: 'old-candidate', kind: candidate, state: 'done' },
      { ...old, id: 'old-annual', kind: annual, state: 'cancelled' },
      { ...old, id: 'old-export', kind: 'current-roster-export', state: 'done' },
      { ...unit, id: 'active-annual', kind: annual, state: 'running' },
      { ...unit, id: 'boundary-candidate', kind: candidate, state: 'done', finishedAt: '2026-11-15T00:00:00.000Z' },
    ])
    const now = Date.parse('2026-11-22T00:00:00.000Z')
    expect(await pruneRosterTaskHistory({ db, cancelled: async () => true }, now))
      .toMatchObject({ cancelled: true, result: { removed: 0 } })
    expect(await pruneRosterTaskHistory({ db, cancelled: async () => false }, now))
      .toEqual({ result: { removed: 2 } })
    expect(await db.select({ id: job.id }).from(job).orderBy(job.id)).toEqual([
      { id: 'active-annual' }, { id: 'boundary-candidate' }, { id: 'old-export' },
    ])
  } finally {
    try { await pool?.end() } finally {
      try { runtime?.close() } finally { rmSync(dir, { recursive: true, force: true }) }
    }
  }
}, 15_000)
