import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as h3 from 'h3'
import pg from 'pg'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { registerJob } from '../../../layers/core/server/utils/job-runner'
import { closePostgresDirectoryDb } from '../../../db/postgresql/client'
import { initializeDb } from '../../../db/client'

const bin = process.env.TEST_POSTGRES_JOBS_BIN
let dir: string, base: string, server: ReturnType<typeof createServer>, pool: pg.Pool
let started = false
const token = 'fixture-job-api-secret'
const exportKind = 'current-roster-export'
const historicalExports = [
  { key: 'id\0suffix', jsonKey: '"id\\u0000suffix"' },
  { key: 'id\ud800suffix', jsonKey: '"id\\uD800suffix"' },
  { key: 'id\udc00suffix', jsonKey: '"id\\udc00suffix"' },
  { key: 'id\ufffdsuffix', jsonKey: '"id\\uFFFDsuffix"' },
  { key: 'id\\u0000suffix', jsonKey: '"id\\u005cu0000suffix"' },
  { key: 'id\\ud800suffix', jsonKey: '"id\\\\ud800suffix"' },
  { key: 'id😀suffix', jsonKey: '"id\\uD83D\\uDE00suffix"' },
  { key: 'ordinary-history', jsonKey: '"ordinary-history"' },
].map(({ key, jsonKey }, i) => ({
  key, id: '01ARZ3NDEKTSV4RRFFQ69G5FA' + i,
  params: '{"clientRequestId":' + jsonKey + ', "titleCode":"little_giant"}',
}))
const request = (path: string, init?: RequestInit) => fetch(base + path, init)
const submit = (kind: string, params = {}) => request('/api/jobs', {
  method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
  body: JSON.stringify({ kind, params }),
})

beforeAll(async () => {
  if (!bin) return
  dir = mkdtempSync(join(tmpdir(), 'pg-job-'))
  const pgCommand = (name: string, args: string[], input?: string) => execFileSync(join(bin, name), args, { input, stdio: ['pipe', 'pipe', 'pipe'] })
  pgCommand('initdb', ['-D', join(dir, 'data'), '-A', 'trust', '-U', 'fixture', '--no-locale', '-E', 'UTF8'])
  pgCommand('pg_ctl', ['-D', join(dir, 'data'), '-l', join(dir, 'postgres.log'), '-o', `-h '' -k ${dir}`, '-w', 'start'])
  started = true
  const url = 'postgresql://fixture@localhost/postgres?host=' + encodeURIComponent(dir)
  const dbPath = join(dir, 'fixture.sqlite')
  const source = initializeDb({ create: true, dbPath })
  source.$client.prepare('INSERT INTO service_credential (key,value,updated_at) VALUES (?,?,?)')
    .run('core.ocrToken', 'fixture-saved-ocr-secret', '2026-11-20T00:00:00Z')
  const insertExport = source.$client.prepare(
    "INSERT INTO job (id, kind, params, state, created_at) VALUES (?, ?, ?, 'cancelled', '2026-01-01T00:00:00Z')",
  )
  for (const { id, params } of historicalExports) insertExport.run(id, exportKind, params)
  source.$client.close()
  execFileSync(process.execPath, ['upgrade/postgresql/stage-sqlite.mjs', dbPath, 'staged'], {
    env: { ...process.env, PGHOST: dir, PGPORT: '5432', PGDATABASE: 'postgres', PGUSER: 'fixture', PGSQL_BIN: join(bin, 'psql') },
  })
  for (const part of ['enterprise-directory', 'jobs']) {
    pgCommand('psql', ['-Xqw', '-v', 'staging=staged', url, '-f', `upgrade/postgresql/materialize-${part}.sql`])
  }
  pool = new pg.Pool({ connectionString: url })
  vi.stubEnv('NUXT_DB_PATH', join(dir, 'must-not-open.sqlite'))
  vi.stubEnv('NUXT_DB_READONLY', '1')
  vi.stubEnv('NUXT_POSTGRES_DIRECTORY_URL', url)
  vi.stubEnv('NUXT_POSTGRES_DIRECTORY_WRITE', '1')
  vi.stubEnv('NUXT_POSTGRES_JOBS', '1')
  vi.stubGlobal('useRuntimeConfig', () => ({ apiToken: token, filesDir: dir }))
  for (const name of ['defineEventHandler', 'getQuery', 'getRouterParam', 'createError', 'readBody', 'setResponseStatus', 'setHeader', 'getRequestURL', 'getHeader'] as const) {
    vi.stubGlobal(name, h3[name])
  }
  const { createCredentialsHandler, credentialRevealHandler } = await import('../../../layers/core/server/utils/credentials-route')
  const { createPlatformBatchRoute } = await import('../../../layers/sme-roster/server/utils/platform-batch-route')
  const settings = createCredentialsHandler()
  const router = h3.createRouter()
    .get('/api/settings/credentials', settings)
    .patch('/api/settings/credentials', settings)
    .delete('/api/settings/credentials', settings)
    .post('/api/settings/credentials/:key/reveal', credentialRevealHandler)
    .post('/api/platform/batches', createPlatformBatchRoute('submit'))
    .get('/api/platform/batches/:batchId', createPlatformBatchRoute('status'))
    .get('/api/platform/batches/:batchId/items/:itemId', createPlatformBatchRoute('item'))
    .post('/api/platform/batches/:batchId/retry', createPlatformBatchRoute('retry'))
    .get('/api/scheduled-tasks', (await import('../../../layers/core/server/api/scheduled-tasks.get')).default)
    .get('/api/jobs', (await import('../../../layers/core/server/api/jobs/index.get')).default)
    .get('/api/jobs/kinds', (await import('../../../layers/core/server/api/jobs/kinds.get')).default)
    .get('/api/jobs/:id', (await import('../../../layers/core/server/api/jobs/[id].get')).default)
    .delete('/api/jobs/:id', (await import('../../../layers/core/server/api/jobs/[id].delete')).default)
    .post('/api/jobs', (await import('../../../layers/core/server/api/jobs/index.post')).default)
    .get('/api/task-center', (await import('../../../layers/core/server/api/task-center/index.get')).default)
    .get('/api/task-center/events', (await import('../../../layers/core/server/api/task-center/events.get')).default)
    .get('/api/task-center/:id', (await import('../../../layers/core/server/api/task-center/[id].get')).default)
    .post('/api/task-center/:id/cancel', (await import('../../../layers/core/server/api/task-center/[id]/cancel.post')).default)
    .post('/api/task-center/:id/retry', (await import('../../../layers/core/server/api/task-center/[id]/retry.post')).default)
  server = createServer(h3.toNodeListener(h3.createApp({ debug: false }).use(router)))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
}, 15_000)

