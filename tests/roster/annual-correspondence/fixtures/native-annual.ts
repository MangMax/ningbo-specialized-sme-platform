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
import { commitPostgresPlatformCollection } from '../../../../layers/sme-roster/server/utils/collection-import-postgres'
import type { AnnualTaskResult } from '../../../../layers/sme-roster/lib/roster/annual-correspondence'
import type { nativeCorrespondenceFixture } from '../../correspondence/fixtures/native-correspondence'

export async function collectAnnualFixtureObservation(
  { db, enterprise }: Awaited<ReturnType<typeof nativeCorrespondenceFixture>>,
  sequence: number,
  status = '终审通过',
) {
  const key = 'BUSINESS-1'
  const receipt = await commitPostgresPlatformCollection(db, {
    idempotencyKey: `annual/capture/${sequence}`, sourceKind: 'platform_archive', sourceIdentity: 'annual-fixture',
    payload: { platformQueries: [{
      interface: 'business_list', queryKey: enterprise.usccNorm!, rdjb: '2', titleCode: 'specialized_sme',
      queriedAt: `2026-10-20T00:0${sequence}:00Z`, status: 'success', rawResponse: 'Synthetic original response',
      relations: [{ sequenceNo: 1, relationKey: key, enterpriseId: enterprise.id, nameRaw: enterprise.name,
        usccRaw: enterprise.usccNorm, verificationStatus: 'confirmed', matchBasis: 'uscc',
        rawFields: { id: key, year: 2024, sblx: '申请', sqsj: '2024-06-01', cszt: status } }],
    }] },
  }, async () => {})
  expect(receipt).toMatchObject({ status: 'committed', items: [{ ok: true, detail: { relations: [expect.any(Number)] } }] })
  return (receipt.items[0]!.detail!.relations as number[])[0]!
}

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
