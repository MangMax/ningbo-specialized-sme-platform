import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as h3 from 'h3'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { postgresRuntimeFixture } from '../../support/postgres-fixture.mjs'
import { closePostgresDirectoryDb } from '../../../db/postgresql/client'
import { clearJobSpecs, registerJob } from '../../../layers/core/server/utils/job-spec-registry'
import { stopPostgresJobs } from '../../../layers/core/server/utils/postgres-jobs'
import type { PostgresJobSpec } from '../../../layers/core/server/utils/job-runner-postgres'
import { currentRosterExportSpec } from '../../../layers/sme-roster/server/utils/jobs/current-roster-export'
import { observeJobSelects } from './fixtures/query-observation'

const dir = mkdtempSync(join(tmpdir(), 'jobs-legacy-result-'))
let runtime: Awaited<ReturnType<typeof postgresRuntimeFixture>>
let server: ReturnType<typeof createServer>, base: string
let release: (() => void) | undefined
beforeAll(async () => { runtime = await postgresRuntimeFixture({ dir }) })
afterAll(async () => {
  runtime?.close()
  rmSync(dir, { recursive: true, force: true })
})
beforeEach(async () => {
  runtime.psql(['-c', 'TRUNCATE business.job CASCADE'])
  vi.stubEnv('NUXT_POSTGRES_DIRECTORY_URL', runtime.url)
  vi.stubEnv('NUXT_DB_READONLY', '0')
  clearJobSpecs()
  for (const [key, value] of Object.entries(h3)) vi.stubGlobal(key, value)
  vi.stubGlobal('useRuntimeConfig', () => ({ apiToken: 'synthetic-a9bc-key', filesDir: dir, browserTasksEnabled: false }))
  const list = (await import('../../../layers/core/server/api/jobs/index.get')).default
  const detail = (await import('../../../layers/core/server/api/jobs/[id].get')).default
  const submit = (await import('../../../layers/core/server/api/jobs/index.post')).default
  const cancel = (await import('../../../layers/core/server/api/jobs/[id].delete')).default
  const artifact = (await import('../../../layers/sme-roster/server/api/job-artifacts/[id].get')).default
  const tasks = (await import('../../../layers/core/server/api/task-center/index.get')).default
  const task = (await import('../../../layers/core/server/api/task-center/[id].get')).default
  const taskCancel = (await import('../../../layers/core/server/api/task-center/[id]/cancel.post')).default
  const router = h3.createRouter().get('/api/jobs', list).post('/api/jobs', submit)
    .get('/api/jobs/:id', detail).delete('/api/jobs/:id', cancel)
    .get('/api/job-artifacts/:id', artifact).get('/api/task-center', tasks)
    .get('/api/task-center/:id', task).post('/api/task-center/:id/cancel', taskCancel)
  server = createServer(h3.toNodeListener(h3.createApp({ debug: false }).use(router)))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})