afterAll(async () => {
  try {
    if (server) await new Promise<void>(resolve => server.close(() => resolve()))
    await (await import("../../../layers/core/server/utils/postgres-jobs")).stopPostgresJobs()
    await closePostgresDirectoryDb()
    await pool?.end()
  } finally {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    if (started) execFileSync(join(bin!, 'pg_ctl'), ['-D', join(dir, 'data'), '-m', 'immediate', '-w', 'stop'])
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

it.runIf(!!bin)('uses task storage to enable streaming and signals SQLite clients to keep polling', async () => {
  const events = await request('/api/task-center/events', { signal: AbortSignal.timeout(5_000) })
  expect(events.status).toBe(200)
  const reader = events.body!.pipeThrough(new TextDecoderStream()).getReader()
  try {
    let frames = ''
    while (!frames.includes('event: ready\ndata:\n\n')) {
      const chunk = await reader.read()
      expect(chunk.done).toBe(false)
      frames += chunk.value
    }
  } finally {
    await reader.cancel()
  }
  vi.stubEnv('NUXT_POSTGRES_JOBS', '0')
  try {
    const sqlite = await request('/api/task-center/events')
    expect(sqlite.status).toBe(204)
    expect(await sqlite.text()).toBe('')
  } finally {
    vi.stubEnv('NUXT_POSTGRES_JOBS', '1')
  }
})

it.runIf(!!bin)('submits a registered PostgreSQL handler through the normal API and reads its persisted output', async () => {
  registerJob({
    kind: 'fixture-pg', status: 'ready', summary: 'Fixture job',
    parse: params => ({ ok: true, params }), total: () => 3,
    postgres: {
      async prepare(_tx, params) { return { labelAtSubmission: params.label } },
      async run(ctx, params, inputSnapshot) {
        const { rows } = await ctx.db.execute<{ version: string }>((await import('drizzle-orm')).sql`SELECT current_setting('server_version') AS version`)
        await ctx.progress(1, 3)
        return { result: { version: rows[0]!.version, label: params.label, inputSnapshot }, progress: { done: 2, total: 3 } }
      },
    },
  })

  const response = await submit('fixture-pg', { label: '合成任务' })
  expect(response.status).toBe(202)
  const { jobId } = await response.json()
  expect(response.headers.get('location')).toBe('/api/jobs/' + jobId)
  await expect.poll(async () => (await (await request('/api/jobs/' + jobId)).json()).state).toBe('done')
  const detail = await (await request('/api/jobs/' + jobId)).json()
  expect(detail).toMatchObject({ id: jobId, state: 'done', progress: { done: 2, total: 3 }, percent: 66, result: { label: '合成任务', version: expect.any(String) } })
  expect(detail).not.toHaveProperty('claimToken')
  expect(detail).not.toHaveProperty('inputSnapshot')
  expect(detail.result.inputSnapshot).toEqual({ labelAtSubmission: '合成任务' })
  expect(await (await request('/api/jobs?view=summary&kind=fixture-pg')).json()).toMatchObject({
    total: 1, rows: [{ id: jobId, state: 'done', resultSummary: { available: true } }],
  })
})

it.runIf(!!bin)('a second worker leaves a live claim alone and cancellation works across connections', async () => {
  const { drizzle } = await import('drizzle-orm/node-postgres')
  const { createPostgresJobRunner } = await import('../../../layers/core/server/utils/job-runner-postgres')
  const other = createPostgresJobRunner(drizzle({ client: pool }), dir)
  const wait = Promise.withResolvers<void>()
  const executed: string[] = []
  registerJob({
    kind: 'fixture-blocking', status: 'ready', summary: 'Blocking job',
    parse: params => ({ ok: true, params }), total: () => 4,
    postgres: {
      async run(ctx) {
        executed.push(ctx.jobId)
        await ctx.progress(1, 4)
        await ctx.checkpoint({ completed: ['一'] })
        if (executed.length === 1) await wait.promise
        return { result: { completed: ['一'], observedCancellation: await ctx.cancelled() } }
      },
    },
  })
  const auth = { authorization: 'Bearer ' + token }
  const detail = async (id: string) => (await request('/api/jobs/' + id)).json()
  const first = await (await submit('fixture-blocking')).json()
  try {
    await expect.poll(async () => (await detail(first.jobId)).result).toEqual({ completed: ['一'] })
    const second = await (await submit('fixture-blocking')).json()
    await other.wake()
    expect(await detail(first.jobId)).toMatchObject({ state: 'running', progress: { done: 1, total: 4 } })
    expect(await detail(second.jobId)).toMatchObject({ state: 'queued' })
    const queuedCancel = await request('/api/jobs/' + second.jobId, { method: 'DELETE', headers: auth })
    expect(queuedCancel.status).toBe(200)
    expect(await queuedCancel.json()).toMatchObject({ state: 'cancelled', cancelled: true })
    const runningCancel = await request('/api/task-center/' + first.jobId + '/cancel', { method: 'POST', headers: auth })
    expect(runningCancel.status).toBe(202)
    expect(await runningCancel.json()).toMatchObject({ cancelRequested: true, task: { state: 'running' } })
  } finally {
    wait.resolve()
    await other.stop()
  }
  await expect.poll(async () => (await detail(first.jobId)).state).toBe('cancelled')
  expect(await detail(first.jobId)).toMatchObject({
    progress: { done: 1, total: 4 },
    result: { completed: ['一'], observedCancellation: true },
  })
  expect(executed).toEqual([first.jobId])
})

it.runIf(!!bin)('deduplicates concurrent submissions and enforces capacity without inserting an extra task', async () => {
  const wait = Promise.withResolvers<void>()
  registerJob({
    kind: 'fixture-limited', status: 'ready', summary: 'Limited job', maxPending: 1, deduplicateRequest: true,
    parse: params => ({ ok: true, params }),
    postgres: { async run() { await wait.promise; return { result: { completed: true } } } },
  })
  try {
    const params = { clientRequestId: 'one', mode: 'full' }
    const submissions = await Promise.all([submit('fixture-limited', params), submit('fixture-limited', params)])
    const ids = await Promise.all(submissions.map(async response => {
      expect(response.status).toBe(202)
      return (await response.json()).jobId
    }))
    expect(ids[0]).toBe(ids[1])
    expect((await submit('fixture-limited', { ...params, mode: 'partial' })).status).toBe(409)
    expect((await submit('fixture-limited', { ...params, clientRequestId: 'two' })).status).toBe(429)
    expect(await (await request('/api/jobs?view=summary&kind=fixture-limited')).json()).toMatchObject({ total: 1 })
  } finally {
    wait.resolve()
  }
})

it.runIf(!!bin)('recovers a lost running claim while preserving its checkpoint and executing committed queued work', async () => {
  const { sql } = await import('drizzle-orm')
  const { drizzle } = await import('drizzle-orm/node-postgres')
  const { stagePostgresJob } = await import('../../../layers/core/server/utils/job-runner-postgres')
  const { newJobId } = await import('../../../layers/core/lib/job')
  const db = drizzle({ client: pool })
  const executed: string[] = []
  const wait = Promise.withResolvers<void>()
  registerJob({
    kind: 'fixture-recovery', status: 'ready', summary: 'Recovery job',
    parse: params => ({ ok: true, params }),
    postgres: {
      async run(ctx, params) {
        executed.push(ctx.jobId)
        if (params.interrupt) {
          await ctx.progress(2, 5)
          await ctx.checkpoint({ completed: ['无损证据'] })
          try {
            await new Promise<void>(resolve => ctx.signal.addEventListener('abort', () => resolve(), { once: true }))
          } finally {
            wait.resolve()
          }
          return { result: { stale: true } }
        }
        return { result: { committed: true } }
      },
    },
  })

  const kind = 'fixture-recovery'
  const read = async (id: string) => (await request('/api/jobs/' + id)).json()
  const { jobId: interrupted } = await (await submit(kind, { interrupt: true })).json()
  await expect.poll(async () => (await read(interrupted)).result).toEqual({ completed: ['无损证据'] })
  const rolledBack = newJobId()
  await expect(db.transaction(async tx => {
    await stagePostgresJob(tx, { id: rolledBack, kind, params: {} })
    throw new Error('rollback fixture')
  })).rejects.toThrow('rollback fixture')
  expect((await request('/api/jobs/' + rolledBack)).status).toBe(404)
  const queued = newJobId()
  await db.transaction(tx => stagePostgresJob(tx, { id: queued, kind, params: {} }))
  expect(await read(queued)).toMatchObject({ state: 'queued' })

  const { rows } = await db.execute<{ terminated: boolean }>(sql`
    SELECT pg_terminate_backend(pid) AS terminated
    FROM pg_locks WHERE locktype = 'advisory' AND granted AND objsubid = 2`)
  expect(rows).toEqual([{ terminated: true }])
  await wait.promise
  await expect.poll(async () => (await read(interrupted)).state).toBe('failed')
  expect(await read(interrupted)).toMatchObject({
    progress: { done: 2, total: 5 }, result: { completed: ['无损证据'] }, error: expect.stringContaining('服务重启'),
  })
  await expect.poll(async () => (await read(queued)).state).toBe('done')
  expect(await read(queued)).toMatchObject({ result: { committed: true } })
  expect(executed).toEqual([interrupted, queued])
})

it.runIf(!!bin)('rejects invalid completion while keeping the last checkpoint and truthful progress', async () => {
  registerJob({
    kind: 'fixture-invalid', status: 'ready', summary: 'Invalid output fixture',
    parse: params => ({ ok: true, params }),
    postgres: {
      async run(ctx) {
        await ctx.progress(1, 3)
        await ctx.checkpoint({ attempt: 1 })
        return { result: { cannotEncode: 1n }, progress: { done: 3, total: 3 } }
      },
    },
  })
  const { jobId } = await (await submit('fixture-invalid')).json()
  const read = async () => (await request('/api/jobs/' + jobId)).json()
  await expect.poll(async () => (await read()).state).toBe('failed')
  expect(await read()).toMatchObject({ result: { attempt: 1 }, progress: { done: 1, total: 3 } })
})

it.runIf(!!bin)('uses the PostgreSQL capability catalog and keeps private task data off public responses', async () => {
  registerJob({
    kind: 'fixture-private', status: 'ready', summary: 'Private output fixture',
    parse: () => ({ ok: false, message: 'SQLite parser must not run' }),
    postgres: {
      parse: params => ({ ok: true, params }),
      async run() {
        return { result: {
          label: 'safe value', apiToken: token, pathname: '/private/example.xlsx',
          observation: 'Bearer ' + token, nested: '{"password":"embedded-secret"}',
          note: 'Saved credential fixture-saved-ocr-secret',
        } }
      },
    },
  })
  registerJob({
    kind: 'fixture-sqlite-only', status: 'ready', summary: 'SQLite handler fixture',
    parse: () => ({ ok: true, params: {} }),
    async run() { return { result: null } },
  })
  const kinds = await (await request('/api/jobs/kinds')).json()
  expect(kinds.kinds).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: 'render-pages', status: 'ready' }),
    expect.objectContaining({ kind: 'reconcile', status: 'ready' }),
    expect.objectContaining({ kind: 'fixture-sqlite-only', status: 'todo' }),
    expect.objectContaining({ kind: 'fixture-private', status: 'ready' }),
  ]))
  expect((await submit('fixture-sqlite-only')).status).toBe(501)
  const response = await submit('fixture-private')
  expect(response.status).toBe(202)
  const { jobId } = await response.json()
  const taskUrl = '/api/task-center/' + jobId
  await expect.poll(async () => (await (await request(taskUrl)).json()).state).toBe('done')
  const listResponse = await request('/api/task-center?state=done&pageSize=2')
  expect(listResponse.headers.get('cache-control')).toBe('no-store')
  const list = await listResponse.json()
  expect(list.rows).toHaveLength(2)
  expect(list.rows[0]).toMatchObject({ id: jobId, module: null, capabilities: { retry: false, cancel: false } })
  expect(list.rows[0]).not.toHaveProperty('result')
  expect((await request(taskUrl + '/cancel', { method: 'POST' })).status).toBe(401)
  expect((await request(taskUrl + '/retry', { method: 'POST', headers: { authorization: 'Bearer ' + token } })).status).toBe(409)
  for (const path of ['/api/jobs/' + jobId, '/api/jobs?kind=fixture-private']) {
    const text = await (await request(path)).text()
    expect(text).toContain('safe value')
    expect(text).not.toMatch(/fixture-job-api-secret|\/private\/example.xlsx|embedded-secret|fixture-saved-ocr-secret/)
  }
})

