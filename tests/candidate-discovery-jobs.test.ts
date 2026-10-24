import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { useDb, schema } from '../db/client'
import {
  __resetJobRunner,
  clearJobSpecs,
  ensureJobRunnerReady,
  whenIdle,
} from '../server/utils/job-runner'
import { submitCandidateDiscovery } from '../server/utils/jobs/candidate-discovery'
import { handleRecordCorrespondenceRequest } from '../server/utils/record-correspondence-api'
import { getJob } from '../server/utils/job-store'
const dirs: string[] = []
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'candidate-214-'))
  dirs.push(dir)
  const db = useDb({ dbPath: join(dir, 'isolated.db') })
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
  const query = db
    .insert(schema.platformQuery)
    .values({
      interface: 'business_list',
      queryKey: enterprise.usccNorm!,
      rdjb: '2',
      titleCode: 'specialized_sme',
      queriedAt: '2026-10-18T00:00:00Z',
      status: 'success',
      rawResponse: 'synthetic raw archive',
    })
    .returning()
    .get()
  const relation = db
    .insert(schema.platformRelation)
    .values({
      queryId: query.id,
      sequenceNo: 1,
      enterpriseId: enterprise.id,
      usccRaw: enterprise.usccNorm,
      year: 2022,
      batch: '2022-1',
      declareKind: 'apply',
      verificationStatus: 'confirmed',
      rawFields: { original: '合成原行' },
    })
    .returning()
    .get()
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
    await import('../server/utils/jobs/candidate-discovery')
  retryCandidateDiscovery(f.db, task.jobId, f.dir)
  await whenIdle()
  expect(getJob(f.db, task.jobId)).toMatchObject({
    state: 'failed',
    result: { attempt: 2, counts: { succeeded: 1, failed: 1, created: 1 } },
  })
  expect(f.read('audit', { id: edges.rows[0].id })).toEqual(audit)
})
it('cancels between persisted rows and retries the frozen checkpoint after a concurrent manual rejection', async () => {
  const f = fixture()
  for (let i = 2; i <= 60; i++)
    f.db
      .insert(schema.platformRelation)
      .values({
        queryId: f.query.id,
        sequenceNo: i,
        enterpriseId: f.enterprise.id,
        usccRaw: f.enterprise.usccNorm,
        year: 2022,
        batch: '2022-1',
        declareKind: 'apply',
        verificationStatus: 'confirmed',
      })
      .run()
  const task = submitCandidateDiscovery(
    f.db,
    { eventIds: [f.event.id], clientRequestId: 'cancel' },
    f.dir,
  )
  const { requestJobCancel } = await import('../server/utils/job-runner')
  while (
    (getJob(f.db, task.jobId)?.result as any)?.counts.created < 1 ||
    !getJob(f.db, task.jobId)?.result
  )
    await new Promise((r) => setImmediate(r))
  requestJobCancel(f.db, task.jobId)
  await whenIdle()
  const paused = getJob(f.db, task.jobId)!
  expect(paused.state).toBe('cancelled')
  expect((paused.result as any).counts.created).toBeLessThan(60)
  const edge = f.read('list', { query: { eventId: f.event.id } }).rows[0]
  const { preflightRecordCorrespondences, commitRecordCorrespondences } =
    await import('../server/utils/record-correspondence')
  const request = {
    idempotencyKey: 'manual-reject',
    sourceIdentity: 'manual',
    actor: { type: 'user' as const, id: 'synthetic-reviewer' },
    basis: '合成核验',
    ruleId: 'manual',
    ruleVersion: '1',
    operations: [
      {
        action: 'decide' as const,
        correspondenceId: edge.id,
        expectedRevision: 1,
        status: 'rejected' as const,
      },
    ],
  }
  commitRecordCorrespondences(
    f.db,
    request,
    preflightRecordCorrespondences(f.db, request).planHash,
  )
  const audit = f.read('audit', { id: edge.id })
  const { retryCandidateDiscovery } =
    await import('../server/utils/jobs/candidate-discovery')
  retryCandidateDiscovery(f.db, task.jobId, f.dir)
  await whenIdle()
  expect(getJob(f.db, task.jobId)).toMatchObject({
    state: 'done',
    result: { attempt: 2, counts: { created: 60 } },
  })
  expect(f.read('get', { id: edge.id }).status).toBe('rejected')
  expect(f.read('audit', { id: edge.id })).toEqual(audit)
})
it('preserves confirmed rejected unlinked corrected and support-role decisions under repeated runs', async () => {
  const f = fixture()
  const { preflightRecordCorrespondences, commitRecordCorrespondences } =
    await import('../server/utils/record-correspondence')
  const apply = (operations: any[], key: string) => {
    const req = {
      idempotencyKey: key,
      sourceIdentity: 'manual',
      actor: { type: 'user' as const, id: 'reviewer' },
      basis: '合成原行核对',
      ruleId: 'manual',
      ruleVersion: '1',
      operations,
    }
    return commitRecordCorrespondences(
      f.db,
      req,
      preflightRecordCorrespondences(f.db, req).planHash,
    )
  }
  const relations = [f.relation]
  for (let i = 2; i <= 5; i++)
    relations.push(
      f.db
        .insert(schema.platformRelation)
        .values({ ...f.relation, id: undefined, sequenceNo: i })
        .returning()
        .get(),
    )
  const ids = relations.map(
    (r, i) =>
      apply(
        [
          {
            action: 'create',
            status: i === 1 ? 'candidate' : 'confirmed',
            edge: {
              type: 'event_process',
              eventId: f.event.id,
              relationId: r.id,
              role: i === 0 ? 'supports_award' : 'context_only',
            },
          },
        ],
        `create${i}`,
      ).correspondenceIds[0]!,
  )
  apply(
    [
      {
        action: 'decide',
        correspondenceId: ids[1],
        expectedRevision: 1,
        status: 'rejected',
      },
    ],
    'reject',
  )
  apply(
    [
      {
        action: 'decide',
        correspondenceId: ids[2],
        expectedRevision: 2,
        status: 'unlinked',
      },
    ],
    'unlink',
  )
  const correctionTarget = f.db
    .insert(schema.platformRelation)
    .values({ ...f.relation, id: undefined, sequenceNo: 6 })
    .returning()
    .get()
  apply(
    [
      {
        action: 'correct',
        correspondenceId: ids[3],
        expectedRevision: 2,
        edge: {
          type: 'event_process',
          eventId: f.event.id,
          relationId: correctionTarget.id,
          role: 'context_only',
        },
      },
    ],
    'correct',
  )
  const before = f.read('list', { query: { eventId: f.event.id } })
  const audits = before.rows.map((r: any) => f.read('audit', { id: r.id }))
  submitCandidateDiscovery(
    f.db,
    { eventIds: [f.event.id], clientRequestId: 'protect' },
    f.dir,
  )
  await whenIdle()
  expect(f.read('list', { query: { eventId: f.event.id } })).toEqual(before)
  expect(before.rows.map((r: any) => f.read('audit', { id: r.id }))).toEqual(
    audits,
  )
})
it('queues only affected events after an archive commit and deduplicates replay without synchronous discovery', async () => {
  const f = fixture()
  const { commitRosterImport } = await import('../server/utils/roster-import')
  const request = {
    idempotencyKey: 'synthetic-new-archive',
    sourceKind: 'platform_export' as const,
    sourceIdentity: 'synthetic/archive',
    payload: {
      platformQueries: [
        {
          interface: 'business_list' as const,
          queryKey: f.enterprise.usccNorm!,
          rdjb: '2',
          titleCode: 'specialized_sme',
          queriedAt: '2026-10-23T00:00:00Z',
          status: 'success' as const,
          relations: [
            {
              sequenceNo: 1,
              enterpriseId: f.enterprise.id,
              usccRaw: f.enterprise.usccNorm,
              nameRaw: '合成企业',
              year: 2022,
              batch: '2022-1',
              declareKind: 'apply' as const,
              verificationStatus: 'confirmed' as const,
              matchBasis: 'uscc' as const,
            },
          ],
        },
      ],
    },
  }
  const commit = commitRosterImport(f.db, request) as any
  expect(commit.status).toBe('committed')
  expect(commit.candidateTaskIds).toHaveLength(1)
  expect(f.read('list', { query: { eventId: f.event.id } }).total).toBe(0)
  const replay = commitRosterImport(f.db, request) as any
  expect(replay.candidateTaskIds).toEqual(commit.candidateTaskIds)
  await whenIdle()
  const result = getJob(f.db, commit.candidateTaskIds[0])!
  expect(result).toMatchObject({
    state: 'done',
    result: { items: [{ eventId: f.event.id, status: 'done' }] },
  })
  expect((result.result as any).items).toHaveLength(1)
  expect(f.read('list', { query: { eventId: f.event.id } }).total).toBe(2)
})
it.each([
  { caseId: 'ascii-controls', whitespace: '\t\n\v\f\r ' },
  { caseId: 'nbsp-and-ogham', whitespace: '\u00a0\u1680' },
  { caseId: 'unicode-spaces', whitespace: '\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a' },
  { caseId: 'zero-width', whitespace: '\u200b\u200c\u200d' },
  { caseId: 'separators', whitespace: '\u2028\u2029\u202f\u205f' },
  { caseId: 'fullwidth-and-bom', whitespace: '\u3000\ufeff' },
])('uses discovery identity normalization for incremental scope: $caseId', async ({ whitespace }) => {
  const f = fixture()
  const { eq } = await import('drizzle-orm')
  const { discoverEventArchives } = await import('../server/utils/event-archive-discovery')
  // Neither the searched name nor a verified owner can select this archive.
  // Match the raw row to the canonical official USCC using the shared rule.
  f.db.update(schema.platformQuery).set({ queryKey: 'name:另一个查询名' })
    .where(eq(schema.platformQuery.id, f.query.id)).run()
  const rawUscc = whitespace + '91330211255994457p' + whitespace
  f.db.update(schema.platformRelation).set({ enterpriseId: null, usccRaw: rawUscc })
    .where(eq(schema.platformRelation.id, f.relation.id)).run()
  const discovered = discoverEventArchives(f.db, { eventId: f.event.id, page: 1, pageSize: 25, queryPage: 1, queryPageSize: 1 })
  expect(discovered?.rows).toMatchObject([{ edge: { eventId: f.event.id, relationId: f.relation.id } }])
  expect(discovered?.total).toBe(1)
  const task = submitCandidateDiscovery(f.db, { queryId: f.query.id, clientRequestId: 'normalization-parity' }, f.dir)
  await whenIdle()
  expect(getJob(f.db, task.jobId)).toMatchObject({ state: 'done', result: {
    items: [{ eventId: f.event.id, status: 'done' }],
    counts: { succeeded: 1, failed: 0, created: 1 },
  } })
  expect(f.read('list', { query: { eventId: f.event.id } })).toMatchObject({ total: 1,
    rows: [{ status: 'candidate', relation: { id: f.relation.id, usccRaw: rawUscc } }],
  })
})
it('shares authenticated HTTP and MCP task semantics and task center event results', async () => {
  const f = fixture()
  const { handleCandidateJobRequest, dispatchCandidateJobMcp } =
    await import('../server/utils/candidate-job-api')
  const { startHttpFixture } = await import('./helpers/http-fixture')
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
it('protects a support decision committed after page discovery but before its row is persisted', async () => {
  const f = fixture()
  const second = f.db
    .insert(schema.platformRelation)
    .values({ ...f.relation, id: undefined, sequenceNo: 2 })
    .returning()
    .get()
  const task = submitCandidateDiscovery(
    f.db,
    { eventIds: [f.event.id], clientRequestId: 'race' },
    f.dir,
  )
  while (!(getJob(f.db, task.jobId)?.result as any)?.counts.created)
    await new Promise((r) => setImmediate(r))
  const { preflightRecordCorrespondences, commitRecordCorrespondences } =
    await import('../server/utils/record-correspondence')
  const req = {
    idempotencyKey: 'manual-race',
    sourceIdentity: 'manual',
    actor: { type: 'user' as const, id: 'reviewer' },
    basis: '人工先行核验',
    ruleId: 'manual',
    ruleVersion: '1',
    operations: [
      {
        action: 'create' as const,
        status: 'confirmed' as const,
        edge: {
          type: 'event_process' as const,
          eventId: f.event.id,
          relationId: second.id,
          role: 'supports_award' as const,
        },
      },
    ],
  }
  const receipt = commitRecordCorrespondences(
    f.db,
    req,
    preflightRecordCorrespondences(f.db, req).planHash,
  )
  const audit = f.read('audit', { id: receipt.correspondenceIds[0] })
  await whenIdle()
  const edges = f.read('list', { query: { eventId: f.event.id } })
  expect(
    edges.rows.filter((r: any) => r.relationId === second.id),
  ).toMatchObject([{ status: 'confirmed', role: 'supports_award' }])
  expect(f.read('audit', { id: receipt.correspondenceIds[0] })).toEqual(audit)
  expect(getJob(f.db, task.jobId)).toMatchObject({
    state: 'done',
    result: { counts: { created: 1, existing: 1 } },
  })
})

it('accepts the exact four MiB combined source budget and retains escaped source and audit bytes', async () => {
  const f = fixture()
  const { eq } = await import('drizzle-orm')
  const collectionEvidence = { padding: '\\"\n\u0000汉😀'.repeat(2000) }
  const rawFields = { padding: '\\"\n\u0000汉😀'.repeat(2000) }
  const rawResponse = 'R'.repeat(4_194_304 - Buffer.byteLength(JSON.stringify(collectionEvidence)) - Buffer.byteLength(JSON.stringify(rawFields)))
  f.db.update(schema.platformQuery).set({ rawResponse, collectionEvidence: collectionEvidence as any }).where(eq(schema.platformQuery.id, f.query.id)).run()
  f.db.update(schema.platformRelation).set({ rawFields }).where(eq(schema.platformRelation.id, f.relation.id)).run()
  const task = submitCandidateDiscovery(f.db, { eventIds: [f.event.id], clientRequestId: 'exact-source-budget' }, f.dir)
  await whenIdle()
  expect(getJob(f.db, task.jobId)).toMatchObject({ state: 'done', result: { counts: { created: 1, failed: 0 } } })
  const edge = f.read('list', { query: { eventId: f.event.id } }).rows[0]
  const { getRecordCorrespondenceAudit } = await import('../server/utils/record-correspondence')
  const evidence = getRecordCorrespondenceAudit(f.db, edge.id)[0]!.evidence as any
  expect(evidence.query.rawResponse).toBe(rawResponse)
  expect(evidence.query.collectionEvidence).toEqual(collectionEvidence)
  expect(evidence.relation.rawFields).toEqual(rawFields)
  // One extra stored UTF-8 byte, across the same three columns, fails before domain writes.
  const next = f.db.insert(schema.platformRelation).values({ ...f.relation, id: undefined, sequenceNo: 2, rawFields: { padding: rawFields.padding + 'Z' } }).returning().get()
  const over = submitCandidateDiscovery(f.db, { eventIds: [f.event.id], clientRequestId: 'combined-source-over-budget' }, f.dir)
  await whenIdle()
  expect(getJob(f.db, over.jobId)).toMatchObject({ state: 'failed', error: expect.stringContaining('原档不变时重试仍会失败'), result: { counts: { existing: 1, created: 0, failed: 1 }, items: [{ errorCode: 'source_materialization_limit' }] } })
  expect(f.read('list', { query: { relationId: next.id } }).total).toBe(0)
  expect(getRecordCorrespondenceAudit(f.db, edge.id)[0]!.evidence).toEqual(evidence)
  const { retryCandidateDiscovery } = await import('../server/utils/jobs/candidate-discovery')
  retryCandidateDiscovery(f.db, over.jobId, f.dir)
  await whenIdle()
  expect(getJob(f.db, over.jobId)).toMatchObject({ state: 'failed', result: { attempt: 2, counts: { existing: 1, created: 0, failed: 1 } } })
  expect(getRecordCorrespondenceAudit(f.db, edge.id)[0]!.evidence).toEqual(evidence)
})
it('resumes an imported source above one MiB after cancellation and runner restoration without repeating a manual decision', async () => {
  const f = fixture()
  const { commitRosterImport } = await import('../server/utils/roster-import')
  const { requestJobCancel } = await import('../server/utils/job-runner')
  const { retryCandidateDiscovery } = await import('../server/utils/jobs/candidate-discovery')
  const rawResponse = JSON.stringify({ data: [], padding: 'X'.repeat(1_048_576) })
  const importRequest = {
    idempotencyKey: 'large-source-recovery', sourceKind: 'platform_export' as const, sourceIdentity: 'synthetic/large-recovery',
    payload: { platformQueries: [{ interface: 'business_list' as const, queryKey: f.enterprise.usccNorm!, rdjb: '2', titleCode: 'specialized_sme', queriedAt: '2026-10-23T04:00:00Z', status: 'success' as const, rawResponse,
      relations: [{ sequenceNo: 1, enterpriseId: f.enterprise.id, usccRaw: f.enterprise.usccNorm, year: 2022, declareKind: 'apply' as const, verificationStatus: 'confirmed' as const }] }] },
   }
  const receipt = commitRosterImport(f.db, importRequest)
  expect(receipt.status).toBe('committed')
  const id = receipt.candidateTaskIds[0]!
  while (!(getJob(f.db, id)?.result as any)?.counts.created) await new Promise(r => setImmediate(r))
  requestJobCancel(f.db, id)
  await whenIdle()
  expect(getJob(f.db, id)).toMatchObject({ state: 'cancelled', result: { counts: { created: 1 } } })
  const first = f.read('list', { query: { eventId: f.event.id } }).rows[0]
  const { preflightRecordCorrespondences, commitRecordCorrespondences, getRecordCorrespondenceAudit } = await import('../server/utils/record-correspondence')
  const request = { idempotencyKey: 'large-recovery-manual-reject', sourceIdentity: 'manual', actor: { type: 'user' as const, id: 'synthetic-reviewer' }, basis: '合成核验', ruleId: 'manual', ruleVersion: '1', operations: [{ action: 'decide' as const, correspondenceId: first.id, expectedRevision: 1, status: 'rejected' as const }] }
  commitRecordCorrespondences(f.db, request, preflightRecordCorrespondences(f.db, request).planHash)
  const audit = f.read('audit', { id: first.id })
  __resetJobRunner()
  clearJobSpecs()
  ensureJobRunnerReady(f.db)
  retryCandidateDiscovery(f.db, id, f.dir)
  await whenIdle()
  expect(getJob(f.db, id)).toMatchObject({ state: 'done', result: { attempt: 2, counts: { created: 2, failed: 0 } } })
  const rows = f.read('list', { query: { eventId: f.event.id } }).rows
  expect(rows).toHaveLength(2)
  expect(f.read('get', { id: first.id }).status).toBe('rejected')
  expect(f.read('audit', { id: first.id })).toEqual(audit)
  const added = rows.find((r: any) => r.id !== first.id)
  expect((getRecordCorrespondenceAudit(f.db, added.id)[0]!.evidence as any).query.rawResponse).toBe(rawResponse)
  const replay = commitRosterImport(f.db, importRequest)
  expect(replay.candidateTaskIds).toEqual(receipt.candidateTaskIds)
  await whenIdle()
  expect(f.read('list', { query: { eventId: f.event.id } }).total).toBe(2)
  expect(f.read('audit', { id: added.id }).rows).toHaveLength(1)
}, 20_000)
it('rejects sources above the measured budget before raw materialization', async () => {
  const f = fixture()
  const { eq } = await import('drizzle-orm')
  f.db
    .update(schema.platformQuery)
    .set({ rawResponse: 'X'.repeat(4_194_305) })
    .where(eq(schema.platformQuery.id, f.query.id))
    .run()
  const prepare = f.db.$client.prepare.bind(f.db.$client)
  let oversizedMaterialized = false
  f.db.$client.prepare = ((...args: Parameters<typeof prepare>) => {
    const statement = prepare(...args)
    for (const method of ['get', 'all'] as const) {
      const run = statement[method].bind(statement)
      statement[method] = ((...values: any[]) => {
        const rows = (run as any)(...values)
        if (JSON.stringify(rows)?.includes('X'.repeat(1024)))
          oversizedMaterialized = true
        return rows
      }) as any
    }
    return statement
  }) as typeof prepare
  const task = submitCandidateDiscovery(
    f.db,
    { eventIds: [f.event.id], clientRequestId: 'bounded' },
    f.dir,
  )
  await whenIdle()
  expect(getJob(f.db, task.jobId)).toMatchObject({
    state: 'failed',
    result: {
      items: [{ errorCode: 'source_materialization_limit' }],
      counts: { created: 0, failed: 1 },
    },
  })
  expect(oversizedMaterialized).toBe(false)
  expect(f.read('list', { query: { eventId: f.event.id } }).total).toBe(0)
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
it('limits incremental work to the archived identity and title including legacy null title metadata', async () => {
  const f = fixture()
  const { eq } = await import('drizzle-orm')
  f.db
    .update(schema.platformQuery)
    .set({ titleCode: null })
    .where(eq(schema.platformQuery.id, f.query.id))
    .run()
  const otherTitle = f.db
    .insert(schema.record)
    .values({
      enterpriseId: f.enterprise.id,
      titleCode: 'little_giant',
      source: 'jxj',
      usccRaw: f.enterprise.usccNorm,
    })
    .returning()
    .get()
  f.db
    .insert(schema.recordEvent)
    .values({ recordId: otherTitle.id, eventType: 'award', year: 2022 })
    .run()
  const other = f.db
    .insert(schema.enterprise)
    .values({
      name: '合成无关',
      nameNorm: '合成无关',
      usccNorm: '91330211790043112T',
    })
    .returning()
    .get()
  const otherRecord = f.db
    .insert(schema.record)
    .values({
      enterpriseId: other.id,
      titleCode: 'specialized_sme',
      source: 'jxj',
      usccRaw: other.usccNorm,
    })
    .returning()
    .get()
  f.db
    .insert(schema.recordEvent)
    .values({ recordId: otherRecord.id, eventType: 'review', year: 2022 })
    .run()
  const task = submitCandidateDiscovery(
    f.db,
    { queryId: f.query.id, clientRequestId: 'affected-only' },
    f.dir,
  )
  await whenIdle()
  expect(getJob(f.db, task.jobId)).toMatchObject({
    state: 'done',
    result: { items: [{ eventId: f.event.id }] },
  })
  expect((getJob(f.db, task.jobId)!.result as any).items).toHaveLength(1)
})
it('runs archive-triggered tasks in the application queue after the native import process exits', async () => {
  const f = fixture()
  const { createImportExecutor } =
    await import('../server/utils/import-execution')
  const executor = createImportExecutor()
  try {
    const result = (await executor.execute(f.db, 'commit', {
      idempotencyKey: 'native-archive',
      sourceKind: 'platform_export',
      sourceIdentity: 'synthetic/native',
      payload: {
        platformQueries: [
          {
            interface: 'business_list',
            queryKey: f.enterprise.usccNorm!,
            rdjb: '2',
            titleCode: 'specialized_sme',
            queriedAt: '2026-10-23T02:00:00Z',
            status: 'success',
            relations: [
              {
                sequenceNo: 1,
                enterpriseId: f.enterprise.id,
                usccRaw: f.enterprise.usccNorm,
                year: 2022,
                declareKind: 'apply',
                verificationStatus: 'confirmed',
              },
            ],
          },
        ],
      },
    })) as any
    expect(result.status).toBe('committed')
    const { requestJobCancel } = await import('../server/utils/job-runner')
    requestJobCancel(f.db, result.candidateTaskIds[0])
    await executor.close()
    await whenIdle()
    expect(getJob(f.db, result.candidateTaskIds[0])?.state).toBe('cancelled')
    const { retryCandidateDiscovery } =
      await import('../server/utils/jobs/candidate-discovery')
    retryCandidateDiscovery(f.db, result.candidateTaskIds[0], f.dir)
    await whenIdle()
    expect(getJob(f.db, result.candidateTaskIds[0])).toMatchObject({
      state: 'done',
      result: { counts: { succeeded: 1, created: 2 } },
    })
  } finally {
    await executor.close()
  }
})
it('continues large affected scopes in bounded tasks without admitting events created after the frozen boundary', async () => {
  const f = fixture()
  const { eq } = await import('drizzle-orm')
  const recordId = f.db
    .select({ recordId: schema.recordEvent.recordId })
    .from(schema.recordEvent)
    .where(eq(schema.recordEvent.id, f.event.id))
    .get()!.recordId
  for (let i = 0; i < 200; i++)
    f.db
      .insert(schema.recordEvent)
      .values({ recordId, eventType: 'award', year: 2022, batchSeq: i + 2 })
      .run()
  const task = submitCandidateDiscovery(
    f.db,
    { queryId: f.query.id, clientRequestId: 'large-affected' },
    f.dir,
  )
  while (!(getJob(f.db, task.jobId)?.result as any)?.counts.created)
    await new Promise((r) => setImmediate(r))
  const late = f.db
    .insert(schema.recordEvent)
    .values({ recordId, eventType: 'review', year: 2025 })
    .returning()
    .get()
  await whenIdle()
  const first = getJob(f.db, task.jobId)!.result as any
  expect(first.items).toHaveLength(200)
  expect(first.counts.succeeded).toBe(200)
  const next = getJob(f.db, first.continuationJobId)!
  expect(next).toMatchObject({
    state: 'done',
    result: { counts: { succeeded: 1 } },
  })
  expect((next.result as any).items).toHaveLength(1)
  expect((next.result as any).items[0].eventId).toBeLessThan(late.id)
  expect(f.read('list', { query: { eventId: late.id } }).total).toBe(0)
}, 20_000)
it('processes appended archives across all continuation generations and deduplicates replay after checkpoint recovery', async () => {
  const f = fixture()
  const { commitRosterImport } = await import('../server/utils/roster-import')
  const { requestJobCancel } = await import('../server/utils/job-runner')
  const { retryCandidateDiscovery } = await import('../server/utils/jobs/candidate-discovery')
  const eventIds = [f.event.id]
  for (let i = 2; i <= 401; i++)
    eventIds.push(f.db.insert(schema.recordEvent).values({
      recordId: f.event.recordId, eventType: 'award', year: 2022, batchSeq: i,
    }).returning().get().id)
  const chain = (id: string) => {
    const jobs = [getJob(f.db, id)!]
    while ((jobs.at(-1)!.result as any)?.continuationJobId)
      jobs.push(getJob(f.db, (jobs.at(-1)!.result as any).continuationJobId)!)
    return jobs
  }
  const query = {
    interface: 'business_list' as const,
    queryKey: f.enterprise.usccNorm!,
    rdjb: '2',
    titleCode: 'specialized_sme',
    queriedAt: f.query.queriedAt,
    status: 'success' as const,
    relations: [] as any[],
  }
  const base = {
    sourceKind: 'platform_export' as const,
    sourceIdentity: 'synthetic/append',
    payload: { platformQueries: [query] },
  }
  const first = commitRosterImport(f.db, {
    ...base,
    idempotencyKey: 'archive-before-append',
  })
  await whenIdle()
  const oldJobs = chain(first.candidateTaskIds[0]!)
  expect(oldJobs.map(j => j.state)).toEqual(['done', 'done', 'done'])
  expect(oldJobs.map(j => (j.result as any).items.length)).toEqual([200, 200, 1])
  const oldRows = eventIds.map(eventId => {
    const list = f.read('list', { query: { eventId } })
    expect(list.total).toBe(1)
    return list.rows[0]
  })
  const { preflightRecordCorrespondences, commitRecordCorrespondences } = await import('../server/utils/record-correspondence')
  const rejection = {
    idempotencyKey: 'append-tail-manual-reject', sourceIdentity: 'synthetic/manual',
    actor: { type: 'user' as const, id: 'synthetic-reviewer' }, basis: '合成尾片人工核对', ruleId: 'manual', ruleVersion: '1',
    operations: [{ action: 'decide' as const, correspondenceId: oldRows[400].id, expectedRevision: 1, status: 'rejected' as const }],
  }
  commitRecordCorrespondences(f.db, rejection, preflightRecordCorrespondences(f.db, rejection).planHash)
  const oldAudits = oldRows.map(row => f.read('audit', { id: row.id }))
  query.relations.push({
    sequenceNo: 2,
    enterpriseId: f.enterprise.id,
    usccRaw: f.enterprise.usccNorm,
    year: 2022,
    declareKind: 'apply',
    verificationStatus: 'confirmed',
  })
  const next = commitRosterImport(f.db, {
    ...base,
    idempotencyKey: 'archive-after-append',
  })
  const rootId = next.candidateTaskIds[0]!
  // Interrupt the first downstream slice after a durable row, then recover it.
  let continuationId: string | undefined
  while (!continuationId) {
    continuationId = (getJob(f.db, rootId)?.result as any)?.continuationJobId
    await new Promise(r => setImmediate(r))
  }
  while (!(getJob(f.db, continuationId)?.result as any)?.counts.created)
    await new Promise(r => setImmediate(r))
  expect(requestJobCancel(f.db, continuationId)).toMatchObject({ ok: true })
  await whenIdle()
  expect(getJob(f.db, continuationId)).toMatchObject({ state: 'cancelled' })
  __resetJobRunner(); clearJobSpecs(); ensureJobRunnerReady(f.db)
  retryCandidateDiscovery(f.db, continuationId, f.dir)
  await whenIdle()
  const newJobs = chain(rootId)
  expect(newJobs.map(j => j.state)).toEqual(['done', 'done', 'done'])
  expect(newJobs.map(j => (j.result as any).items.length)).toEqual([200, 200, 1])
  expect(newJobs.map(j => (j.result as any).throughEventId)).toEqual(Array(3).fill(eventIds[400]))
  expect(newJobs.map(j => j.params.afterEventId)).toEqual([0, eventIds[199], eventIds[399]])
  expect(newJobs.every(j => !oldJobs.some(old => old.id === j.id))).toBe(true)
  expect(newJobs.slice(1).map(j => j.params.archiveGeneration)).toEqual([rootId, rootId])
  expect((newJobs[1]!.result as any).attempt).toBe(2)
  const audits = eventIds.map((eventId, index) => {
    const list = f.read('list', { query: { eventId } })
    expect(list.total).toBe(2)
    expect(f.read('audit', { id: oldRows[index].id })).toEqual(oldAudits[index])
    return list.rows.map((row: any) => {
      if (row.id !== oldRows[index].id) {
        expect(row.status).toBe('candidate')
        expect(f.read('audit', { id: row.id }).rows).toHaveLength(1)
      }
      return { id: row.id, audit: f.read('audit', { id: row.id }) }
    })
  })
  expect(f.read('get', { id: oldRows[400].id }).status).toBe('rejected')
  const replay = commitRosterImport(f.db, { ...base, idempotencyKey: 'archive-same-generation-replay' })
  expect(replay.candidateTaskIds).toEqual(next.candidateTaskIds)
  await whenIdle()
  expect(chain(rootId)).toEqual(newJobs)
  for (const [index, eventId] of eventIds.entries()) {
    expect(f.read('list', { query: { eventId } }).total).toBe(2)
    for (const row of audits[index]!) expect(f.read('audit', { id: row.id })).toEqual(row.audit)
  }
}, 60_000)
