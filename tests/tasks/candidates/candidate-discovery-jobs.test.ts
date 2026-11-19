import { submitNativePlatformQuery } from '../../platform/fixtures/native-query'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { initializeDb, schema } from '../../../db/client'
import {
  __resetJobRunner,
  clearJobSpecs,
  ensureJobRunnerReady,
  whenIdle,
} from '../../../layers/core/server/utils/job-runner'
import { submitCandidateDiscovery } from '../../../layers/sme-roster/server/utils/jobs/candidate-discovery'
import { handleRecordCorrespondenceRequest } from '../../../layers/sme-roster/server/utils/record-correspondence-api'
import { getJob } from '../../../layers/core/server/utils/job-store'
const dirs: string[] = []
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'candidate-214-'))
  dirs.push(dir)
  const db = initializeDb({ create: true,  dbPath: join(dir, 'isolated.db') })
  __resetJobRunner()
  clearJobSpecs()
  ensureJobRunnerReady(db)
  const enterprise = db
    .insert(schema.enterprise)
    .values({
      name: '合成企业',
      nameNorm: '合成企业',
      usccNorm: '91330211255994457P',
    })
    .returning()
    .get()
  const record = db
    .insert(schema.record)
    .values({
      enterpriseId: enterprise.id,
      titleCode: 'specialized_sme',
      source: 'jxj',
      usccRaw: enterprise.usccNorm,
    })
    .returning()
    .get()
  const event = db
    .insert(schema.recordEvent)
    .values({
      recordId: record.id,
      eventType: 'award',
      year: 2022,
      batchSeq: 1,
    })
    .returning()
    .get()
  db.insert(schema.recordEvidence)
    .values({
      recordEventId: event.id,
      sourceFile: 'synthetic/notice.pdf',
      page: 3,
    })
    .run()
  const native = submitNativePlatformQuery(db, {
    interface: 'business_list', queryKey: enterprise.usccNorm!, rdjb: '2', titleCode: 'specialized_sme',
    queriedAt: '2026-10-18T00:00:00Z', status: 'success', rawResponse: 'synthetic raw archive',
    relations: [{ sequenceNo: 1, enterpriseId: enterprise.id, usccRaw: enterprise.usccNorm,
      year: 2022, batch: '2022-1', declareKind: 'apply', verificationStatus: 'confirmed', rawFields: { original: '合成原行' } }],
  })
  const query = { id: native.queryId }
  const relation = { id: native.relationIds[0]! }
  const read = (action: any, extra = {}) =>
    handleRecordCorrespondenceRequest(
      { action, method: 'GET', ...extra },
      { db },
    ).body as any
  return { db, dir, event, enterprise, query, relation, read }
}
afterEach(async () => {
  await whenIdle()
  __resetJobRunner()
  clearJobSpecs()
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true })
})
it('asynchronously persists scoped candidates with domain provenance audit and idempotent replay', async () => {
  const f = fixture()
  const task = submitCandidateDiscovery(
    f.db,
    { eventIds: [f.event.id], clientRequestId: 'synthetic-first' },
    f.dir,
  )
  expect(getJob(f.db, task.jobId)?.progress.done).toBe(0)
  await whenIdle()
  const result = getJob(f.db, task.jobId)!
  expect(result).toMatchObject({
    state: 'done',
    progress: { done: 1, total: 1 },
    result: { counts: { succeeded: 1, needsReview: 1, failed: 0, created: 1 } },
  })
  const list = f.read('list', { query: { eventId: f.event.id } })
  expect(list).toMatchObject({
    total: 1,
    rows: [
      {
        status: 'candidate',
        ruleVersion: 'event-archive-212-v1',
        relation: { id: f.relation.id },
      },
    ],
  })
  const audit = f.read('audit', { id: list.rows[0].id })
  expect(audit.rows).toMatchObject([
    {
      toStatus: 'candidate',
      actorType: 'agent',
      actorId: 'candidate-discovery-job',
      ruleVersion: 'event-archive-212-v1',
    },
  ])
  expect(
    f.read('source', { kind: 'relation', id: f.relation.id }).source.rawFields,
  ).toEqual({ original: '合成原行' })
  expect(
    submitCandidateDiscovery(
      f.db,
      { eventIds: [f.event.id], clientRequestId: 'synthetic-first' },
      f.dir,
    ).jobId,
  ).toBe(task.jobId)
  submitCandidateDiscovery(
    f.db,
    { eventIds: [f.event.id], clientRequestId: 'synthetic-second' },
    f.dir,
  )
  await whenIdle()
  expect(f.read('list', { query: { eventId: f.event.id } }).total).toBe(1)
  expect(f.read('audit', { id: list.rows[0].id }).rows).toEqual(audit.rows)
})