it.runIf(!!bin)('reads migrated settings and rolls back a failed mixed credential update', async () => {
  const route = '/api/settings/credentials'
  const payload = (method: string, body: unknown) => ({
    method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  const initial = await request(route)
  expect(initial.status).toBe(200)
  expect(initial.headers.get('cache-control')).toBe('no-store')
  expect(await initial.json()).toMatchObject({
    'core.ocrToken': { configured: true, hasSaved: true, source: 'saved', masked: 'fix********ret', updatedAt: '2026-11-20T00:00:00Z' },
  })
  const reveal = async (key: string) => (await request(route + '/' + key + '/reveal', { method: 'POST' })).json()
  expect(await reveal('core.ocrToken')).toEqual({ value: 'fixture-saved-ocr-secret' })
  await pool.query("ALTER TABLE business.service_credential ADD CHECK (value <> 'session=fixture-rejected')")
  const failed = await request(route, payload('PATCH', {
    'core.ocrToken': 'fixture-rolled-back', 'sme-roster.miitCookie': 'session=fixture-rejected',
  }))
  expect(failed.status).toBe(503)
  expect(await failed.text()).not.toMatch(/fixture-|service_credential/)
  expect(await reveal('core.ocrToken')).toEqual({ value: 'fixture-saved-ocr-secret' })
  const saved = await request(route, payload('PATCH', { 'sme-roster.miitCookie': 'session=fixture-metadata-cookie' }))
  expect(saved.status).toBe(200)
  const { resolveRuntimeCredential } = await import('../../../layers/core/server/utils/credential-state-postgres')
  expect((await resolveRuntimeCredential('sme-roster.miitCookie')).value).toBe('session=fixture-metadata-cookie')
  expect(await reveal('core.ocrToken')).toEqual({ value: 'fixture-saved-ocr-secret' })
  vi.stubEnv('MIIT_COOKIE', 'session=fixture-env-cookie')
  try {
    const removed = await request(route, payload('DELETE', { key: 'sme-roster.miitCookie' }))
    expect(removed.status).toBe(200)
    expect(await removed.json()).toMatchObject({ 'sme-roster.miitCookie': { source: 'MIIT_COOKIE', hasSaved: false } })
    expect((await resolveRuntimeCredential('sme-roster.miitCookie')).value).toBe('session=fixture-env-cookie')
  } finally { vi.stubEnv('MIIT_COOKIE', undefined) }
})

it.runIf(!!bin)('retries only an unfinished platform page in PostgreSQL and preserves prior observations', async () => {
  const credential = 'session=fixture-platform-cookie'
  await pool.query(`INSERT INTO business.service_credential (key,value,updated_at)
    VALUES ('sme-roster.miitCookie',$1,'2026-11-20T00:00:00Z')`, [credential])
  const networkFetch = globalThis.fetch
  const pages: number[] = []
  let rejectPageTwo = true
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    if (url.startsWith(base)) return networkFetch(url, init)
    expect(url).toMatch(/^https:\/\/zjtx\.miit\.gov\.cn\/zxqy\//)
    expect(new Headers(init?.headers).get('cookie')).toBe(credential)
    const page = Number(new URLSearchParams(init?.body as string).get('pageNum'))
    pages.push(page)
    if (page === 2 && rejectPageTwo) return new Response('', { status: 503 })
    return Response.json({ zrarData: { grid: { applyGrid: { pageSet: [{ qymc: '合成企业', relation: String(page) }], page, maxCount: 2 } } } })
  })
  const post = (path: string, body: unknown) => request(path, { method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token }, body: JSON.stringify(body) })
  try {
    const response = await post('/api/platform/batches', { items: [{ query: { source: 'queryList', name: '合成', pageSize: 1 } }] })
    expect(response.status).toBe(202)
    const { batchId, itemIds } = await response.json()
    const path = '/api/platform/batches/' + batchId
    const status = async () => (await request(path)).json()
    await expect.poll(async () => (await status()).state).toBe('failed')
    const prior = await status()
    expect(prior).toMatchObject({ attempt: 1, items: [{ itemId: itemIds[0], unfinished: [{ page: 2 }] }] })
    expect(prior.items[0].segments[0].rows).toEqual([{ qymc: '合成企业', relation: '1' }])
    expect(pages).toEqual([1, 2])
    const taskPath = '/api/task-center/' + batchId
    const task = await (await request(taskPath)).json()
    expect(task).toMatchObject({
      state: 'failed', outcome: { attempt: 1, unfinished: 1 },
      items: [{ id: itemIds[0], positions: [{ source: 'queryList', page: 2 }] }],
    })
    expect(JSON.stringify(task)).not.toContain('合成企业')
    const list = await (await request('/api/task-center?tab=sme-roster&group=platform&state=failed')).json()
    expect(list.rows).toContainEqual(expect.objectContaining({ id: batchId, outcome: task.outcome }))
    expect((await request(taskPath + '/retry', { method: 'POST' })).status).toBe(401)
    rejectPageTwo = false
    const retry = await post(taskPath + '/retry', {})
    expect(retry.status).toBe(202)
    expect(await retry.json()).toMatchObject({ batchId, itemIds })
    await expect.poll(async () => (await status()).state).toBe('done')
    expect(pages).toEqual([1, 2, 2])
    const item = await (await request(path + '/items/' + itemIds[0])).json()
    expect(item.segments[0]).toEqual(prior.items[0].segments[0])
    expect(item.segments[1].rows).toEqual([{ qymc: '合成企业', relation: '2' }])
    expect(item.unfinished).toEqual([])
    const persisted = await pool.query('SELECT params,result,input_snapshot FROM business.job WHERE id=$1', [batchId])
    expect(JSON.stringify(persisted.rows[0])).not.toContain(credential)
    expect((await post(path + '/retry', { itemIds })).status).toBe(409)
  } finally {
    vi.stubGlobal('fetch', networkFetch)
    await pool.query("DELETE FROM business.service_credential WHERE key='sme-roster.miitCookie'")
  }
})

