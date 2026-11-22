import { postgresRuntimeFixture } from '../../support/postgres-fixture.mjs'
import { closePostgresDirectoryDb, usePostgresDirectoryDb } from '../../../db/postgresql/client'
import { job } from '../../../db/postgresql/job-tables'
import type { JobState } from '../../../layers/core/lib/job'
import { observeJobSelects } from './fixtures/query-observation'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp, createRouter, toNodeListener, getQuery, getRouterParam, defineEventHandler, createError } from 'h3'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { newJobId } from '../../../layers/core/lib/job'

const dir = mkdtempSync(join(tmpdir(), 'jobs-summary-http-'))
let runtime: Awaited<ReturnType<typeof postgresRuntimeFixture>>
let server: ReturnType<typeof createServer>, base: string
const id = newJobId()
const result = { files: [{ path: 'jxj/synthetic.pdf', pages: [{ page: 2, text: 'second' }, { page: 1, text: 'first' }] }], raw: 'x'.repeat(1024 * 1024) }
async function seed(
  id: string, kind: string, params: Record<string, unknown>,
  state: JobState = 'queued', progress = { done: 0, total: 1 }, result?: unknown, error?: string,
) {
  const now = new Date().toISOString()
  await usePostgresDirectoryDb().insert(job).values({
    id, kind, state, params: JSON.stringify(params), progress: JSON.stringify(progress), result: JSON.stringify(result),
    error, createdAt: now, startedAt: state === 'running' ? now : null,
    finishedAt: state !== 'queued' && state !== 'running' ? now : null,
  })
}
beforeAll(async () => {
  runtime = await postgresRuntimeFixture({ dir })
  vi.stubEnv('NUXT_POSTGRES_DIRECTORY_URL', runtime.url)
  vi.stubEnv('NUXT_DB_READONLY', '0')
  vi.stubGlobal('defineEventHandler', defineEventHandler)
  vi.stubGlobal('getQuery', getQuery)
  vi.stubGlobal('getRouterParam', getRouterParam)
  vi.stubGlobal('createError', createError)
  vi.stubGlobal('useRuntimeConfig', () => ({ filesDir: dir }))
  await seed(id, 'ocr', { files: ['jxj/synthetic.pdf'] }, 'done', { done: 2, total: 3 }, result)
  const list = (await import('../../../layers/core/server/api/jobs/index.get')).default
  const detail = (await import('../../../layers/core/server/api/jobs/[id].get')).default
  const router = createRouter().get('/api/jobs', list).get('/api/jobs/:id', detail)
  server = createServer(toNodeListener(createApp({ debug: false }).use(router)))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})
afterAll(async () => {
  if (server) await new Promise<void>(resolve => server.close(() => resolve()))
  await closePostgresDirectoryDb()
  runtime?.close()
  vi.unstubAllGlobals(); vi.unstubAllEnvs()
  rmSync(dir, { recursive: true, force: true })
})

it('summary list excludes heavy bodies while default list and ID detail retain the complete ordered result', async () => {
  const response = await fetch(`${base}/api/jobs?view=summary&kind=ocr&limit=1`)
  expect(response.status).toBe(200)
  const text = await response.text()
  const summary = JSON.parse(text)
  expect(Object.keys(summary.rows[0]).sort()).not.toContain('result')
  expect(summary).toEqual({ total: 1, rows: [{
    id, kind: 'ocr', state: 'done', progress: { done: 2, total: 3 }, percent: 66,
    error: null, createdAt: expect.any(String), startedAt: null, finishedAt: expect.any(String),
    resultSummary: { available: true }, detailUrl: `/api/jobs/${id}`, capabilities: { cancel: false },
  }] })
  expect(Buffer.byteLength(text)).toBeLessThan(2048)
  const legacy = await (await fetch(`${base}/api/jobs?kind=ocr&limit=1`)).json()
  expect(legacy.rows[0]).toMatchObject({ id, params: { files: ['jxj/synthetic.pdf'] }, result })
  const detail = await (await fetch(`${base}${summary.rows[0].detailUrl}`)).json()
  expect(detail).toEqual(legacy.rows[0])
  expect(await (await fetch(`${base}${summary.rows[0].detailUrl}`)).json()).toEqual(detail)
})

