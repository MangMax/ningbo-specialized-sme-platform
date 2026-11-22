import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { expect, it, vi } from 'vitest'
import { job } from '../../../db/postgresql/job-tables'
import { recordEvent } from '../../../db/postgresql/ledger-tables'
import { recordCorrespondence, recordCorrespondenceAudit } from '../../../db/postgresql/qualification-tables'
import { platformBusinessObservation, platformBusinessRecordVersion, platformCollection } from '../../../db/postgresql/platform-tables'
import { singlePostgresFixtureRow, useIsolatedPostgresCases } from '../../support/isolated-postgres-cases'
import { nativeCorrespondenceFixture } from '../correspondence/fixtures/native-correspondence'
import { seedPostgresPlatformQuery } from '../../platform/fixtures/postgres-query'
import { readPostgresAnnualWriteScope, readPostgresQualifiedAnnualProcess } from '../../../layers/sme-roster/server/utils/event-annual-process-postgres'
import { handlePostgresAnnualTaskRequest } from '../../../layers/sme-roster/server/utils/annual-correspondence-runtime'
import { postgresAnnualCorrespondenceSpec } from '../../../layers/sme-roster/server/utils/jobs/annual-correspondence-postgres-spec'
import { getPostgresJob } from '../../../layers/core/server/utils/job-store-postgres'
import { clearJobSpecs, registerJob } from '../../../layers/core/server/utils/job-spec-registry'
import { stopPostgresJobs } from '../../../layers/core/server/utils/postgres-jobs'
import { annualFixtureEvent, runAnnualFixtureTask, stageAnnualFixtureTask } from './fixtures/native-annual'

vi.mock('@nuxtjs/mcp-toolkit/server', () => ({ defineMcpTool: (definition: unknown) => definition }))
const openDatabase = useIsolatedPostgresCases()
async function fixture() {
  const f = await nativeCorrespondenceFixture(openDatabase())
  let serial = 0
  const add = async (options: {
    key?: string; year?: number | null; status?: string; source?: 'business_list' | 'apply_list'; appliedAt?: string;
    kind?: 'apply' | 'review';
  } = {}) => {
    const year = options.year === undefined ? 2024 : options.year
    const key = options.key ?? 'SAME-1', status = options.status ?? '终审通过'
    const source = options.source ?? 'business_list'
    const seeded = await seedPostgresPlatformQuery(f.db, {
      interface: source, queryKey: f.enterprise.usccNorm!, queriedAt: `2026-10-20T00:${String(++serial).padStart(2, '0')}:00Z`,
      titleCode: source === 'business_list' ? 'specialized_sme' : null, rdjb: source === 'business_list' ? '2' : '',
      status: 'success', rawResponse: 'Synthetic annual source',
      relations: [{
        sequenceNo: 1, relationKey: key, enterpriseId: f.enterprise.id, usccRaw: f.enterprise.usccNorm, nameRaw: f.enterprise.name,
        verificationStatus: 'confirmed', matchBasis: 'uscc',
        rawFields: { id: key, sblx: options.kind === 'review' ? '复核' : '申请', sqsj: options.appliedAt ?? '2024-06-01',
          ...(year === null ? {} : { year: String(year) }), cszt: status },
      }],
    })
    return seeded.relationIds[0]!
  }
  const scope = async () => (await readPostgresAnnualWriteScope(f.db, f.event.id))!
  const read = async () => (await readPostgresQualifiedAnnualProcess(f.db, f.event.id))!
  const reconcile = async (key = 'annual-task') => {
    const admitted = await stageAnnualFixtureTask(f.db, f.event.id, key)
    return annualFixtureEvent(await runAnnualFixtureTask(f.db, admitted.jobId))
  }
  const audit = () => f.db.select().from(recordCorrespondenceAudit).orderBy(recordCorrespondenceAudit.id)
  return { ...f, add, scope, read, reconcile, audit }
}