it.runIf(!!bin)('skips a row locked by a transaction and picks it up after the lock is released', async () => {
  const { drizzle } = await import('drizzle-orm/node-postgres')
  const { stagePostgresJob } = await import('../../../layers/core/server/utils/job-runner-postgres')
  const { newJobId } = await import('../../../layers/core/lib/job')
  const db = drizzle({ client: pool })
  const wait = Promise.withResolvers<void>()
  registerJob({
    kind: 'fixture-locked-row', status: 'ready', summary: 'Locked queue fixture',
    parse: params => ({ ok: true, params }),
    postgres: {
      async run(ctx, params) {
        if (params.block) {
          await ctx.checkpoint({ waiting: true })
          await wait.promise
        }
        return { result: { label: params.label ?? 'gate' } }
      },
    },
  })
  const kind = 'fixture-locked-row'
  const { jobId: gate } = await (await submit(kind, { block: true })).json()
  const read = async (id: string) => (await request('/api/jobs/' + id)).json()
  const first = newJobId(1)
  const second = newJobId(2)
  const client = await pool.connect()
  try {
    await expect.poll(async () => (await read(gate)).result).toEqual({ waiting: true })
    await db.transaction(async tx => {
      await stagePostgresJob(tx, { id: first, kind, params: { label: 'first' } })
      await stagePostgresJob(tx, { id: second, kind, params: { label: 'second' } })
    })
    await client.query('BEGIN')
    await client.query('SELECT id FROM business.job WHERE id=$1 FOR UPDATE', [first])
    wait.resolve()
    await expect.poll(async () => (await read(second)).state).toBe('done')
    expect(await read(first)).toMatchObject({ state: 'queued' })
  } finally {
    wait.resolve()
    await client.query('ROLLBACK')
    client.release()
  }
  await expect.poll(async () => (await read(first)).state).toBe('done')
  expect(await read(first)).toMatchObject({ result: { label: 'first' } })
})

