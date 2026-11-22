import { expect, it } from 'vitest'
import { nativeCorrespondenceFixture } from '../correspondence/fixtures/native-correspondence'
import { readFixtureAudit } from '../correspondence/fixtures/postgres-audit'
import { listPostgresCorrespondences } from '../../../layers/sme-roster/server/utils/record-correspondence-postgres'
import { readPostgresAnnualWriteScope, readPostgresQualifiedAnnualProcess } from '../../../layers/sme-roster/server/utils/event-annual-process-postgres'
import { useIsolatedPostgresCases } from '../../support/isolated-postgres-cases'
import { annualFixtureEvent, runAnnualFixtureTask, stageAnnualFixtureTask } from '../annual-correspondence/fixtures/native-annual'

const createDb = useIsolatedPostgresCases()

it('annual decision scope keeps same-version old observation confirmation', async () => {
  const f = await nativeCorrespondenceFixture(createDb())
  const old = await f.add()
  await f.save(f.request('old-confirmation', [{ action: 'create', status: 'confirmed', edge: f.edge(old.id) }]))
  const current = await f.add()
  const scope = (await readPostgresAnnualWriteScope(f.db, f.event.id))!
  expect(scope.steps[0]!.currentRelationIds).toEqual([old.id, current.id])
  expect((await readPostgresQualifiedAnnualProcess(f.db, f.event.id))?.process.finalQualification).toMatchObject({
    status: 'confirmed', decisionRefs: [{ relationId: old.id }],
  })
  const task = await stageAnnualFixtureTask(f.db, f.event.id, 'same-version')
  expect(annualFixtureEvent(await runAnnualFixtureTask(f.db, task.jobId)).outcomes).toMatchObject([{ status: 'existing', relationId: old.id }])
  expect(await listPostgresCorrespondences(f.db, {})).toHaveLength(1)
})

it('annual scope protects an explicit manual rejection across new observations', async () => {
  const f = await nativeCorrespondenceFixture(createDb())
  const old = await f.add()
  const { correspondenceIds: [id] } = await f.save(f.request('reject', [{ action: 'create', status: 'rejected', edge: f.edge(old.id) }]))
  await f.add({ status: '终审不通过' })
  const audit = await readFixtureAudit(f.db, id!)
  const task = await stageAnnualFixtureTask(f.db, f.event.id, 'protected')
  expect(annualFixtureEvent(await runAnnualFixtureTask(f.db, task.jobId)).outcomes).toMatchObject([{ status: 'protected' }])
  expect(await readFixtureAudit(f.db, id!)).toEqual(audit)
})