it('keeps partial failures and resumes only unfinished events without repeating successful audits', async () => {
  const f = fixture()
  const task = submitCandidateDiscovery(
    f.db,
    { eventIds: [f.event.id, 999999], clientRequestId: 'partial' },
    f.dir,
  )
  await whenIdle()
  expect(getJob(f.db, task.jobId)).toMatchObject({
    state: 'failed',
    result: { counts: { succeeded: 1, failed: 1, created: 1 } },
  })
  const edges = f.read('list', { query: { eventId: f.event.id } })
  const audit = f.read('audit', { id: edges.rows[0].id })
  const { retryCandidateDiscovery } =
    await import('../../../layers/sme-roster/server/utils/jobs/candidate-discovery')
  retryCandidateDiscovery(f.db, task.jobId, f.dir)
  await whenIdle()
  expect(getJob(f.db, task.jobId)).toMatchObject({
    state: 'failed',
    result: { attempt: 2, counts: { succeeded: 1, failed: 1, created: 1 } },
  })
  expect(f.read('audit', { id: edges.rows[0].id })).toEqual(audit)
})

it('shares authenticated HTTP and MCP task semantics and task center event results', async () => {
  const f = fixture()
  const { handleCandidateJobRequest, dispatchCandidateJobMcp } =
    await import('../../../layers/sme-roster/server/utils/candidate-job-api')
  const { startHttpFixture } = await import('../../support/http')
  const context = { db: f.db, filesDir: f.dir, apiToken: 'synthetic-task-key' }
  const api = await startHttpFixture({
    routes: {
      '/api/roster/correspondences/tasks': (r) =>
        handleCandidateJobRequest('submit', r, context),
    },
  })
  try {
    const body = { eventIds: [f.event.id], clientRequestId: 'wire' }
    expect(
      (
        await fetch(`${api.baseUrl}/api/roster/correspondences/tasks`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
      ).status,
    ).toBe(401)
    const response = await fetch(
      `${api.baseUrl}/api/roster/correspondences/tasks`,
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer synthetic-task-key',
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      },
    )
    expect(response.status).toBe(202)
    const receipt = await response.json()
    expect(
      await dispatchCandidateJobMcp('submit', body, {
        ...context,
        authorized: true,
      }),
    ).toMatchObject({ jobId: receipt.jobId, kind: receipt.kind })
    await whenIdle()
    const detail = (await dispatchCandidateJobMcp(
      'detail',
      { id: receipt.jobId },
      { ...context, authorized: true },
    )) as any
    expect(detail).toMatchObject({
      kind: 'event-archive-candidates',
      group: 'platform',
      state: 'done',
      discovery: {
        ruleVersion: 'event-archive-212-v1',
        counts: { created: 1 },
        items: [{ eventId: f.event.id }],
      },
    })
    expect(detail.links).toContainEqual({
      label: `核对公布事件 #${f.event.id}`,
      to: `/enterprises/${f.enterprise.id}?eventId=${f.event.id}`,
    })
    expect(JSON.stringify(detail)).not.toContain('synthetic raw archive')
    expect(
      await dispatchCandidateJobMcp('submit', body, {
        ...context,
        authorized: false,
      }),
    ).toMatchObject({ isError: true })
  } finally {
    await api.close()
  }
})

it('rejects invalid scopes and conflicting request reuse while keeping empty scopes truthful', async () => {
  const f = fixture()
  for (const input of [
    { clientRequestId: 'x' },
    { clientRequestId: 'x', eventIds: [] },
    { clientRequestId: 'x', eventIds: [1], queryId: 1 },
    { clientRequestId: 'x', titleCode: 'invalid' },
    {
      clientRequestId: 'x',
      eventIds: Array.from({ length: 201 }, (_, i) => i + 1),
    },
  ])
    expect(() => submitCandidateDiscovery(f.db, input, f.dir)).toThrow()
  const task = submitCandidateDiscovery(
    f.db,
    { titleCode: 'little_giant', clientRequestId: 'empty' },
    f.dir,
  )
  await whenIdle()
  expect(getJob(f.db, task.jobId)).toMatchObject({
    state: 'done',
    result: { items: [], counts: { succeeded: 0, created: 0 } },
  })
  expect(() =>
    submitCandidateDiscovery(
      f.db,
      { titleCode: 'specialized_sme', clientRequestId: 'empty' },
      f.dir,
    ),
  ).toThrow('请求标识已用于不同参数')
})

it('cancels before discovery writes and retries the same frozen scope without duplicate audit', async () => {
  const f = fixture()
  const { requestJobCancel } = await import('../../../layers/core/server/utils/job-runner')
  const { retryCandidateDiscovery } = await import('../../../layers/sme-roster/server/utils/jobs/candidate-discovery')
  const task = submitCandidateDiscovery(f.db, { eventIds: [f.event.id], clientRequestId: 'native-cancel' }, f.dir)
  expect(requestJobCancel(f.db, task.jobId)).toMatchObject({ ok: true })
  await whenIdle()
  expect(getJob(f.db, task.jobId)?.state).toBe('cancelled')
  expect(f.read('list', { query: { eventId: f.event.id } }).total).toBe(0)
  retryCandidateDiscovery(f.db, task.jobId, f.dir)
  await whenIdle()
  expect(getJob(f.db, task.jobId)).toMatchObject({ state: 'done', result: { counts: { succeeded: 1, created: 1 } } })
  const rows = f.read('list', { query: { eventId: f.event.id } }).rows
  expect(rows).toHaveLength(1)
  expect(f.read('audit', { id: rows[0].id }).rows).toHaveLength(1)
})