it.runIf(!!bin)('filters roster exports by title before counting and reports progress only in the workbook phase', async () => {
  vi.stubEnv('NUXT_POSTGRES_ROSTER_READ', '1')
  const { newJobId } = await import('../../../layers/core/lib/job')
  const kind = 'current-roster-export'
  const growing = newJobId(), preparing = newJobId(), otherTitle = newJobId(), otherKind = newJobId()
  for (const [id, jobKind, title, phase] of [
    [growing, kind, 'little_giant', 'workbook'],
    [preparing, kind, 'little_giant', 'snapshot'],
    [otherTitle, kind, 'innovative_sme', 'workbook'],
    [otherKind, 'other-kind', 'little_giant', 'snapshot'],
  ]) {
    await pool.query(`INSERT INTO business.job (id, kind, state, params, progress, result, created_at)
      VALUES ($1, $2, 'running', $3, '{"done":1,"total":4}', $4, $5)`,
    [id, jobKind, JSON.stringify({ titleCode: title }), JSON.stringify({ phase }), '2026-01-01T00:00:00Z'])
  }
  const response = await request('/api/task-center?tab=sme-roster&group=export&titleCode=little_giant&state=running&pageSize=1')
  expect(response.status).toBe(200)
  const page = await response.json()
  expect(page).toMatchObject({ total: 2, counts: { all: 2, 'sme-roster': 2 }, exportReady: true })
  expect(page.rows).toHaveLength(1)
  expect([growing, preparing]).toContain(page.rows[0].id)
  for (const [id, total, stage] of [[growing, 4, '生成工作簿'], [preparing, null, '固定数据快照']] as const) {
    const detail = await request('/api/task-center/' + id, { headers: { authorization: 'Bearer ' + token } })
    expect(detail.status).toBe(200)
    expect(await detail.json()).toMatchObject({
      label: '专精特新“小巨人”导出',
      progress: { done: 1, total, unit: '家企业', stage },
      capabilities: { cancel: true, retry: false },
    })
  }
  const summary = await (await request('/api/jobs?view=summary&kind=current-roster-export')).json()
  expect(summary.rows).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: growing, percent: 25 }),
    expect.objectContaining({ id: preparing, percent: null }),
  ]))
  expect((await (await request('/api/jobs/' + otherKind)).json()).percent).toBe(25)
  expect((await submit(kind, { clientRequestId: 'regenerate-running', titleCode: 'little_giant', regenerateOf: growing })).status).toBe(409)
})

