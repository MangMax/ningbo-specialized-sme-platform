import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp, createRouter, toNodeListener, getQuery, getRouterParam, defineEventHandler, createError } from 'h3'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { useDb } from '../db'
import { newJobId } from '../lib/job'
import { createJob, finishJob, markJobRunning, setJobProgress, setJobResult } from '../server/utils/job-store'
import { ensureJobRunnerReady } from '../server/utils/job-runner'

const dir = mkdtempSync(join(tmpdir(), 'jobs-summary-http-'))
const db = useDb({ dbPath: join(dir, 'test.sqlite') })
let server: ReturnType<typeof createServer>, base: string
const id = newJobId()
const result = { files: [{ path: 'jxj/synthetic.pdf', pages: [{ page: 2, text: 'second' }, { page: 1, text: 'first' }] }], raw: 'x'.repeat(1024 * 1024) }
beforeAll(async () => {
  vi.stubEnv('NUXT_DB_PATH', join(dir, 'test.sqlite'))
  vi.stubGlobal('defineEventHandler', defineEventHandler)
  vi.stubGlobal('getQuery', getQuery)
  vi.stubGlobal('getRouterParam', getRouterParam)
  vi.stubGlobal('createError', createError)
  ensureJobRunnerReady(db)
  createJob(db, { id, kind: 'ocr', params: { files: ['jxj/synthetic.pdf'] }, progress: { done: 0, total: 3 } })
  setJobProgress(db, id, { done: 2, total: 3 })
  finishJob(db, id, { state: 'done', result })
  const list = (await import('../server/api/jobs/index.get')).default
  const detail = (await import('../server/api/jobs/[id].get')).default
  const router = createRouter().get('/api/jobs', list).get('/api/jobs/:id', detail)
  server = createServer(toNodeListener(createApp({ debug: false }).use(router)))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})
afterAll(async () => {
  if (server) await new Promise<void>(resolve => server.close(() => resolve()))
  vi.unstubAllGlobals(); vi.unstubAllEnvs(); db.$client.close()
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
    createJob(db, { id: jobId, kind: 'summary-states', params: { large: 'p'.repeat(1024 * 1024) }, progress: { done: 1, total: 3 } })
    if (state === 'running') {
      markJobRunning(db, jobId)
      setJobResult(db, jobId, { checkpoint: ['part-one'] })
    }
    else if (state !== 'queued') finishJob(db, jobId, { state, result: state === 'done' ? null : { completed: ['part-one'] }, error: state === 'done' ? null : 'synthetic failure' })
    const prepared = vi.spyOn(db.$client, 'prepare')
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
      const queries = prepared.mock.calls.map(([query]) => query)
      expect(queries).toHaveLength(1)
      expect(queries[0]).toContain('select "id", "kind", "state", "progress", "created_at", "started_at", "finished_at", "result" is not null and "result" != \'null\', "error" is not null from "job"')
      expect(queries[0]).not.toContain('"params"')
    } finally { prepared.mockRestore() }
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
      createJob(db, { id: jobId, kind: 'summary-history', params: { large: 'p'.repeat(1024) } })
      finishJob(db, jobId, { state: 'done', result })
    }
  } finally { vi.useRealTimers() }
  const prepared = vi.spyOn(db.$client, 'prepare')
  try {
    const response = await fetch(`${base}/api/jobs?view=summary&kind=summary-history&state=done,garbage`)
    const text = await response.text()
    const body = JSON.parse(text)
    expect(response.status).toBe(200)
    expect(body.total).toBe(55)
    expect(body.rows.map((row: { id: string }) => row.id)).toEqual(ids.slice(5).reverse())
    expect(Buffer.byteLength(text)).toBeLessThan(256 * 1024)
    const queries = prepared.mock.calls.map(([query]) => query)
    expect(queries).toHaveLength(2)
    expect(queries[0]).toContain('count(*)')
    expect(queries[1]).toContain('"result" is not null and "result" != \'null\', "error" is not null')
    expect(queries[1]).not.toContain('"params"')
  } finally { prepared.mockRestore() }
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
  const references = ['省级/附件.pdf', './jxj/file.pdf', '../结果/文件.json', 'jxj/省级/附件.pdf', 'https://example.invalid/省级/附件.pdf', '/api/files/省级/附件.pdf']
  const sensitiveResult = { references, reference: 'jxj/results/synthetic.json', batchId: 'synthetic-batch', receipt: { written: 3, replayed: true },
    cookie: 'archived-session', token: 'archived-token',
    files: [{ path: '/Users/synthetic/private/result.json', text: 'first page' }, { path: 'jxj/synthetic.pdf', text: 'second page' }],
    message: `echo ${secrets.join(' ')}; token=archived-token; path:/tmp/synthetic/private.png; file:///var/private/synthetic.sqlite; C:\\private\\result.json`,
    url: 'https://example.invalid/synthetic/result', detailUrl: `/api/jobs/${jobId}`, raw: '{ "synthetic": true }' }
  createJob(db, { id: jobId, kind: 'summary-secrets', params: { references, file: 'jxj/synthetic.pdf', apiToken: 'archived-api-token' } })
  finishJob(db, jobId, { state: 'failed', result: sensitiveResult, error: `failure ${secrets.join(' ')}; /var/private/synthetic.sqlite` })
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
  const path = join(dir, 'terminal.sqlite')
  const fixture = useDb({ dbPath: path })
  const jobId = newJobId()
  createJob(fixture, { id: jobId, kind: 'summary-terminal', params: {} })
  finishJob(fixture, jobId, { state: 'done', result: { receipt: 'synthetic-terminal' } })
  fixture.$client.close()
  vi.stubEnv('NUXT_DB_PATH', path)
  vi.stubEnv('NUXT_DB_READONLY', '1')
  try {
    const response = await fetch(`${base}/api/jobs?view=summary`)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ total: 1, rows: [{ id: jobId, state: 'done' }] })
    expect(await (await fetch(`${base}/api/jobs/${jobId}?view=summary`)).json()).toMatchObject({ id: jobId, state: 'done', resultSummary: { available: true } })
    expect(await (await fetch(`${base}/api/jobs/${jobId}`)).json()).toMatchObject({ id: jobId, state: 'done', result: { receipt: 'synthetic-terminal' } })
  } finally {
    useDb({ dbPath: path, readOnly: true }).$client.close()
    vi.stubEnv('NUXT_DB_PATH', join(dir, 'test.sqlite'))
    vi.stubEnv('NUXT_DB_READONLY', '0')
  }
})
