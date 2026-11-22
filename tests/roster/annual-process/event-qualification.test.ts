import { expect, it } from 'vitest'
import { nativeCorrespondenceFixture } from '../correspondence/fixtures/native-correspondence'
import { useIsolatedPostgresCases } from '../../support/isolated-postgres-cases'
import { readPostgresQualifiedAnnualProcess } from '../../../layers/sme-roster/server/utils/event-annual-process-postgres'

const createDb = useIsolatedPostgresCases()
const snapshot = { isolationLevel: 'repeatable read', accessMode: 'read only' } as const

it('keeps annual source and decision qualification in one snapshot while another transaction unlinks its decision', async () => {
  const f = await nativeCorrespondenceFixture(createDb())
  const source = await f.add()
  const { correspondenceIds: [id] } = await f.save(f.request('confirm', [{ action: 'create', status: 'confirmed', edge: f.edge(source.id) }]))
  await f.db.transaction(async tx => {
    const before = await readPostgresQualifiedAnnualProcess(tx, f.event.id)
    expect(before?.process.finalQualification).toMatchObject({
      status: 'confirmed', decisionRefs: [{ relationId: source.id, requiresRevalidation: false }],
    })
    await f.save(f.request('unlink', [{ action: 'decide', correspondenceId: id!, expectedRevision: 2, status: 'unlinked' }]))
    expect(await readPostgresQualifiedAnnualProcess(tx, f.event.id)).toEqual(before)
  }, snapshot)
  const after = await readPostgresQualifiedAnnualProcess(f.db, f.event.id)
  expect(after?.process.finalQualification).toMatchObject({
    status: 'blocked', reasons: ['protected_decision'], decisionRefs: [{ status: 'unlinked', relationId: source.id }],
  })
})