it('writes native-title business endpoints using annual year lineage and retains early failure with a unique late final', async () => {
  const f = await fixture()
  const early = await f.add({ key: 'EARLY', year: null, status: '终审不通过', appliedAt: '2024-01-01' })
  await f.add({ key: 'EARLY', source: 'apply_list', year: 2024, status: '终审不通过', appliedAt: '2024-01-01' })
  const late = await f.add({ key: 'LATE', year: null })
  await f.add({ key: 'LATE', source: 'apply_list', year: 2024 })
  const source = () => Promise.all([
    f.db.select().from(platformCollection).orderBy(platformCollection.id),
    f.db.select().from(platformBusinessObservation).orderBy(platformBusinessObservation.id),
    f.db.select().from(platformBusinessRecordVersion).orderBy(platformBusinessRecordVersion.id),
  ])
  const sourceBefore = await source()
  const before = await f.read()
  expect(before.process.steps).toHaveLength(2)
  expect((await f.scope()).steps.map(step => step.preferredRelationId)).toEqual([early, late])
  expect((await f.reconcile()).outcomes).toMatchObject([{ status: 'created', relationId: early }, { status: 'created', relationId: late }])
  const after = await f.read()
  expect(after.sourceGeneration).toBe(before.sourceGeneration)
  expect(after.process.finalQualification).toMatchObject({
    stepId: before.process.finalCandidateStepId, status: 'confirmed',
    decisionRefs: [{ relationId: late, requiresRevalidation: false }],
  })
  expect(await source()).toEqual(sourceBefore)
})

it.each(['rejected', 'unlinked'] as const)('does not use a manual %s decision tied to a superseded capture', async status => {
  const f = await fixture()
  const old = await f.add({ year: 2023, kind: 'review' })
  const { correspondenceIds: [id] } = await f.save(f.request('historical', [{
    action: 'create', status: status === 'rejected' ? 'rejected' : 'confirmed', edge: f.edge(old),
  }]))
  if (status === 'unlinked') await f.save(f.request('cancel', [{ action: 'decide', correspondenceId: id!, expectedRevision: 2, status: 'unlinked' }]))
  const current = await f.add()
  const before = await f.read(), scope = await f.scope()
  expect(before.sourceRefs.observations.map(ref => ref.relationId)).not.toContain(old)
  expect(scope.generation).toBe(before.sourceGeneration)
  expect(scope.steps[0]!.currentRelationIds).toEqual([current])
  expect(scope.steps[0]!.protectionRelationIds).not.toContain(old)
  const audits = await f.audit()
  expect((await f.reconcile()).outcomes).toMatchObject([{ status: 'created', relationId: current }])
  expect((await f.read()).process.finalQualification).toMatchObject({ status: 'confirmed', decisionRefs: [{ relationId: current }] })
  expect((await f.audit()).slice(0, audits.length)).toEqual(audits)
})

it('does not let a different event historical rejection block current-year confirmation', async () => {
  const f = await fixture()
  const old = await f.add({ year: 2023, kind: 'review' })
  const other = singlePostgresFixtureRow(await f.db.insert(recordEvent).values({ recordId: f.record.id, eventType: 'award', year: 2023 }).returning())
  await f.save(f.request('other-event-history', [{ action: 'create', status: 'rejected', edge: { ...f.edge(old), eventId: other.id } }]))
  const current = await f.add()
  expect((await f.reconcile()).outcomes).toMatchObject([{ status: 'created', relationId: current }])
  expect((await f.read()).process.finalQualification?.status).toBe('confirmed')
})

