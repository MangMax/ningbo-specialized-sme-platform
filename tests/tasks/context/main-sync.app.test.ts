import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pg from 'pg'
import { newJobId } from '../../../layers/core/lib/job'
import { closePostgresDirectoryDb, usePostgresDirectoryDb } from '../../../db/postgresql/client'
import { applicationLogs, closeApplicationLogging, initializeWorkerLogging } from '../../../layers/core/lib/logging'
import { registerJob } from '../../../layers/core/server/utils/job-spec-registry'
import { stagePostgresJob } from '../../../layers/core/server/utils/job-runner-postgres'
import { getPostgresJob } from '../../../layers/core/server/utils/job-store-postgres'
import { startPostgresJobs, stopPostgresJobs } from '../../../layers/core/server/utils/postgres-jobs'
import { dispatchPostgresAnnualTaskMcp, handlePostgresAnnualTaskRequest } from '../../../layers/sme-roster/server/utils/annual-correspondence-runtime'
import { dispatchPostgresCandidateJobMcp, handlePostgresCandidateJobRequest } from '../../../layers/sme-roster/server/utils/candidate-job-runtime'
import { operationLogContext } from '../../../layers/core/server/utils/operation-log-context'
import { runPostgresMixedImport } from '../../../layers/sme-roster/server/utils/roster-mixed-import-postgres'
import { postgresRuntimeFixture } from '../../support/postgres-fixture.mjs'

