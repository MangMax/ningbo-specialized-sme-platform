import { expect, it } from 'vitest'
import { nativeCorrespondenceFixture } from '../correspondence/fixtures/native-correspondence'
import { readFixtureAudit } from '../correspondence/fixtures/postgres-audit'
import { listPostgresCorrespondences } from '../../../layers/sme-roster/server/utils/record-correspondence-postgres'
import { readPostgresAnnualWriteScope, readPostgresQualifiedAnnualProcess } from '../../../layers/sme-roster/server/utils/event-annual-process-postgres'
import { useIsolatedPostgresCases } from '../../support/isolated-postgres-cases'
import { annualFixtureEvent, collectAnnualFixtureObservation, runAnnualFixtureTask, stageAnnualFixtureTask } from '../annual-correspondence/fixtures/native-annual'

const createDb = useIsolatedPostgresCases()

it('annual reconciliation keeps a same-content confirmation on the current capture', async () => {
  const f = await nativeCorrespondenceFixture(createDb())
  const old = await collectAnnualFixtureObservation(f, 1)
  const { correspondenceIds: [id] } = await f.save(f.request('confirmation', [{ action: 'create', status: 'confirmed', edge: f.edge(old) }]))
  const audit = await readFixtureAudit(f.db, id!)
  const current = await collectAnnualFixtureObservation(f, 2)
  const scope = (await readPostgresAnnualWriteScope(f.db, f.event.id))!
  expect(scope.steps[0]!.currentRelationIds).toEqual([current])
  expect(scope.steps[0]!.protectionRelationIds).toEqual([current])
  expect((await readPostgresQualifiedAnnualProcess(f.db, f.event.id))?.process.finalQualification).toMatchObject({
    status: 'confirmed', decisionRefs: [{ id, relationId: current, requiresRevalidation: false }],
  })
  const task = await stageAnnualFixtureTask(f.db, f.event.id, 'same-version')
  expect(annualFixtureEvent(await runAnnualFixtureTask(f.db, task.jobId)).outcomes).toMatchObject([
    { status: 'existing', relationId: current },
  ])
  expect(await listPostgresCorrespondences(f.db, {})).toMatchObject([{ id, relationId: current, status: 'confirmed' }])
  expect((await readFixtureAudit(f.db, id!)).slice(0, audit.length)).toEqual(audit)
})

it('annual reconciliation keeps a same-content manual rejection on the current capture', async () => {
  const f = await nativeCorrespondenceFixture(createDb())
  const old = await collectAnnualFixtureObservation(f, 1)
  const { correspondenceIds: [id] } = await f.save(f.request('reject', [{ action: 'create', status: 'rejected', edge: f.edge(old) }]))
  const audit = await readFixtureAudit(f.db, id!)
  const current = await collectAnnualFixtureObservation(f, 2)
  expect((await readPostgresQualifiedAnnualProcess(f.db, f.event.id))?.process.finalQualification).toMatchObject({
    status: 'blocked', decisionRefs: [{ id, relationId: current, status: 'rejected' }], reasons: ['protected_decision'],
  })
  const task = await stageAnnualFixtureTask(f.db, f.event.id, 'same-version')
  expect(annualFixtureEvent(await runAnnualFixtureTask(f.db, task.jobId)).outcomes).toMatchObject([
    { status: 'protected', relationId: current, decisionRefs: [{ id, relationId: current, status: 'rejected' }] },
  ])
  expect(await listPostgresCorrespondences(f.db, {})).toMatchObject([{ id, relationId: current, status: 'rejected' }])
  expect((await readFixtureAudit(f.db, id!)).slice(0, audit.length)).toEqual(audit)
})

it('annual reconciliation protects a rejected current capture and makes a separate decision for changed content', async () => {
  const f = await nativeCorrespondenceFixture(createDb())
  const old = await collectAnnualFixtureObservation(f, 1, '终审不通过')
  const { correspondenceIds: [id] } = await f.save(f.request('reject', [{ action: 'create', status: 'rejected', edge: f.edge(old) }]))
  const audit = await readFixtureAudit(f.db, id!)
  const originalTask = await stageAnnualFixtureTask(f.db, f.event.id, 'original')
  expect(annualFixtureEvent(await runAnnualFixtureTask(f.db, originalTask.jobId)).outcomes).toMatchObject([
    { status: 'protected', relationId: old, decisionRefs: [{ id, relationId: old, status: 'rejected' }] },
  ])

  const current = await collectAnnualFixtureObservation(f, 2)
  expect((await readPostgresQualifiedAnnualProcess(f.db, f.event.id))?.process.finalQualification).toMatchObject({
    status: 'eligible', decisionRefs: [], reasons: ['decision_required'],
  })
  const task = await stageAnnualFixtureTask(f.db, f.event.id, 'changed-content')
  const reconciled = annualFixtureEvent(await runAnnualFixtureTask(f.db, task.jobId))
  expect(reconciled.outcomes).toMatchObject([{ status: 'created', relationId: current }])
  expect(reconciled.finalQualification).toMatchObject({
    status: 'confirmed', decisionRefs: [{ relationId: current, status: 'confirmed', requiresRevalidation: false }],
  })
  const [historical, confirmed] = await listPostgresCorrespondences(f.db, {})
  expect(historical).toMatchObject({ id, relationId: old, status: 'rejected' })
  expect(confirmed).toMatchObject({ relationId: current, status: 'confirmed' })
  expect(confirmed?.id).not.toBe(id)
  expect(await readFixtureAudit(f.db, id!)).toEqual(audit)
})
