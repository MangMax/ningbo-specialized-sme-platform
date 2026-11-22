import { expect, it } from 'vitest'
import { recordCorrespondenceAudit } from '../../../db/postgresql/qualification-tables'
import { nativeCorrespondenceFixture } from '../correspondence/fixtures/native-correspondence'
import { listPostgresCorrespondences } from '../../../layers/sme-roster/server/utils/record-correspondence-postgres'
import { readPostgresQualifiedAnnualProcess } from '../../../layers/sme-roster/server/utils/event-annual-process-postgres'
import { useIsolatedPostgresCases } from '../../support/isolated-postgres-cases'
import { annualFixtureEvent, runAnnualFixtureTask, stageAnnualFixtureTask } from './fixtures/native-annual'

const createDb = useIsolatedPostgresCases()

it('annual reconciliation confirms the actual endpoint and replays without duplicate audit', async () => {
  const f = await nativeCorrespondenceFixture(createDb())
  const source = await f.add()
  const admitted = await stageAnnualFixtureTask(f.db, f.event.id, 'initial')
  const event = annualFixtureEvent(await runAnnualFixtureTask(f.db, admitted.jobId))
  expect(event.outcomes).toMatchObject([{ status: 'created', relationId: source.id }])
  const audit = await f.db.select().from(recordCorrespondenceAudit).orderBy(recordCorrespondenceAudit.id)
  const repeat = await stageAnnualFixtureTask(f.db, f.event.id, 'repeat')
  expect(repeat.jobId).toBe(admitted.jobId)
  expect((await readPostgresQualifiedAnnualProcess(f.db, f.event.id))?.process.finalQualification).toMatchObject({
    status: 'confirmed', decisionRefs: [{ relationId: source.id }],
  })
  expect(await f.db.select().from(recordCorrespondenceAudit).orderBy(recordCorrespondenceAudit.id)).toEqual(audit)
})

it('annual reconciliation rejects an admitted stale generation', async () => {
  const f = await nativeCorrespondenceFixture(createDb())
  await f.add()
  const admitted = await stageAnnualFixtureTask(f.db, f.event.id, 'stale')
  await f.add({ key: 'NEW' })
  const event = annualFixtureEvent(await runAnnualFixtureTask(f.db, admitted.jobId))
  expect(event).toMatchObject({ status: 'failed', errorCode: 'source_generation_changed' })
  expect(await listPostgresCorrespondences(f.db, {})).toEqual([])
})
