import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initializeDb, schema } from '../../../db/client'
import { applicationLogs, closeApplicationLogging, initializeWorkerLogging } from '../../../lib/logging'
import { __resetJobRunner, clearJobSpecs, enqueuePersistedJob, registerJob, whenIdle } from '../../../server/utils/job-runner'
import { createJob, getJob } from '../../../server/utils/job-store'
import { dispatchAnnualTaskMcp, handleAnnualTaskRequest } from '../../../server/utils/annual-correspondence-api'
import { dispatchCandidateJobMcp, handleCandidateJobRequest } from '../../../server/utils/candidate-job-api'
import { operationLogContext } from '../../../server/utils/operation-log-context'
import type { AnnualScopeReader } from '../../../server/utils/annual-correspondence'
import { createImportExecutor } from '../../../server/utils/import-execution'

let root: string, db: ReturnType<typeof initializeDb>
const previous = process.env.NUXT_LOG_DIR
const readScope: AnnualScopeReader = () => null
beforeEach(async () => {
  await closeApplicationLogging()
  root = mkdtempSync(join(tmpdir(), 'task-main-sync-180-'))
  process.env.NUXT_LOG_DIR = join(root, 'logs')
  initializeWorkerLogging()
  db = initializeDb({ create: true,  dbPath: join(root, 'synthetic.db') })
  __resetJobRunner(); clearJobSpecs()
})
afterEach(async () => {
  await whenIdle(); __resetJobRunner(); clearJobSpecs()
  db.$client.close(); await closeApplicationLogging()
  if (previous === undefined) delete process.env.NUXT_LOG_DIR; else process.env.NUXT_LOG_DIR = previous
  rmSync(root, { recursive: true, force: true })
})
async function assertContext(id: string, requestId: string) {
  await whenIdle(); await applicationLogs().flush()
  const job = getJob(db, id)!
  expect(job).toBeDefined()
  expect(JSON.stringify({ params: job.params, result: job.result })).not.toContain(requestId)
  const rows = (await applicationLogs().list({ taskId: id })).rows
  expect(rows.filter(row => row.operation === 'task.finished')).toHaveLength(1)
  expect(rows.filter(row => ['task.queued', 'task.started', 'task.finished'].includes(row.operation)).length).toBe(3)
  expect(rows.every(row => row.requestId === requestId && row.traceId === 'trace-main-sync')).toBe(true)
  return job
}
it('adopts persisted jobs with an immutable own task context and does not reattribute duplicate activation', async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let captured: unknown
  registerJob({ kind: 'adopt-context', status: 'ready', summary: 'synthetic', parse: params => ({ ok: true, params }), run: async ctx => { captured = ctx.logContext; await gate; return { result: { kept: true } } } })
  const context = { requestId: 'request-adopt-main-sync', traceId: 'trace-main-sync', taskId: 'parent-task' }
  const row = createJob(db, { id: 'adopt-main-sync', kind: 'adopt-context', params: {}, logContext: context })
  try {
    expect(enqueuePersistedJob(db, row.id, root, context)).toBe(true)
    expect(enqueuePersistedJob(db, row.id, root, { requestId: 'wrong-duplicate' })).toBe(false)
    context.requestId = 'mutated-after-admission'
  } finally { release() }
  const job = await assertContext(row.id, 'request-adopt-main-sync')
  expect(job).toMatchObject({ state: 'done', result: { kept: true } })
  expect(captured).toEqual({ requestId: 'request-adopt-main-sync', traceId: 'trace-main-sync', taskId: row.id })
  expect(enqueuePersistedJob(db, row.id, root)).toBe(false)
})
it.each(['annual', 'candidate'] as const)('preserves request facts through authorized REST %s submission without storing metadata in business parameters', async kind => {
  const requestId = 'request-rest-' + kind
  const ctx = { db, filesDir: root, apiToken: 'synthetic-token', logContext: { requestId, traceId: 'trace-main-sync' } }
  const req = { method: 'POST', path: '', headers: { authorization: 'Bearer synthetic-token' }, body: { clientRequestId: 'synthetic-rest-' + kind, eventIds: [999] } }
  const response = kind === 'annual' ? await handleAnnualTaskRequest('submit', req, { ...ctx, readScope }) : await handleCandidateJobRequest('submit', req, ctx)
  expect(response.status).toBe(202)
  const id = (response.body as { jobId: string }).jobId
  const job = await assertContext(id, requestId)
  expect(job.state).toBe('failed')
  expect((job.result as { events?: { errorCode: string }[]; items?: { errorCode: string }[] }).events?.[0]?.errorCode ?? (job.result as any).items?.[0]?.errorCode).toBe('event_unavailable')
})
it.each(['annual', 'candidate'] as const)('preserves module-owned context through %s MCP submission', async kind => {
  const requestId = 'request-mcp-' + kind
  const result = await operationLogContext.run({ requestId, traceId: 'trace-main-sync' }, () => kind === 'annual'
    ? dispatchAnnualTaskMcp('submit', { clientRequestId: 'synthetic-mcp-' + kind, eventIds: [999] }, { db, readScope, filesDir: root, authorized: true })
    : dispatchCandidateJobMcp('submit', { clientRequestId: 'synthetic-mcp-' + kind, eventIds: [999] }, { db, filesDir: root, authorized: true }))
  expect(result).not.toHaveProperty('isError')
  await assertContext((result as { jobId: string }).jobId, requestId)
})
it('adopts legacy queued jobs without inventing request identity', async () => {
  registerJob({ kind: 'legacy-adopt', status: 'ready', summary: 'synthetic', parse: params => ({ ok: true, params }), run: async ctx => { expect(ctx.logContext).toEqual({ taskId: 'legacy-main-sync' }); return { result: null } } })
  const row = createJob(db, { id: 'legacy-main-sync', kind: 'legacy-adopt', params: {} })
  expect(enqueuePersistedJob(db, row.id, root)).toBe(true)
  await whenIdle(); await applicationLogs().flush()
  expect(getJob(db, row.id)?.state).toBe('done')
  expect((await applicationLogs().list({ taskId: row.id })).rows.every(row => row.requestId === undefined && row.traceId === undefined)).toBe(true)
})
it('carries a native archive submission through continuation and annual child jobs with each own task id', async () => {
  // Keep the native Drizzle observer enabled: the context contract must hold
  // under the original query-heavy continuation and annual-child workload.
  const enterprise = db.insert(schema.enterprise).values({ name: '合成关联企业', nameNorm: '合成关联企业', usccNorm: '91330211255994457P' }).returning().get()
  const record = db.insert(schema.record).values({ enterpriseId: enterprise.id, titleCode: 'specialized_sme', source: 'jxj' }).returning().get()
  db.transaction(() => {
    for (let i = 1; i <= 201; i++) db.insert(schema.recordEvent).values({ recordId: record.id, eventType: 'award', year: 2024, batchSeq: i }).run()
  })
  const context = { requestId: 'request-native-chain', traceId: 'trace-main-sync' }
  const executor = createImportExecutor()
  try {
    const result = await executor.execute(db, 'commit', {
      idempotencyKey: 'synthetic-chain', sourceKind: 'platform_archive', sourceIdentity: 'synthetic-chain-source',
      payload: { platformQueries: [{ interface: 'business_list', queryKey: enterprise.usccNorm!, rdjb: '2', titleCode: 'specialized_sme', queriedAt: '2026-10-24T00:00:00Z', status: 'success', rawResponse: 'PRIVATE_CHAIN_BODY', relations: [{ sequenceNo: 1, relationKey: 'SYNTHETIC-1', enterpriseId: enterprise.id, usccRaw: enterprise.usccNorm, verificationStatus: 'confirmed', rawFields: { id: 'SYNTHETIC-1', sblx: '申请', year: 2024, sqsj: '2024-01-01', cszt: '终审通过' } }] }] },
    }, [], context)
    expect(result.status).toBe('committed')
    await executor.close(); await whenIdle(); await applicationLogs().flush()
    const jobs = db.select().from(schema.job).all()
    expect(jobs.filter(job => job.kind === 'event-archive-candidates')).toHaveLength(2)
    expect(jobs.filter(job => job.kind === 'event-annual-correspondence')).toHaveLength(2)
    expect(jobs.every(job => job.state === 'done')).toBe(true)
    for (const job of jobs) {
      expect(JSON.stringify({ params: job.params, result: job.result })).not.toContain(context.requestId)
      const listed = await applicationLogs().list({ taskId: job.id })
      const rows = listed.rows
      expect(rows.filter(row => row.operation === 'task.finished'), JSON.stringify({ taskId: job.id, status: listed.status, operations: rows.map(row => row.operation) })).toHaveLength(1)
      expect(rows.every(row => row.requestId === context.requestId && row.traceId === context.traceId)).toBe(true)
      expect(JSON.stringify(rows)).not.toContain('PRIVATE_CHAIN_BODY')
    }
    await applicationLogs().flush()
    const status = applicationLogs().status()
    if (process.env.LOG180_RELIABILITY_RECEIPT) writeFileSync(process.env.LOG180_RELIABILITY_RECEIPT, JSON.stringify({ status, jobs: jobs.map(({ id, kind, state, result }) => ({ id, kind, state, result })) }, null, 2))
    expect(status).toMatchObject({ overflow: 0, dropped: 0, writeUnknown: 0, drainFailures: 0, queuedEntries: 0, inFlightEntries: 0 })
    expect(status.coalesced).toBeGreaterThan(0)
  } finally { await executor.close() }
}, 60_000)