it.runIf(!!bin)('keeps authorized export downloads available in readonly task summaries and disables mutations', async () => {
  const { newJobId } = await import('../../../layers/core/lib/job')
  const id = newJobId()
  const bytes = Buffer.from('fixture workbook')
  const artifact = {
    id,
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    generatedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }
  const artifactDir = join(dir, 'must-not-open.sqlite.exports')
  mkdirSync(artifactDir, { recursive: true })
  writeFileSync(join(artifactDir, id + '.xlsx'), bytes)
  await pool.query(`INSERT INTO business.job (id, kind, state, params, result, created_at, finished_at)
    VALUES ($1, 'current-roster-export', 'done', '{"titleCode":"little_giant"}', $2, $3, $3)`,
  [id, JSON.stringify({ artifact }), artifact.generatedAt])

  const auth = { authorization: 'Bearer ' + token }
  const detail = '/api/task-center/' + id
  const list = '/api/task-center?tab=sme-roster&group=export&state=done'
  expect(await (await request(detail, { headers: auth })).json()).toMatchObject({
    id, export: { canDownload: true, canRegenerate: true },
  })

  vi.stubEnv('NUXT_DB_MODE', 'postgresql')
  vi.stubEnv('NUXT_POSTGRES_JOBS', '0')
  try {
    const expected = {
      id, export: { canDownload: true, canRegenerate: false, artifact: { availability: 'available' } },
      capabilities: { cancel: false, retry: false, retryItemIds: [], reason: '当前任务中心只读。' },
    }
    expect(await (await request(detail, { headers: auth })).json()).toMatchObject(expected)
    const page = await (await request(list, { headers: auth })).json()
    expect(page).toMatchObject({ authorized: false, exportReady: false, total: 1 })
    expect(page.rows[0]).toMatchObject(expected)
    expect(await (await request(detail)).json()).toMatchObject({
      id, export: { canDownload: false, canRegenerate: false },
    })
  } finally {
    vi.stubEnv('NUXT_POSTGRES_JOBS', '1')
    vi.stubEnv('NUXT_DB_MODE', undefined)
  }
})

