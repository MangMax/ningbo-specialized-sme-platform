import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { expect, vi } from 'vitest'
import { getPostgresJob } from '../../../../layers/core/server/utils/job-store-postgres'
import { createPostgresJobRunner, type PostgresJobDb } from '../../../../layers/core/server/utils/job-runner-postgres'
import { registerJob, clearJobSpecs } from '../../../../layers/core/server/utils/job-spec-registry'
import { postgresAnnualCorrespondenceSpec } from '../../../../layers/sme-roster/server/utils/jobs/annual-correspondence-postgres-spec'
import { stagePostgresAnnualCorrespondence } from '../../../../layers/sme-roster/server/utils/jobs/annual-correspondence-postgres'
import type { AnnualTaskResult } from '../../../../layers/sme-roster/lib/roster/annual-correspondence'

export function stageAnnualFixtureTask(db: NodePgDatabase, eventId: number, clientRequestId: string) {
  return db.transaction(tx => stagePostgresAnnualCorrespondence(tx, { clientRequestId, eventIds: [eventId] }))
}

export async function runAnnualFixtureTask(db: PostgresJobDb, id: string) {
  const dir = mkdtempSync(join(tmpdir(), 'annual-task-fixture-'))
  clearJobSpecs()
  registerJob(postgresAnnualCorrespondenceSpec)
  const runner = createPostgresJobRunner(db, dir)
  try {
    runner.start()
    await vi.waitFor(async () => expect(['done', 'failed']).toContain((await getPostgresJob(db, id))?.row.state), { timeout: 5000 })
    return (await getPostgresJob(db, id))!.row
  } finally {
    await runner.stop()
    clearJobSpecs()
    rmSync(dir, { recursive: true, force: true })
  }
}

export function annualFixtureEvent(row: Awaited<ReturnType<typeof runAnnualFixtureTask>>) {
  return (row.result as AnnualTaskResult).events[0]!
}