it('summary polling reads only projected metadata and preserves every state and partial result presence', async () => {
  const ids: string[] = []
  for (const state of ['queued', 'running', 'done', 'failed', 'cancelled'] as const) {
    const jobId = newJobId()
    ids.push(jobId)
    const details = state === 'running' ? { checkpoint: ['part-one'] } : state === 'queued' || state === 'done' ? null : { completed: ['part-one'] }
    await seed(jobId, 'summary-states', { large: 'p'.repeat(1024 * 1024) }, state, { done: 1, total: 3 },
      details, state === 'failed' || state === 'cancelled' ? 'synthetic failure' : undefined)
    const observed = observeJobSelects()
    try {
      const response = await fetch(`${base}/api/jobs/${jobId}?view=summary`)
      expect(response.status).toBe(200)
      const body = await response.json()
      expect(Object.keys(body)).not.toContain('params')
      expect(Object.keys(body)).not.toContain('result')
      expect(body).toMatchObject({ id: jobId, state, progress: { done: 1, total: 3 }, percent: 33,
        resultSummary: { available: state === 'running' || state === 'failed' || state === 'cancelled' },
        error: state === 'failed' || state === 'cancelled' ? '任务有错误，请读取详情' : null,
        capabilities: { cancel: state === 'queued' || state === 'running' } })
      expect(observed.queries).toHaveLength(1)
      expect(observed.queries[0]!.fields).toHaveLength(10)
      expect(observed.queries[0]!.fields.slice(0, 7)).toEqual([
        'id', 'kind', 'state', 'progress', 'created_at', 'started_at', 'finished_at',
      ])
      expect(observed.queries[0]!.bytes).toBeLessThan(2048)
    } finally { observed.close() }
  }
  const list = await (await fetch(`${base}/api/jobs?view=summary&kind=summary-states&state=failed,cancelled&limit=1`)).json()
  expect(list.total).toBe(2)
  expect(list.rows).toHaveLength(1)
  expect(list.rows[0].id).toBe(ids[4])
  const active = await (await fetch(`${base}/api/jobs?view=summary&kind=summary-states&state=queued,running`)).json()
  expect(active.rows.map((row: { state: string }) => row.state).sort()).toEqual(['queued', 'running'])
})

it('summary list keeps legacy filtering limits totals and deterministic tie order without loading bodies', async () => {
  const ids: string[] = []
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-20T00:00:00.000Z'))
  try {
    for (let index = 0; index < 55; index++) {
      const jobId = newJobId(Date.now() + index)
      ids.push(jobId)
      await seed(jobId, 'summary-history', { large: 'p'.repeat(1024) }, 'done', undefined, result)
    }
  } finally { vi.useRealTimers() }
  const observed = observeJobSelects()
  try {
    const response = await fetch(`${base}/api/jobs?view=summary&kind=summary-history&state=done,garbage`)
    const text = await response.text()
    const body = JSON.parse(text)
    expect(response.status).toBe(200)
    expect(body.total).toBe(55)
    expect(body.rows.map((row: { id: string }) => row.id)).toEqual(ids.slice(5).reverse())
    expect(Buffer.byteLength(text)).toBeLessThan(256 * 1024)
    expect(observed.queries).toHaveLength(2)
    expect(observed.queries[0]!.sql).toContain('count(*)')
    expect(observed.queries[1]!.fields).not.toContain('params')
    expect(observed.queries[1]!.fields).not.toContain('result')
    expect(observed.queries[1]!.bytes).toBeLessThan(256 * 1024)
  } finally { observed.close() }
  for (const [query, length] of [['limit=1', 1], ['limit=999', 55], ['limit=0', 50], ['limit=no', 50], ['state=unknown', 50]] as const) {
    const body = await (await fetch(`${base}/api/jobs?view=summary&kind=summary-history&${query}`)).json()
    expect(body.total).toBe(55)
    expect(body.rows).toHaveLength(length)
  }
  expect(await (await fetch(`${base}/api/jobs?view=summary&kind=unknown`)).json()).toEqual({ rows: [], total: 0 })
})

it('read views reject unsupported selectors while full defaults and malformed or missing ID statuses remain explicit', async () => {
  for (const suffix of ['', `/${id}`]) {
    for (const view of ['garbage', '', 'summary&view=full']) {
      expect((await fetch(`${base}/api/jobs${suffix}?view=${view}`)).status).toBe(400)
    }
  }
  expect((await fetch(`${base}/api/jobs/bad-id?view=summary`)).status).toBe(400)
  expect((await fetch(`${base}/api/jobs/${newJobId()}?view=summary`)).status).toBe(404)
  const full = await (await fetch(`${base}/api/jobs/${id}?view=full`)).json()
  expect(full.result).toEqual(result)
})