it.runIf(!!bin)('cleans expired roster workbooks from PostgreSQL task records with idempotent submission', async () => {
  const { newJobId } = await import('../../../layers/core/lib/job')
  const id = newJobId()
  const expiresAt = '2000-01-01T00:00:00Z'
  const artifactDir = join(dir, 'must-not-open.sqlite.exports')
  mkdirSync(artifactDir, { recursive: true })
  const workbook = join(artifactDir, id + '.xlsx')
  writeFileSync(workbook, 'expired fixture workbook')
  await pool.query(`INSERT INTO business.job (id, kind, state, params, result, created_at, finished_at)
    VALUES ($1, 'current-roster-export', 'done', '{"titleCode":"little_giant"}', $2, $3, $3)`,
  [id, JSON.stringify({ artifact: { id, expiresAt } }), expiresAt])

  const kind = 'roster_export_cleanup'
  const params = { clientRequestId: 'fixture-expired-roster-cleanup' }
  const accepted = await submit(kind, params)
  expect(accepted.status).toBe(202)
  const { jobId } = await accepted.json()
  await expect.poll(async () => (await (await request('/api/jobs/' + jobId)).json()).state).toBe('done')
  expect(await (await request('/api/jobs/' + jobId)).json()).toMatchObject({
    kind, result: { removed: 1, failed: 0 },
  })
  expect(existsSync(workbook)).toBe(false)
  expect(await pool.query('SELECT state FROM business.job WHERE id = $1', [id]))
    .toMatchObject({ rows: [{ state: 'done' }] })
  expect(await (await submit(kind, params)).json()).toMatchObject({ jobId })
})

