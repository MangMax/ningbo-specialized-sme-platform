import { expect, it } from 'vitest'
import { job } from '../../../db/postgresql/job-tables'
import { importBatch, importReceipt } from '../../../db/postgresql/import-tables'
import { recordCorrespondence, recordCorrespondenceAudit } from '../../../db/postgresql/qualification-tables'
import { nativeCorrespondenceFixture } from '../correspondence/fixtures/native-correspondence'
import { useIsolatedPostgresCases } from '../../support/isolated-postgres-cases'
import { handleRuntimeEventAnnualProcessRequest, dispatchRuntimeEventAnnualProcessMcp } from '../../../layers/sme-roster/server/utils/event-annual-process-runtime'
import { readPostgresQualifiedAnnualProcess } from '../../../layers/sme-roster/server/utils/event-annual-process-postgres'

const createDb = useIsolatedPostgresCases()
const snapshot = { isolationLevel: 'repeatable read', accessMode: 'read only' } as const

it.each(['blocked', 'none', 'eligible'] as const)('publishes current %s qualification from actual decisions rather than a done task', async status => {
  const f = await nativeCorrespondenceFixture(createDb())
  if (status !== 'none') {
    const source = await f.add()
    if (status === 'blocked') await f.save(f.request('reject', [{ action: 'create', status: 'rejected', edge: f.edge(source.id) }]))
  }
  await f.db.insert(job).values({
    id: 'synthetic-done', kind: 'event-annual-correspondence', state: 'done', createdAt: '2026-10-20T00:00:00Z',
    params: JSON.stringify({ eventIds: [f.event.id] }),
    result: JSON.stringify({ events: [{ eventId: f.event.id, finalQualification: { status: 'confirmed' } }] }),
  })
  const rest = await handleRuntimeEventAnnualProcessRequest({ method: 'GET', id: f.event.id })
  expect(rest.body).toMatchObject({ process: { finalQualification: {
    status, reasons: [status === 'blocked' ? 'protected_decision' : status === 'none' ? 'no_annual_process' : 'decision_required'],
  } } })
  expect(await dispatchRuntimeEventAnnualProcessMcp({ eventId: f.event.id })).toEqual(rest.body)
})

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

it('repeats query-only REST and MCP reads without creating jobs, ledger or audit writes', async () => {
  const f = await nativeCorrespondenceFixture(createDb())
  const source = await f.add()
  await f.save(f.request('confirm', [{ action: 'create', status: 'confirmed', edge: f.edge(source.id) }]))
  const state = () => Promise.all([job, importBatch, importReceipt, recordCorrespondence, recordCorrespondenceAudit].map(table => f.db.$count(table)))
  const before = await state()
  const first = await handleRuntimeEventAnnualProcessRequest({ method: 'GET', id: f.event.id })
  expect(first.body).toMatchObject({ process: { finalQualification: { status: 'confirmed' } } })
  for (let n = 0; n < 3; n++) {
    expect(await handleRuntimeEventAnnualProcessRequest({ method: 'GET', id: f.event.id })).toEqual(first)
    expect(await dispatchRuntimeEventAnnualProcessMcp({ eventId: f.event.id })).toEqual(first.body)
  }
  expect(await state()).toEqual(before)
})
