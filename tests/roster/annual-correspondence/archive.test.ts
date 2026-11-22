import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { nativeCorrespondenceFixture } from '../correspondence/fixtures/native-correspondence'
import { readFixtureAudit } from '../correspondence/fixtures/postgres-audit'
import { useIsolatedPostgresCases } from '../../support/isolated-postgres-cases'
import { listPostgresCorrespondences } from '../../../layers/sme-roster/server/utils/record-correspondence-postgres'
import { stagePostgresAnnualCorrespondence, retryPostgresAnnualCorrespondence } from '../../../layers/sme-roster/server/utils/jobs/annual-correspondence-postgres'
import { postgresAnnualCorrespondenceSpec } from '../../../layers/sme-roster/server/utils/jobs/annual-correspondence-postgres-spec'
import { cancelPostgresJob, getPostgresJob } from '../../../layers/core/server/utils/job-store-postgres'
import { clearJobSpecs, registerJob } from '../../../layers/core/server/utils/job-spec-registry'
import { stopPostgresJobs } from '../../../layers/core/server/utils/postgres-jobs'
import { job } from '../../../db/postgresql/job-tables'
import { runAnnualFixtureTask, stageAnnualFixtureTask } from './fixtures/native-annual'

const createDb = useIsolatedPostgresCases()

it('stages annual work atomically and runs the durable task once', async () => {
  const f = await nativeCorrespondenceFixture(createDb())
  const source = await f.add()
  const receipt = await stageAnnualFixtureTask(f.db, f.event.id, 'archive')
  expect((await getPostgresJob(f.db, receipt.jobId))?.row.state).toBe('queued')
  expect(await listPostgresCorrespondences(f.db, {})).toEqual([])
  expect(await runAnnualFixtureTask(f.db, receipt.jobId)).toMatchObject({
    state: 'done', result: { events: [{ status: 'done', finalQualification: { status: 'confirmed' } }] },
  })
  const correspondences = await listPostgresCorrespondences(f.db, {})
  expect(correspondences).toMatchObject([{ relationId: source.id, status: 'confirmed' }])
  const id = correspondences[0]!.id
  const audit = await readFixtureAudit(f.db, id)
  expect((await stageAnnualFixtureTask(f.db, f.event.id, 'same-scope')).jobId).toBe(receipt.jobId)
  expect(await readFixtureAudit(f.db, id)).toEqual(audit)
})

it('rolls task admission back with its enclosing archive transaction', async () => {
  const f = await nativeCorrespondenceFixture(createDb())
  await f.add()
  await expect(f.db.transaction(async tx => {
    await stagePostgresAnnualCorrespondence(tx, { clientRequestId: 'rollback', eventIds: [f.event.id] })
    throw new Error('rollback')
  })).rejects.toThrow('rollback')
  expect(await f.db.select().from(job)).toEqual([])
  expect(await listPostgresCorrespondences(f.db, {})).toEqual([])
})

it('resumes cancelled work on the same durable task', async () => {
  const f = await nativeCorrespondenceFixture(createDb())
  await f.add()
  const receipt = await stageAnnualFixtureTask(f.db, f.event.id, 'cancel')
  expect(await cancelPostgresJob(f.db, receipt.jobId)).toMatchObject({ state: 'cancelled' })
  const dir = mkdtempSync(join(tmpdir(), 'annual-retry-'))
  clearJobSpecs()
  registerJob(postgresAnnualCorrespondenceSpec)
  try {
    expect(await retryPostgresAnnualCorrespondence(f.db, receipt.jobId, dir)).toMatchObject({ jobId: receipt.jobId })
    await vi.waitFor(async () => expect((await getPostgresJob(f.db, receipt.jobId))?.row.state).toBe('done'), { timeout: 5000 })
    expect(await listPostgresCorrespondences(f.db, {})).toHaveLength(1)
  } finally {
    await stopPostgresJobs()
    clearJobSpecs()
    rmSync(dir, { recursive: true, force: true })
  }
})