it.runIf(!!bin)('preserves historical export request identifiers across migration and HTTP replay', async () => {
  vi.stubEnv('NUXT_POSTGRES_ROSTER_READ', '1')
  try {
    const migrated = await pool.query('SELECT id, params FROM business.job WHERE id = ANY($1) ORDER BY id',
      [historicalExports.map(row => row.id)])
    expect(migrated.rows).toEqual(historicalExports.map(({ id, params }) => ({ id, params })))

    for (const { id, key } of historicalExports) {
      const replay = await submit(exportKind, { clientRequestId: key, titleCode: 'little_giant' })
      expect(replay.status).toBe(202)
      expect(await replay.json()).toMatchObject({ jobId: id, state: 'cancelled' })
      const conflict = await submit(exportKind, { clientRequestId: key, titleCode: 'innovative_sme' })
      expect(conflict.status).toBe(409)
      await expect(pool.query(
        "INSERT INTO business.job (id, kind, params, created_at) VALUES ('fixture-duplicate-export', $1, $2, now()::text)",
        [exportKind, JSON.stringify({ clientRequestId: key, titleCode: 'little_giant' })],
      )).rejects.toMatchObject({ code: '23505' })
    }

    const page = await request('/api/task-center?tab=sme-roster&group=export&titleCode=little_giant&state=cancelled', {
      headers: { authorization: 'Bearer ' + token },
    })
    expect(page.status).toBe(200)
    const expectedSummary = {
      label: '专精特新“小巨人”导出',
      module: 'sme-roster',
      progress: { done: 0, total: null, unit: '家企业', stage: '执行结束' },
      capabilities: { cancel: false, retry: false, reason: '导出不重放任务；请显式重新生成，新任务保留原任务关联。' },
      export: { titleCode: 'little_giant', canRegenerate: true },
    }
    const { total, rows } = await page.json()
    expect(total).toBe(historicalExports.length)
    expect(rows.map((row: { id: string }) => row.id).sort()).toEqual(historicalExports.map(({ id }) => id))
    for (const row of rows) {
      expect(row).toMatchObject(expectedSummary)
      expect(row).not.toHaveProperty('items')
    }
    const detail = await request('/api/task-center/' + historicalExports[0]!.id)
    expect(detail.status).toBe(200)
    expect(await detail.json()).toMatchObject({
      ...expectedSummary,
      items: [],
      capabilities: { cancel: false, retry: false, reason: '当前请求仅可查看任务。' },
      export: { titleCode: 'little_giant', canRegenerate: false, canDownload: false },
    })
  } finally {
    vi.stubEnv('NUXT_POSTGRES_ROSTER_READ', undefined)
  }
})

it.runIf(!!bin)('deduplicates newly submitted Unicode edge-case request identifiers independently', async () => {
  const kind = 'fixture-request-ids'
  registerJob({
    kind, status: 'ready', summary: 'Fixture request identifiers', deduplicateRequest: true,
    parse: params => ({ ok: true, params }),
    postgres: { async run() { return { result: { completed: true } } } },
  })
  const ids = new Set<string>()
  for (const clientRequestId of ['id\0suffix', 'id\ud800suffix', 'id\ufffdsuffix', 'id\\u0000suffix']) {
    const responses = await Promise.all([submit(kind, { clientRequestId }), submit(kind, { clientRequestId })])
    for (const response of responses) expect(response.status).toBe(202)
    const [first, replay] = await Promise.all(responses.map(response => response.json()))
    expect(replay.jobId).toBe(first.jobId)
    expect(ids.has(first.jobId)).toBe(false)
    ids.add(first.jobId)
    expect(await (await request('/api/jobs/' + first.jobId)).json()).toMatchObject({ params: { clientRequestId } })
  }
  expect(await (await request('/api/jobs?view=summary&kind=' + kind)).json()).toMatchObject({ total: 4 })
})

it.runIf(!!bin)('reports one run per scheduled hour and keeps the last result visible in read-only mode', async () => {
  const { dispatchScheduledJob } = await import('../../../server/scheduling/scheduled-jobs')
  const kind = 'roster_export_cleanup'
  const at = new Date('2026-01-08T03:00:00Z')
  const schedules = async () => (await request('/api/scheduled-tasks')).json()
  const before = await schedules()
  expect(before).toMatchObject({ enabled: true, items: expect.arrayContaining([
    { id: kind, label: '清理过期名录导出文件', frequency: '每小时整点', nextRunAt: expect.any(Number), lastRun: null },
  ]) })

  const [first, concurrent] = await Promise.all([
    dispatchScheduledJob(kind, dir, at),
    dispatchScheduledJob(kind, dir, new Date(at.getTime() + 2000)),
  ])
  expect(first.jobId).toEqual(expect.any(String))
  expect(concurrent).toEqual(first)
  await expect.poll(async () => (await schedules()).items.find((item: { id: string }) => item.id === kind)?.lastRun)
    .toMatchObject({ id: first.jobId, status: 'done', finishedAt: expect.any(Number) })
  vi.stubEnv('NUXT_DB_MODE', 'postgresql')
  vi.stubEnv('NUXT_POSTGRES_JOBS', '0')
  try {
    expect(await dispatchScheduledJob(kind, dir, new Date(at.getTime() + 3600000))).toEqual({ skipped: true })
    const readOnly = await schedules()
    expect(readOnly.enabled).toBe(false)
    expect(readOnly.items.find((item: { id: string }) => item.id === kind))
      .toMatchObject({ nextRunAt: null, lastRun: { id: first.jobId } })
  } finally {
    vi.stubEnv('NUXT_POSTGRES_JOBS', '1')
    vi.stubEnv('NUXT_DB_MODE', undefined)
  }
})