let root: string, pool: pg.Pool
let postgres: Awaited<ReturnType<typeof postgresRuntimeFixture>> | undefined
const db = usePostgresDirectoryDb
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'task-main-sync-'))
  postgres = await postgresRuntimeFixture({ dir: root })
  for (const [key, value] of Object.entries(postgres.env)) vi.stubEnv(key, value)
  vi.stubEnv('NUXT_DB_READONLY', '0')
  pool = new pg.Pool({ connectionString: postgres.url })
  initializeWorkerLogging()
}, 90_000)
afterEach(async () => {
  await stopPostgresJobs()
  await pool?.query('DELETE FROM business.job')
}, 150_000)
afterAll(async () => {
  try {
    await closeApplicationLogging()
    await closePostgresDirectoryDb()
    await pool?.end()
  } finally {
    vi.unstubAllEnvs()
    postgres?.close()
    if (root) rmSync(root, { recursive: true, force: true })
  }
}, 30_000)
async function terminal(id: string) {
  const read = async () => (await getPostgresJob(db(), id))?.row
  await expect.poll(async () => (await read())?.state).toMatch(/^(done|failed|cancelled)$/)
  return (await read())!
}
async function assertContext(id: string, requestId: string) {
  const job = await terminal(id)
  await expect.poll(async () => {
    await applicationLogs().flush()
    return (await applicationLogs().list({ taskId: id })).rows.filter(row => row.operation === 'task.finished').length
  }).toBe(1)
  expect(JSON.stringify({ params: job.params, result: job.result })).not.toContain(requestId)
  const listed = await applicationLogs().list({ taskId: id })
  const rows = listed.rows
  expect(rows.filter(row => row.operation === 'task.finished'), JSON.stringify({ taskId: id, status: listed.status, operations: rows.map(row => row.operation) })).toHaveLength(1)
  expect(rows.filter(row => ['task.queued', 'task.started', 'task.finished'].includes(row.operation))).toHaveLength(3)
  expect(rows.every(row => row.requestId === requestId && row.traceId === 'trace-main-sync')).toBe(true)
  return job
}
it('adopts persisted jobs with an immutable own task context and does not reattribute duplicate activation', async () => {
  const gate = Promise.withResolvers<void>()
  let captured: unknown
  registerJob({
    kind: 'adopt-context', status: 'ready', summary: 'synthetic', deduplicateRequest: true,
    parse: params => ({ ok: true, params }),
    postgres: { async run(ctx) { captured = ctx.logContext; await gate.promise; return { result: { kept: true } } } },
  })
  const context = { requestId: 'request-adopt-main-sync', traceId: 'trace-main-sync', taskId: 'parent-task' }
  const runner = startPostgresJobs(root)!.runner
  const input = { kind: 'adopt-context', params: { clientRequestId: 'one-adoption' } }
  const row = await runner.submit({ ...input, logContext: context })
  try {
    expect((await runner.submit({ ...input, logContext: { requestId: 'wrong-duplicate' } })).id).toBe(row.id)
    context.requestId = 'mutated-after-admission'
  } finally { gate.resolve() }
  const job = await assertContext(row.id, 'request-adopt-main-sync')
  expect(job).toMatchObject({ state: 'done', result: { kept: true } })
  expect(captured).toMatchObject({ requestId: 'request-adopt-main-sync', traceId: 'trace-main-sync', taskId: row.id })
  expect((await runner.submit(input)).id).toBe(row.id)
  const rolledBackId = newJobId()
  await expect(runner.trackSubmission(remember => db().transaction(async tx => {
    const { row: pending } = await stagePostgresJob(tx, { id: rolledBackId, kind: input.kind, params: { clientRequestId: 'rolled-back' } })
    remember([pending])
    throw new Error('fixture rollback')
  }), context)).rejects.toThrow('fixture rollback')
  expect(await getPostgresJob(db(), rolledBackId)).toBeNull()
  await applicationLogs().flush()
  expect((await applicationLogs().list({ taskId: rolledBackId })).rows).toEqual([])
})
it.each(['annual', 'candidate'] as const)('preserves request facts through authorized REST %s submission without storing metadata in business parameters', async kind => {
  const requestId = 'request-rest-' + kind
  const ctx = { filesDir: root, apiToken: 'synthetic-token', logContext: { requestId, traceId: 'trace-main-sync' } }
  const req = { method: 'POST', path: '', headers: { authorization: 'Bearer synthetic-token' }, body: { clientRequestId: 'synthetic-rest-' + kind, eventIds: [999] } }
  const response = kind === 'annual' ? await handlePostgresAnnualTaskRequest('submit', req, ctx) : await handlePostgresCandidateJobRequest('submit', req, ctx)
  expect(response.status).toBe(202)
  const id = (response.body as { jobId: string }).jobId
  const job = await assertContext(id, requestId)
  expect(job.state).toBe('failed')
  expect((job.result as { events?: { errorCode: string }[]; items?: { errorCode: string }[] }).events?.[0]?.errorCode ?? (job.result as any).items?.[0]?.errorCode).toBe('event_unavailable')
})
it.each(['annual', 'candidate'] as const)('preserves module-owned context through %s MCP submission', async kind => {
  const requestId = 'request-mcp-' + kind
  const ctx = { filesDir: root, authorized: true }
  const args = { clientRequestId: 'synthetic-mcp-' + kind, eventIds: [999] }
  const result = await operationLogContext.run({ requestId, traceId: 'trace-main-sync' }, () => kind === 'annual'
    ? dispatchPostgresAnnualTaskMcp('submit', args, ctx) : dispatchPostgresCandidateJobMcp('submit', args, ctx))
  expect(result).not.toHaveProperty('isError')
  await assertContext((result as { jobId: string }).jobId, requestId)
})
it('adopts legacy queued jobs without inventing request identity', async () => {
  const id = newJobId()
  registerJob({
    kind: 'legacy-adopt', status: 'ready', summary: 'synthetic', parse: params => ({ ok: true, params }),
    postgres: { async run(ctx) { expect(ctx.logContext).toEqual({ module: null, taskId: id }); return { result: null } } },
  })
  await db().transaction(tx => stagePostgresJob(tx, { id, kind: 'legacy-adopt', params: {} }))
  startPostgresJobs(root)
  expect((await terminal(id)).state).toBe('done')
  await applicationLogs().flush()
  const rows = (await applicationLogs().list({ taskId: id })).rows
  expect(rows.map(row => row.operation).sort()).toEqual(['task.finished', 'task.started'])
  expect(rows.every(row => row.requestId === undefined && row.traceId === undefined)).toBe(true)
})
it('carries a native archive submission through continuation and annual child jobs with each own task id', async () => {
  const uscc = '91330211255994457P'
  const { rows: [enterprise] } = await pool.query(
    'INSERT INTO business.enterprise(name,name_norm,uscc_norm) VALUES ($1,$1,$2) RETURNING id',
    ['合成关联企业', uscc],
  )
  const { rows: [record] } = await pool.query(
    "INSERT INTO business.record(enterprise_id,title_code,source) VALUES ($1,'specialized_sme','jxj') RETURNING id",
    [enterprise.id],
  )
  await pool.query(`
    INSERT INTO business.record_event(record_id,event_type,year,batch_seq)
    SELECT $1,'award',2024,i FROM generate_series(1,201) i
  `, [record.id])
  const context = { requestId: 'request-native-chain', traceId: 'trace-main-sync' }
  startPostgresJobs(root)
  const result = await runPostgresMixedImport('commit', {
    idempotencyKey: 'synthetic-chain', sourceKind: 'platform_archive', sourceIdentity: 'synthetic-chain-source',
    payload: { platformQueries: [{
      interface: 'business_list', queryKey: uscc, rdjb: '2', titleCode: 'specialized_sme',
      queriedAt: '2026-10-24T00:00:00Z', status: 'success', rawResponse: 'PRIVATE_CHAIN_BODY',
      relations: [{ sequenceNo: 1, relationKey: 'SYNTHETIC-1', enterpriseId: Number(enterprise.id), usccRaw: uscc, verificationStatus: 'confirmed',
        rawFields: { id: 'SYNTHETIC-1', sblx: '申请', year: 2024, sqsj: '2024-01-01', cszt: '终审通过' } }],
    }] },
  }, root, context)
  expect(result.status).toBe('committed')
  await expect.poll(async () => (await pool.query("SELECT count(*)::int AS count FROM business.job WHERE state='done'")).rows[0].count, { timeout: 200_000 }).toBe(4)
  const { rows: jobs } = await pool.query('SELECT id,kind,state FROM business.job ORDER BY id')
  expect(jobs.filter(job => job.kind === 'event-archive-candidates')).toHaveLength(2)
  expect(jobs.filter(job => job.kind === 'event-annual-correspondence')).toHaveLength(2)
  expect(jobs.every(job => job.state === 'done')).toBe(true)
  for (const { id } of jobs) {
    await assertContext(id, context.requestId)
    expect(JSON.stringify((await applicationLogs().list({ taskId: id })).rows)).not.toContain('PRIVATE_CHAIN_BODY')
  }
  expect(applicationLogs().status()).toMatchObject({ overflow: 0, dropped: 0, writeUnknown: 0, drainFailures: 0, queuedEntries: 0, inFlightEntries: 0 })
  expect(applicationLogs().status().coalesced).toBeGreaterThan(0)
}, 230_000)
