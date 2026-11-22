import assert from 'node:assert/strict'
import { commitPostgresPlatformCollection } from '../../../layers/sme-roster/server/utils/collection-import-postgres'
import { expect, it } from 'vitest'
import { nativeCorrespondenceFixture } from '../correspondence/fixtures/native-correspondence'
import { readFixtureAudit } from '../correspondence/fixtures/postgres-audit'
import { listPostgresCorrespondences } from '../../../layers/sme-roster/server/utils/record-correspondence-postgres'
import { readPostgresAnnualWriteScope, readPostgresQualifiedAnnualProcess } from '../../../layers/sme-roster/server/utils/event-annual-process-postgres'
import { useIsolatedPostgresCases } from '../../support/isolated-postgres-cases'

const createDb = useIsolatedPostgresCases()

it('annual qualification reads a same-content confirmation on the current capture', async () => {
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
  expect(await listPostgresCorrespondences(f.db, {})).toMatchObject([{ id, relationId: current, status: 'confirmed' }])
  expect((await readFixtureAudit(f.db, id!)).slice(0, audit.length)).toEqual(audit)
})

it.each(['rejected', 'unlinked'] as const)('annual qualification reads a same-content manual %s decision on the current capture', async status => {
  const f = await nativeCorrespondenceFixture(createDb())
  const old = await collectAnnualFixtureObservation(f, 1)
  const { correspondenceIds: [id] } = await f.save(f.request('initial', [
    { action: 'create', status: status === 'rejected' ? 'rejected' : 'confirmed', edge: f.edge(old) },
  ]))
  if (status === 'unlinked') {
    await f.save(f.request('manual-unlink', [
      { action: 'decide', correspondenceId: id!, expectedRevision: 2, status: 'unlinked' },
    ]))
  }
  const audit = await readFixtureAudit(f.db, id!)
  const current = await collectAnnualFixtureObservation(f, 2)
  expect((await readPostgresQualifiedAnnualProcess(f.db, f.event.id))?.process.finalQualification).toMatchObject({
    status: 'blocked', decisionRefs: [{ id, relationId: current, status }], reasons: ['protected_decision'],
  })
  expect(await listPostgresCorrespondences(f.db, {})).toMatchObject([{ id, relationId: current, status }])
  expect((await readFixtureAudit(f.db, id!)).slice(0, audit.length)).toEqual(audit)
})

it('annual qualification keeps the old rejection scoped to its original content', async () => {
  const f = await nativeCorrespondenceFixture(createDb())
  const old = await collectAnnualFixtureObservation(f, 1, '终审不通过')
  const { correspondenceIds: [id] } = await f.save(f.request('reject', [{ action: 'create', status: 'rejected', edge: f.edge(old) }]))
  const audit = await readFixtureAudit(f.db, id!)
  expect((await readPostgresQualifiedAnnualProcess(f.db, f.event.id))?.process.finalQualification).toMatchObject({
    status: 'none', decisionRefs: [],
  })

  const current = await collectAnnualFixtureObservation(f, 2)
  expect((await readPostgresQualifiedAnnualProcess(f.db, f.event.id))?.process.finalQualification).toMatchObject({
    status: 'eligible', decisionRefs: [], reasons: ['decision_required'],
  })
  expect(await listPostgresCorrespondences(f.db, {})).toMatchObject([{ id, status: 'rejected' }])
  expect(JSON.parse(audit.at(-1)!.evidence)).toMatchObject({ relation: { id: old } })
  expect(await readFixtureAudit(f.db, id!)).toEqual(audit)
})
async function collectAnnualFixtureObservation(
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
  assert(receipt.status === 'committed', JSON.stringify(receipt))
  const item = receipt.items[0]
  const relations = item?.detail?.relations
  assert(item?.ok && Array.isArray(relations) && relations.length === 1, JSON.stringify(item))
  const [relationId] = relations
  assert(typeof relationId === 'number', JSON.stringify(item))
  return relationId
}