it('requires an independent new-version decision and preserves the old fingerprint and audit', async () => {
  const f = await fixture()
  const old = await f.add({ status: '终审不通过' })
  const { correspondenceIds: [id] } = await f.save(f.request('old-confirmed', [{ action: 'create', status: 'confirmed', edge: f.edge(old) }]))
  const readOld = () => f.db.select().from(recordCorrespondence).where(eq(recordCorrespondence.id, id!))
  const oldRows = await readOld(), audit = await f.audit()
  const current = await f.add()
  expect((await f.read()).process.finalQualification).toMatchObject({ status: 'eligible', decisionRefs: [] })
  expect((await f.scope()).steps[0]!.currentRelationIds).toEqual([current])
  expect((await f.reconcile()).outcomes).toMatchObject([{ status: 'created', relationId: current }])
  expect(await readOld()).toEqual(oldRows)
  expect((await f.audit()).slice(0, audit.length)).toEqual(audit)
})

it('never falls back to an older confirmed pass after a later application fails', async () => {
  const f = await fixture()
  const old = await f.add({ key: 'OLD', appliedAt: '2024-01-01' })
  expect((await f.reconcile()).outcomes).toMatchObject([{ status: 'created', relationId: old }])
  const latest = await f.add({ key: 'LATEST', status: '终审不通过', appliedAt: '2024-12-01' })
  const scope = await f.scope()
  expect(scope.finalCandidateStepId).toBeNull()
  expect(scope.steps.some(step => step.currentRelationIds.includes(latest))).toBe(true)
  expect((await f.read()).process.finalQualification).toMatchObject({ stepId: null, status: 'none' })
})

it('uses the corrected current business year instead of superseded source values', async () => {
  const f = await fixture()
  const old = await f.add({ year: 2023 })
  const current = await f.add({ year: 2024 })
  expect((await f.scope()).steps.flatMap(step => step.currentRelationIds)).toEqual([current])
  await expect(f.save(f.request('superseded', [{ action: 'create', status: 'confirmed', edge: f.edge(old) }])))
    .rejects.toThrow('Persisted positive interface row not found')
  expect((await f.reconcile()).outcomes).toMatchObject([{ status: 'created', relationId: current }])
  expect((await f.read()).process.finalQualification).toMatchObject({ status: 'confirmed', decisionRefs: [{ relationId: current }] })
})

it('runs registered MCP handlers with independent credentials and the actual annual read and queue', async () => {
  const f = await fixture()
  await f.add()
  const dir = mkdtempSync(join(tmpdir(), 'annual-mcp-runtime-'))
  vi.stubGlobal('useRuntimeConfig', () => ({ apiToken: 'rest-fixture', mcpToken: 'mcp-fixture', filesDir: dir }))
  clearJobSpecs()
  registerJob(postgresAnnualCorrespondenceSpec)
  try {
    const submit = (await import('../../../layers/sme-roster/server/mcp/tools/submit_event_annual_correspondence_task')).default
    const get = (await import('../../../layers/sme-roster/server/mcp/tools/get_event_annual_correspondence_task')).default
    const eventIds = [f.event.id]
    expect(await submit.handler({ clientRequestId: 'deny', eventIds }, {} as never)).toMatchObject({ isError: true })
    expect(await f.db.select().from(job)).toEqual([])
    const result = await submit.handler({ clientRequestId: 'allow', eventIds }, { requestInfo: { headers: { authorization: 'Bearer mcp-fixture' } } } as never) as { jobId: string }
    expect(result).toMatchObject({ jobId: expect.any(String) })
    await vi.waitFor(async () => expect((await getPostgresJob(f.db, result.jobId))?.row.state).toBe('done'), { timeout: 5_000 })
    expect(await get.handler({ id: result.jobId }, {} as never)).toMatchObject({
      status: 'done', result: { events: [{ finalQualification: { status: 'confirmed' } }] },
    })
    const rest = await handlePostgresAnnualTaskRequest('submit', {
      method: 'POST', headers: { authorization: 'Bearer rest-fixture' }, body: { clientRequestId: 'rest-same-scope', eventIds },
    }, { filesDir: dir, apiToken: 'rest-fixture' })
    expect(rest.body).toMatchObject({ jobId: result.jobId })
  } finally {
    await stopPostgresJobs()
    clearJobSpecs()
    rmSync(dir, { recursive: true, force: true })
  }
}, 20_000)