it('full reads redact credentials and host paths while preserving business fields and relative result references', async () => {
  const secrets = ['synthetic-api-134', 'synthetic-mcp-134', 'synthetic-ocr-134', 'synthetic-cookie-134']
  vi.stubEnv('NUXT_API_TOKEN', secrets[0]!)
  vi.stubEnv('NUXT_MCP_TOKEN', secrets[1]!)
  vi.stubEnv('NUXT_OCR_TOKEN', secrets[2]!)
  vi.stubEnv('MIIT_COOKIE', `sid=${secrets[3]}`)
  const jobId = newJobId()
  const references = ['省级/附件.pdf', './jxj/file.pdf', '../结果/文件.json', 'jxj/省级/附件.pdf', 'https://example.invalid/省级/附件.pdf', 'https://example.invalid/artifact?returnTo=/results/附件.json', '/api/files/省级/附件.pdf']
  const sensitiveResult = { references, reference: 'jxj/results/synthetic.json', batchId: 'synthetic-batch', receipt: { written: 3, replayed: true },
    cookie: 'archived-session', token: 'archived-token',
    files: [{ path: '/Users/synthetic/private/result.json', text: 'first page' }, { path: 'jxj/synthetic.pdf', text: 'second page' }],
    message: `echo ${secrets.join(' ')}; token=archived-token; path:/tmp/synthetic/private.png; file:///var/private/synthetic.backup; C:\\private\\result.json`,
    url: 'https://example.invalid/synthetic/result', detailUrl: `/api/jobs/${jobId}`, raw: '{ "synthetic": true }' }
  await seed(jobId, 'summary-secrets', { references, file: 'jxj/synthetic.pdf', apiToken: 'archived-api-token' },
    'failed', undefined, sensitiveResult, `failure ${secrets.join(' ')}; /var/private/synthetic.backup`)
  for (const path of [`/api/jobs/${jobId}`, '/api/jobs?kind=summary-secrets', `/api/jobs/${jobId}?view=summary`, '/api/jobs?view=summary&kind=summary-secrets']) {
    const response = await fetch(`${base}${path}`)
    expect(response.status).toBe(200)
    const text = await response.text()
    for (const secret of [...secrets, 'archived-session', 'archived-token', 'archived-api-token', '/Users/synthetic', '/tmp/synthetic', '/var/private', 'C:\\\\private']) expect(text.includes(secret)).toBe(false)
    if (!path.includes('view=summary')) {
      const body = JSON.parse(text)
      const job = body.rows?.[0] ?? body
      expect(job).toMatchObject({ state: 'failed', params: { references, file: 'jxj/synthetic.pdf' }, result: { references,
        reference: 'jxj/results/synthetic.json', batchId: 'synthetic-batch', receipt: { written: 3, replayed: true },
        files: [{ path: '[REDACTED]', text: 'first page' }, { path: 'jxj/synthetic.pdf', text: 'second page' }],
        url: 'https://example.invalid/synthetic/result', detailUrl: `/api/jobs/${jobId}`, raw: '{ "synthetic": true }',
      } })
      expect(job.error).toContain('failure')
    }
  }
})

it('a fresh read-only connection can list and poll a terminal-only snapshot without recovery writes', async () => {
  const fixture = await postgresRuntimeFixture({ dir })
  const jobId = newJobId()
  await closePostgresDirectoryDb()
  vi.stubEnv('NUXT_POSTGRES_DIRECTORY_URL', fixture.url)
  try {
    await seed(jobId, 'summary-terminal', {}, 'done', undefined, { receipt: 'synthetic-terminal' })
    await closePostgresDirectoryDb()
    vi.stubEnv('NUXT_DB_READONLY', '1')
    const response = await fetch(`${base}/api/jobs?view=summary`)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ total: 1, rows: [{ id: jobId, state: 'done' }] })
    expect(await (await fetch(`${base}/api/jobs/${jobId}?view=summary`)).json()).toMatchObject({ id: jobId, state: 'done', resultSummary: { available: true } })
    expect(await (await fetch(`${base}/api/jobs/${jobId}`)).json()).toMatchObject({ id: jobId, state: 'done', result: { receipt: 'synthetic-terminal' } })
  } finally {
    await closePostgresDirectoryDb()
    fixture.close()
    vi.stubEnv('NUXT_POSTGRES_DIRECTORY_URL', runtime.url)
    vi.stubEnv('NUXT_DB_READONLY', '0')
  }
}, 20_000)
