import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pg from 'pg'
import { newJobId } from '../../../layers/core/lib/job'
import { closePostgresDirectoryDb, usePostgresDirectoryDb } from '../../../db/postgresql/client'
import { applicationLogs, closeApplicationLogging, initializeWorkerLogging } from '../../../layers/core/lib/logging'
import { registerJob } from '../../../layers/core/server/utils/job-spec-registry'
import { stageJob } from '../../../layers/core/server/utils/job-runner-postgres'
import { getJob } from '../../../layers/core/server/utils/job-store-postgres'
import { startJobs, stopJobs } from '../../../layers/core/server/utils/postgres-jobs'
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
  await stopJobs()
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
  const read = async () => (await getJob(db(), id))?.row
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
  const runner = startJobs(root)!.runner
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
    const { row: pending } = await stageJob(tx, { id: rolledBackId, kind: input.kind, params: { clientRequestId: 'rolled-back' } })
    remember([pending])
    throw new Error('fixture rollback')
  }), context)).rejects.toThrow('fixture rollback')
  expect(await getJob(db(), rolledBackId)).toBeNull()
  await applicationLogs().flush()
  expect((await applicationLogs().list({ taskId: rolledBackId })).rows).toEqual([])
})
it('adopts legacy queued jobs without inventing request identity', async () => {
  const id = newJobId()
  registerJob({
    kind: 'legacy-adopt', status: 'ready', summary: 'synthetic', parse: params => ({ ok: true, params }),
    postgres: { async run(ctx) { expect(ctx.logContext).toEqual({ module: null, taskId: id }); return { result: null } } },
  })
  await db().transaction(tx => stageJob(tx, { id, kind: 'legacy-adopt', params: {} }))
  startJobs(root)
  expect((await terminal(id)).state).toBe('done')
  await applicationLogs().flush()
  const rows = (await applicationLogs().list({ taskId: id })).rows
  expect(rows.map(row => row.operation).sort()).toEqual(['task.finished', 'task.started'])
  expect(rows.every(row => row.requestId === undefined && row.traceId === undefined)).toBe(true)
})
