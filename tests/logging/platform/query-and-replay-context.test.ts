import { afterAll, beforeAll, expect, it } from 'vitest'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initializeWorkerLogging, applicationLogs, closeApplicationLogging } from '../../../lib/logging'
import { runPlatformLiveQuery } from '../../../server/utils/platform-live-query'

// Application seam + actual upstream HTTP + real evlog drain. This is not actual Nuxt.
const root = mkdtempSync(join(tmpdir(), 'platform-logging185-'))
const priorDir = process.env.NUXT_LOG_DIR
let baseUrl: string
let status = 200
let rows = [{ qymc: 'PRIVATE185_RECORD', tyshxydm: '91330211255994457P' }]
const upstream = createServer(async (req, res) => {
  for await (const _chunk of req) { /* consume the form without logging it */ }
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ zrarData: { grid: { applyGrid: { page: 1, pageSize: 50, pageSet: rows, maxCount: rows.length } } } }))
})
beforeAll(async () => {
  process.env.NUXT_LOG_DIR = join(root, 'logs')
  initializeWorkerLogging()
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening')
  baseUrl = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`
})
afterAll(async () => {
  await closeApplicationLogging()
  await new Promise<void>(resolve => upstream.close(() => resolve()))
  if (priorDir === undefined) delete process.env.NUXT_LOG_DIR; else process.env.NUXT_LOG_DIR = priorDir
  rmSync(root, { recursive: true, force: true })
})
async function events(requestId: string) {
  await applicationLogs().flush()
  const list = await applicationLogs().list({ requestId })
  return Promise.all(list.rows.map(row => applicationLogs().detail(row.id)))
}
it('records accepted pages and query outcome through evlog without platform input or records', async () => {
  const result = await runPlatformLiveQuery({ source: 'queryList', name: 'PRIVATE185_INPUT' }, {
    cookie: 'session=PRIVATE185_COOKIE', transport: { baseUrl },
    logContext: { requestId: 'req185-success', traceId: 'trace185' },
  })
  expect(result).toMatchObject({ status: 'success', fetchedCount: 1, rows })
  const logged = await events('req185-success')
  expect(logged).toEqual(expect.arrayContaining([
    expect.objectContaining({ source: 'platform', operation: 'platform.query_list.page', outcome: 'success', page: 1, counts: { done: 1 } }),
    expect.objectContaining({ operation: 'platform.query_list.query', outcome: 'success', counts: { done: 1, total: 1, failed: 0 } }),
  ]))
  expect(logged).toHaveLength(2)
  expect(JSON.stringify(logged)).not.toMatch(/PRIVATE185|91330211255994457P/)
})
it.each([
  [0, 200, 'no_record', 'no_record', undefined],
  [1, 401, 'auth_failed', 'denied', 'auth_failed'],
  [1, 429, 'failed', 'failure', 'rate_limited'],
  [1, 503, 'failed', 'failure', 'upstream_failed'],
] as const)('preserves result and diagnostic distinction for rows %s HTTP %s', async (size, code, business, outcome, errorCode) => {
  rows = size ? [{ qymc: 'PRIVATE185_RECORD', tyshxydm: '91330211255994457P' }] : []
  status = code
  const requestId = `req185-status-${code}-${size}`
  const result = await runPlatformLiveQuery({ source: 'queryList', name: 'PRIVATE185_INPUT' }, {
    cookie: 'session=PRIVATE185_COOKIE', transport: { baseUrl }, logContext: { requestId },
  })
  expect(result.status).toBe(business)
  const logged = await events(requestId)
  expect(logged).toHaveLength(2)
  expect(logged.find(row => row?.operation === 'platform.query_list.query')).toMatchObject({ outcome, ...(errorCode ? { errorCode } : {}) })
  expect(JSON.stringify(logged)).not.toContain('PRIVATE185')
})
it('records credential unavailable as skipped rather than no_record or upstream failure', async () => {
  const result = await runPlatformLiveQuery({ source: 'queryList', name: 'PRIVATE185_INPUT' }, { cookie: '', logContext: { requestId: 'req185-missing' } })
  expect(result).toMatchObject({ status: 'not_queried', completeness: 'not_queried', pages: [] })
  expect(await events('req185-missing')).toEqual([expect.objectContaining({ operation: 'platform.query_list.query', outcome: 'skipped', errorCode: 'credential_unavailable', counts: { done: 0, total: 0, failed: 0 } })])
})
it('legacy retry records transport retry separately from one semantic slot outcome', async () => {
  const { queryPlatformSlots } = await import('../../../lib/platform/client')
  status = 503; rows = []
  const result = await queryPlatformSlots({ uscc: '91330211255994457P', cookie: 'session=PRIVATE185_COOKIE', baseUrl, retries: 1,
    sleep: async () => { status = 200 }, logContext: { requestId: 'req185-retry' },
  }, [{ interface: 'apply_list' }])
  expect(result[0]).toMatchObject({ status: 'no_record', rows: [] })
  const logged = await events('req185-retry')
  expect(logged).toHaveLength(2)
  expect(logged).toEqual(expect.arrayContaining([
    expect.objectContaining({ operation: 'platform.query_list.retry', outcome: 'started', page: 1, counts: { done: 1 } }),
    expect.objectContaining({ operation: 'platform.query_list.slot', outcome: 'no_record', page: 1 }),
  ]))
  expect(JSON.stringify(logged)).not.toContain('PRIVATE185')
})
it('batch retry preserves accepted pages and correlates only unfinished item collection', async () => {
  const { initializeDb } = await import('../../../db/client')
  const { updateCredential } = await import('../../../server/utils/credential-state')
  const { handlePlatformBatchRequest } = await import('../../../server/utils/platform-batch-http')
  const { whenIdle } = await import('../../../server/utils/job-runner')
  const db = initializeDb({ dbPath: join(root, 'batch.db'), create: true })
  updateCredential('miitCookie', 'session=PRIVATE185_COOKIE', { db })
  const nativeFetch = globalThis.fetch
  let failSecond = true
  const visited: number[] = []
  // External transport boundary, not an internal logger/job mock.
  globalThis.fetch = async (url, init) => {
    const number = Number(new URLSearchParams(String(init?.body)).get('pageNum'))
    visited.push(number)
    return new Response(number === 2 && failSecond ? 'PRIVATE185_ERROR' : JSON.stringify({ zrarData: { grid: { applyGrid: { page: number, pageSize: 1, pageSet: [{ qymc: 'PRIVATE185_RECORD', relation: String(number) }], maxCount: 2 } } } }), { status: number === 2 && failSecond ? 503 : 200 })
  }
  const invoke = (action: 'submit' | 'retry' | 'status', body?: unknown, batchId?: string) => handlePlatformBatchRequest(action, {
    body, batchId, headers: { authorization: 'Bearer fixture185' },
  }, { db, apiToken: 'fixture185', filesDir: root, logContext: { requestId: action === 'retry' ? 'req185-batch-retry' : 'req185-batch', traceId: action === 'retry' ? 'trace185-batch-retry' : 'trace185-batch' } })
  try {
    const submitted = await invoke('submit', { items: [{ query: { source: 'queryList', name: 'PRIVATE185_INPUT', pageSize: 1 } }] })
    expect(submitted.status).toBe(202)
    const receipt = submitted.body as any
    await whenIdle()
    const prior = (await invoke('status', undefined, receipt.batchId)).body as any
    expect(prior).toMatchObject({ state: 'failed', items: [{ status: 'partial', unfinished: [{ page: 2 }] }] })
    failSecond = false; visited.length = 0
    expect((await invoke('retry', { itemIds: receipt.itemIds }, receipt.batchId)).status).toBe(202)
    await whenIdle()
    const after = (await invoke('status', undefined, receipt.batchId)).body as any
    expect(after).toMatchObject({ state: 'done', attempt: 2, items: [{ status: 'success' }] })
    expect(after.items[0].segments[0]).toEqual(prior.items[0].segments[0])
    expect(visited).toEqual([2])
    await applicationLogs().flush()
    const summaries = await applicationLogs().list({ batchId: receipt.batchId })
    const logged = await Promise.all(summaries.rows.map(row => applicationLogs().detail(row.id)))
    expect(logged.filter(row => row?.operation === 'platform.query_list.page' && row.outcome === 'success').map(row => row!.page).sort()).toEqual([1, 2])
    expect(logged.filter(row => row?.operation === 'platform.query_list.query')).toEqual(expect.arrayContaining([
      expect.objectContaining({ requestId: 'req185-batch', traceId: 'trace185-batch', batchId: receipt.batchId, taskId: receipt.batchId, resourceId: receipt.itemIds[0], outcome: 'partial' }),
      expect.objectContaining({ requestId: 'req185-batch-retry', traceId: 'trace185-batch-retry', resourceId: receipt.itemIds[0], outcome: 'success' }),
    ]))
    expect(logged.filter(row => row?.operation === 'platform.batch.collect').map(row => row!.outcome).sort()).toEqual(['partial', 'success'])
    expect(logged.filter(row => row?.operation === 'platform.batch.retry')).toEqual([
      expect.objectContaining({ outcome: 'started', requestId: 'req185-batch-retry', traceId: 'trace185-batch-retry', batchId: receipt.batchId, counts: { total: 1 } }),
    ])
    expect(JSON.stringify(logged)).not.toContain('PRIVATE185')
  } finally { globalThis.fetch = nativeFetch; await whenIdle(); db.$client.close() }
})
