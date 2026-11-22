import { expect, it } from 'vitest'
import { recordCorrespondenceAudit } from '../../../db/postgresql/qualification-tables'
import { nativeCorrespondenceFixture } from '../correspondence/fixtures/native-correspondence'
import { useIsolatedPostgresCases } from '../../support/isolated-postgres-cases'
import { handleRuntimeEventAnnualProcessRequest, dispatchRuntimeEventAnnualProcessMcp } from '../../../layers/sme-roster/server/utils/event-annual-process-runtime'
import { readPostgresQualifiedAnnualProcess } from '../../../layers/sme-roster/server/utils/event-annual-process-postgres'
import { collectAnnualFixtureObservation } from '../annual-correspondence/fixtures/native-annual'

const createDb = useIsolatedPostgresCases()

it('reads only the current capture after A B A and preserves decision audit across REST and MCP', async () => {
  const f = await nativeCorrespondenceFixture(createDb())
  const initial = await collectAnnualFixtureObservation(f, 1)
  const { correspondenceIds: [id] } = await f.save(f.request('initial-confirmation', [
    { action: 'create', status: 'confirmed', edge: f.edge(initial) },
  ]))
  const audit = () => f.db.select().from(recordCorrespondenceAudit).orderBy(recordCorrespondenceAudit.id)
  const before = await audit()
  expect(before.at(-1)).toMatchObject({ correspondenceId: id, actorType: 'user', toStatus: 'confirmed' })
  const initialRead = await readPostgresQualifiedAnnualProcess(f.db, f.event.id)
  const initialVersion = initialRead?.sourceRefs.observations[0]?.versionId
  expect(initialVersion).toEqual(expect.any(Number))
  expect(initialRead?.process.finalQualification).toMatchObject({
    status: 'confirmed', decisionRefs: [{ id, relationId: initial }],
  })
  const changed = await collectAnnualFixtureObservation(f, 2, '终审不通过')
  const changedRead = await readPostgresQualifiedAnnualProcess(f.db, f.event.id)
  expect(changedRead?.sourceRefs.observations.map(ref => ref.relationId)).toEqual([changed])
  expect(changedRead?.process).toMatchObject({
    steps: [{ status: '终审不通过', latestObservationRelationIds: [changed] }],
    finalCandidateStepId: null, finalQualification: { status: 'none', decisionRefs: [] },
  })
  const current = await collectAnnualFixtureObservation(f, 3)
  const rest = await handleRuntimeEventAnnualProcessRequest({ method: 'GET', id: f.event.id, query: { pageSize: 1 } })
  expect(rest.status).toBe(200)
  expect(rest.body).toMatchObject({
    total: 1,
    sourceRefs: { observations: [{ relationId: current, versionId: initialVersion }] },
    process: {
      steps: [{ status: '终审通过', latestObservationRelationIds: [current] }],
      finalQualification: { status: 'eligible', decisionRefs: [], reasons: ['decision_required'] },
    },
  })
  expect(rest.body).not.toHaveProperty('sourceGeneration', initialRead?.sourceGeneration)
  expect(await dispatchRuntimeEventAnnualProcessMcp({ eventId: f.event.id, pageSize: 1 })).toEqual(rest.body)
  expect(await audit()).toEqual(before)
})

it('changes generation for a new business record and keeps both current records', async () => {
  const f = await nativeCorrespondenceFixture(createDb())
  const first = await f.add({ key: 'OLD' })
  const old = await readPostgresQualifiedAnnualProcess(f.db, f.event.id)
  const second = await f.add({ key: 'NEW', status: '终审不通过' })
  const current = await readPostgresQualifiedAnnualProcess(f.db, f.event.id)
  expect(current?.sourceGeneration).not.toBe(old?.sourceGeneration)
  expect(current?.sourceRefs.observations.map(ref => ref.relationId)).toEqual([first.id, second.id])
  expect(current?.process.finalCandidateStepId).toBeNull()
})