afterEach(async () => {
  release?.(); release = undefined
  await stopPostgresJobs()
  if (server) await new Promise<void>(resolve => server.close(() => resolve()))
  clearJobSpecs()
  await closePostgresDirectoryDb()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

function registerExecutor(run: PostgresJobSpec['run']) {
  registerJob({
    ...currentRosterExportSpec,
    parse: params => ({ ok: true, params }),
    postgres: {
      ...currentRosterExportSpec.postgres,
      parse: undefined,
      prepare: undefined,
      validateSubmission: undefined,
      run,
    },
  })
}
const headers = { authorization: 'Bearer synthetic-a9bc-key', 'content-type': 'application/json' }
async function submit() {
  const response = await fetch(base + '/api/jobs', { method: 'POST', headers,
    body: JSON.stringify({ kind: 'current-roster-export', params: { titleCode: 'specialized_sme', clientRequestId: 'synthetic-cross-behavior', privateToken: 'stored-secret' } }) })
  expect(response.status).toBe(202)
  return (await response.json()).jobId as string
}

it('composes fresh export artifact availability with full redaction while summary stays body-free', async () => {
  // Public submission persists an executor-produced synthetic receipt. No direct DB seed.
  registerExecutor(async ctx => ({ result: {
      phase: 'complete', reference: 'synthetic/ordered-result.json', token: 'stored-secret',
      hostPath: '/Users/synthetic/private/file.xlsx', rows: [{ id: 2 }, { id: 1 }],
      artifact: { id: ctx.jobId, filename: 'current-specialized_sme.xlsx', size: 7, sha256: 'a'.repeat(64),
        generatedAt: '2026-10-01T00:00:00Z', expiresAt: '2099-10-01T00:00:00Z', downloadUrl: `/api/job-artifacts/${ctx.jobId}` },
  } }))
  const id = await submit()
  await vi.waitFor(async () => {
    const state = await (await fetch(base + '/api/jobs/' + id + '?view=summary')).json()
    expect(state.state).toBe('done')
  })
  const response = await fetch(base + '/api/jobs/' + id)
  expect(response.status).toBe(200)
  const full = await response.json()
  expect(full).toMatchObject({ id, state: 'done', percent: 100,
    params: { privateToken: '[REDACTED]' }, result: { token: '[REDACTED]', hostPath: '[REDACTED]',
      reference: 'synthetic/ordered-result.json', rows: [{ id: 2 }, { id: 1 }], artifact: { availability: 'missing' } } })
  expect((await (await fetch(base + '/api/jobs?kind=current-roster-export')).json()).rows).toEqual([full])
  expect(await (await fetch(base + '/api/jobs/' + id + '?view=full')).json()).toEqual(full)
  const observed = observeJobSelects()
  try {
    const summary = await (await fetch(base + '/api/jobs/' + id + '?view=summary')).json()
    expect(summary).toMatchObject({ id, percent: 100, resultSummary: { available: true }, detailUrl: '/api/jobs/' + id })
    expect(summary).not.toHaveProperty('params'); expect(summary).not.toHaveProperty('result')
    const sql = observed.queries.map(row => row.sql).join('\n')
    expect(sql).not.toMatch(/select \*|select "params"|select "result"|from "credential/)
  } finally { observed.close() }
  for (const suffix of ['?view=summary', '?view=full']) {
    expect((await fetch(base + '/api/job-artifacts/' + id + suffix)).status).toBe(401)
    expect((await fetch(base + '/api/job-artifacts/' + id + suffix, { headers })).status).toBe(404)
    expect((await fetch(base + '/api/jobs/' + id + suffix, { method: 'DELETE' })).status).toBe(401)
  }
})

it('retains unknown export progress in generic summary and task-center without bypassing action authorization', async () => {
  let started!: () => void
  const running = new Promise<void>(resolve => { started = resolve })
  const blocked = new Promise<void>(resolve => { release = resolve })
  registerExecutor(async ctx => {
    await ctx.checkpoint({ phase: 'synthetic-unknown-phase'.repeat(4096), token: 'stored-secret', original: 'body-must-stay-out' })
    started(); await blocked
    return { result: { phase: 'complete' }, cancelled: await ctx.cancelled() }
  })
  const id = await submit(); await running
  const full = await (await fetch(base + '/api/jobs/' + id)).json()
  expect(full.percent).toBeNull()
  const observed = observeJobSelects()
  try {
    for (const path of ['/api/jobs/' + id + '?view=summary', '/api/jobs?kind=current-roster-export&view=summary']) {
      const response = await fetch(base + path); expect(response.status).toBe(200)
      const body = await response.json(), summary = body.rows?.[0] ?? body
      expect(summary).toMatchObject({ id, state: 'running', percent: null, resultSummary: { available: true } })
      expect(summary).not.toHaveProperty('params'); expect(summary).not.toHaveProperty('result')
    }
    // Check the driver response as well as the public summary. The server
    // transfers a bounded phase discriminator even for very large old inputs.
    expect(observed.queries).toHaveLength(3)
    expect(Math.max(...observed.queries.map(row => row.bytes))).toBeLessThan(2048)
  } finally { observed.close() }
  for (const path of ['/api/task-center?view=summary', '/api/task-center/' + id + '?view=summary']) {
    const read = await fetch(base + path); expect(read.headers.get('cache-control')).toBe('no-store')
    const body = await read.json(), task = body.rows?.[0] ?? body
    expect(task).toMatchObject({ id, progress: { total: null }, capabilities: { cancel: false, retry: false } })
    expect(JSON.stringify(body)).not.toMatch(/stored-secret|body-must-stay-out|privateToken/)
    const authorized = await (await fetch(base + path, { headers })).json()
    expect((authorized.rows?.[0] ?? authorized).capabilities.cancel).toBe(true)
  }
  expect((await fetch(base + '/api/task-center/' + id + '/cancel?view=summary', { method: 'POST' })).status).toBe(401)
  const accepted = await fetch(base + '/api/task-center/' + id + '/cancel?view=summary', { method: 'POST', headers })
  expect(accepted.status).toBe(202)
  expect(await accepted.json()).toMatchObject({ cancelRequested: true, task: { state: 'running' } })
})
