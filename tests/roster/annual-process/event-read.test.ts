import { expect, it } from 'vitest'
import { recordCorrespondenceAudit } from '../../../db/postgresql/qualification-tables'
import { nativeCorrespondenceFixture } from '../correspondence/fixtures/native-correspondence'
import { useIsolatedPostgresCases } from '../../support/isolated-postgres-cases'
import { handleRuntimeEventAnnualProcessRequest, dispatchRuntimeEventAnnualProcessMcp } from '../../../layers/sme-roster/server/utils/event-annual-process-runtime'
import { readPostgresQualifiedAnnualProcess } from '../../../layers/sme-roster/server/utils/event-annual-process-postgres'

const createDb = useIsolatedPostgresCases()

it('retains A B A versions and selected observation decisions across read-only REST and MCP', async () => {
  const f = await nativeCorrespondenceFixture(createDb())
  const a = await f.add()
  await f.add({ status: '终审不通过' })
  await f.add()
  await f.save(f.request('old-confirmation', [{ action: 'create', status: 'confirmed', edge: f.edge(a.id) }]))
  const audit = () => f.db.select().from(recordCorrespondenceAudit).orderBy(recordCorrespondenceAudit.id)
  const before = await audit()
  const annual = await readPostgresQualifiedAnnualProcess(f.db, f.event.id)
  expect(annual?.process.steps).toHaveLength(1)
  expect(annual?.sourceRefs.observations).toHaveLength(3)
  const rest = await handleRuntimeEventAnnualProcessRequest({ method: 'GET', id: f.event.id, query: { pageSize: 1 } })
  expect(rest.status).toBe(200)
  expect(await dispatchRuntimeEventAnnualProcessMcp({ eventId: f.event.id, pageSize: 1 })).toEqual(rest.body)
  expect(await audit()).toEqual(before)
})

it('changes generation for appended sources while retaining historical observations', async () => {
  const f = await nativeCorrespondenceFixture(createDb())
  await f.add({ key: 'OLD' })
  const old = await readPostgresQualifiedAnnualProcess(f.db, f.event.id)
  await f.add({ key: 'NEW', status: '终审不通过' })
  const current = await readPostgresQualifiedAnnualProcess(f.db, f.event.id)
  expect(current?.sourceGeneration).not.toBe(old?.sourceGeneration)
  expect(current?.sourceRefs.observations).toHaveLength(2)
  expect(current?.process.finalCandidateStepId).toBeNull()
})
