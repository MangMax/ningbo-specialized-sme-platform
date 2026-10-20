import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { useDb, schema } from '../db/client'
import { eq } from 'drizzle-orm'
import { __resetJobRunner, clearJobSpecs, ensureJobRunnerReady, registerJob, submitJob, whenIdle } from '../server/utils/job-runner'
import { newJobId } from '../lib/job'
import { handleTaskCenterRequest } from '../server/utils/task-center-http'
import { startHttpFixture, type HttpFixture, type FixtureRequest } from './helpers/http-fixture'

let dir: string
let api: HttpFixture
let db: ReturnType<typeof useDb>
const ids = { ocr: newJobId(), render: newJobId(), batch: newJobId(), reconcile: newJobId(), unknown: newJobId() }
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'task-center-'))
  db = useDb({ dbPath: join(dir, 'test.db') })
  __resetJobRunner(); clearJobSpecs(); ensureJobRunnerReady(db)
  for (const [name, kind] of Object.entries({ ocr: 'ocr', render: 'render-pages', batch: 'platform-query-batch', reconcile: 'reconcile', unknown: 'future-kind' })) {
    db.insert(schema.job).values({ id: ids[name as keyof typeof ids], kind, state: 'failed', params: { cookie: 'PRIVATE_COOKIE', files: ['/Users/private/secret.pdf'] }, progress: { done: 1, total: 3 }, result: { raw: 'PRIVATE_RAW'.repeat(100000), token: 'PRIVATE_TOKEN' }, error: 'PRIVATE_TOKEN /Users/private/secret.pdf', createdAt: '2026-10-19T00:00:00Z' }).run()
  }
  const route = (action: 'list' | 'detail' | 'cancel' | 'retry') => (request: FixtureRequest) => handleTaskCenterRequest(action, request, { db, apiToken: 'fixture-key', filesDir: dir })
  api = await startHttpFixture({ routes: { '/api/task-center': route('list'), [`/api/task-center/${ids.ocr}`]: route('detail'), [`/api/task-center/${ids.ocr}/cancel`]: route('cancel'), [`/api/task-center/${ids.batch}`]: route('detail'), [`/api/task-center/${ids.batch}/retry`]: route('retry') } })
})
afterEach(async () => { __resetJobRunner(); clearJobSpecs(); await api?.close(); rmSync(dir, { recursive: true, force: true }) })

describe('task center public HTTP', () => {
  it('lists disjoint bounded groups and keeps unknown kinds visible without raw payloads', async () => {
    const allResponse = await fetch(`${api.baseUrl}/api/task-center?pageSize=2`)
    expect(allResponse.headers.get('cache-control')).toBe('no-store')
    const all = await allResponse.json()
    expect(all.total).toBe(5)
    expect(all.rows).toHaveLength(2)
    expect(all.counts).toEqual({ all: 5, ocr: 2, platform: 2, export: 0 })
    const ocr = await (await fetch(`${api.baseUrl}/api/task-center?tab=ocr&state=failed`)).json()
    expect(ocr.rows.map((row: any) => row.kind).sort()).toEqual(['ocr', 'render-pages'])
    const unknown = await (await fetch(`${api.baseUrl}/api/task-center?pageSize=200`)).text()
    expect(unknown).toContain('future-kind')
    for (const secret of ['PRIVATE_', '/Users/', 'params', '"raw"']) expect(unknown).not.toContain(secret)
    expect(unknown.length).toBeLessThan(12000)
    const detail = await (await fetch(`${api.baseUrl}/api/task-center/${ids.ocr}`)).json()
    expect(detail.id).toBe(ids.ocr)
    expect(detail.capabilities.cancel).toBe(false)
    expect(detail.capabilities.retry).toBe(false)
    expect(detail.error).toContain('任务失败')
  })
})

it('locates OCR results by registered file and reports safe platform item ranges', async () => {
  db.insert(schema.storedFile).values({ id: 801, relPath: 'synthetic/roster.pdf', filename: 'roster.pdf', ext: 'pdf', bytes: 1, sha256: 'synthetic', source: 'jxj', kind: 'announcement' }).run()
  db.update(schema.job).set({ result: { files: [{ ok: true, fileId: 801, file: '/Users/private/wrong.pdf' }] } }).where(eq(schema.job.id, ids.ocr)).run()
  const detail = await (await fetch(`${api.baseUrl}/api/task-center/${ids.ocr}`)).json()
  expect(detail.links).toContainEqual({ label: '识别结果 #801', to: '/ocr?file=synthetic%2Froster.pdf' })
  db.update(schema.job).set({ result: { attempt: 2, items: [{ itemId: newJobId(), status: 'auth_failed', completeness: 'partial', segments: [{ rows: ['PRIVATE_ROWS'] }], unfinished: [{ source: 'queryBusList', rdjb: '1', page: 4 }] }] } }).where(eq(schema.job.id, ids.batch)).run()
  const list = await (await fetch(`${api.baseUrl}/api/task-center?tab=platform`)).json()
  expect(list.rows.find((r: any) => r.id === ids.batch).outcome).toMatchObject({ failed: 1, partial: 1, unfinished: 1, attempt: 2 })
  const result = await (await fetch(`${api.baseUrl}/api/task-center/${ids.batch}`, { headers: { authorization: 'Bearer fixture-key' } })).json()
  expect(result.items[0]).toMatchObject({ status: 'auth_failed', completeness: 'partial', positions: [{ source: 'queryBusList', rdjb: '1', page: 4 }] })
  expect(result.capabilities.retry).toBe(true)
  expect(JSON.stringify(result)).not.toContain('PRIVATE_ROWS')
})


it('keeps running cancellation pending until a real executor checkpoint and protects writes', async () => {
  let release!: () => void
  const blocked = new Promise<void>(resolve => { release = resolve })
  registerJob({ kind: 'ocr', status: 'ready', summary: 'synthetic', parse: raw => ({ ok: true, params: raw }), run: async ctx => { await blocked; return { result: null, cancelled: ctx.cancelled() } } })
  const running = submitJob(db, { kind: 'ocr', params: {}, filesDir: dir })
  // submitJob generates its own ID; route the live task through the same HTTP core.
  const live = await startHttpFixture({ routes: {
    [`/api/task-center/${running.id}`]: req => handleTaskCenterRequest('detail', req, { db, apiToken: 'fixture-key', filesDir: dir }),
    [`/api/task-center/${running.id}/cancel`]: req => handleTaskCenterRequest('cancel', req, { db, apiToken: 'fixture-key', filesDir: dir }),
  } })
  try {
    await new Promise(resolve => setTimeout(resolve, 10))
    const denied = await fetch(`${live.baseUrl}/api/task-center/${running.id}/cancel`, { method: 'POST' })
    expect(denied.status).toBe(401)
    const accepted = await fetch(`${live.baseUrl}/api/task-center/${running.id}/cancel`, { method: 'POST', headers: { authorization: 'Bearer fixture-key' } })
    expect(accepted.status).toBe(202)
    expect(await accepted.json()).toMatchObject({ cancelRequested: true, task: { state: 'running' } })
    release(); await whenIdle()
    const finished = await (await fetch(`${live.baseUrl}/api/task-center/${running.id}`)).json()
    expect(finished.state).toBe('cancelled')
    expect(finished.capabilities.cancel).toBe(false)
  } finally { release(); await whenIdle(); await live.close() }
})

it('exposes safe retry only for unfinished terminal batch items and enforces execution limit', async () => {
  const unfinished = newJobId(), complete = newJobId()
  db.update(schema.job).set({ params: { items: [{ itemId: complete, query: { source: 'queryList', startPage: 1 } }, { itemId: unfinished, query: { source: 'queryList', startPage: 1 } }] }, result: { attempt: 2, items: [{ itemId: complete, status: 'success', completeness: 'complete', segments: [], unfinished: [] }, { itemId: unfinished, status: 'failed', completeness: 'partial', segments: [], unfinished: [{ source: 'queryList', rdjb: null, page: 2 }] }] } }).where(eq(schema.job.id, ids.batch)).run()
  registerJob({ kind: 'platform-query-batch', status: 'ready', summary: 'synthetic isolated executor', parse: raw => ({ ok: true, params: raw }), run: async (_ctx, params) => {
    // Isolated execution boundary: re-querying the completed item produces a
    // visible failed item, so a wrong retry selection goes red through HTTP.
    const selected = params.retryItemIds as string[]
    return { result: { attempt: 3, items: [
      { itemId: complete, status: selected.includes(complete) ? 'failed' : 'success', completeness: selected.includes(complete) ? 'partial' : 'complete', unfinished: [] },
      { itemId: unfinished, status: selected.includes(unfinished) ? 'success' : 'failed', completeness: selected.includes(unfinished) ? 'complete' : 'partial', unfinished: [] },
    ] } }
  } })
  const headers = { authorization: 'Bearer fixture-key' }
  const detail = await (await fetch(`${api.baseUrl}/api/task-center/${ids.batch}`, { headers })).json()
  expect(detail.capabilities).toMatchObject({ retry: true, retryItemIds: [unfinished] })
  expect((await fetch(`${api.baseUrl}/api/task-center/${ids.batch}/retry`, { method: 'POST' })).status).toBe(401)
  expect((await fetch(`${api.baseUrl}/api/task-center/${ids.batch}/retry`, { method: 'POST', headers })).status).toBe(202)
  await whenIdle()
  const retried = await (await fetch(`${api.baseUrl}/api/task-center/${ids.batch}`, { headers })).json()
  expect(retried).toMatchObject({ id: ids.batch, state: 'done', outcome: { complete: 2, failed: 0, attempt: 3 } })
  db.update(schema.job).set({ result: { attempt: 10, items: [{ itemId: unfinished, status: 'failed', completeness: 'partial', unfinished: [{ source: 'queryList', rdjb: null, page: 2 }] }] } }).where(eq(schema.job.id, ids.batch)).run()
  const limited = await (await fetch(`${api.baseUrl}/api/task-center/${ids.batch}`, { headers })).json()
  expect(limited.capabilities.retry).toBe(false)
  expect((await fetch(`${api.baseUrl}/api/task-center/${ids.batch}/retry`, { method: 'POST', headers })).status).toBe(409)
})

it('does not invent completed platform items before first checkpoint', async () => {
  db.update(schema.job).set({ state: 'queued', result: null, error: null, params: { items: [{ itemId: newJobId(), query: { source: 'queryList' } }, { itemId: newJobId(), query: { source: 'queryList' } }] } }).where(eq(schema.job.id, ids.batch)).run()
  const list = await (await fetch(`${api.baseUrl}/api/task-center?tab=platform&state=queued`)).json()
  expect(list.rows[0].outcome).toMatchObject({ complete: 0, notQueried: 2 })
})

it('reports queued cancellation as cancelled rather than failed and keeps export unavailable', async () => {
  db.update(schema.job).set({ state: 'queued', error: null }).where(eq(schema.job.id, ids.ocr)).run()
  const cancelled = await fetch(`${api.baseUrl}/api/task-center/${ids.ocr}/cancel`, { method: 'POST', headers: { authorization: 'Bearer fixture-key' } })
  expect(cancelled.status).toBe(200)
  expect(await cancelled.json()).toMatchObject({ cancelRequested: false, task: { state: 'cancelled', error: null } })
  const empty = await (await fetch(`${api.baseUrl}/api/task-center?tab=export&pageSize=99999`)).json()
  expect(empty).toMatchObject({ rows: [], total: 0, exportReady: false, pageSize: 200 })
  const page1 = await (await fetch(`${api.baseUrl}/api/task-center?pageSize=2`)).json()
  const page2 = await (await fetch(`${api.baseUrl}/api/task-center?pageSize=2&page=2`)).json()
  expect(page2.rows).toHaveLength(2)
  expect(new Set([...page1.rows, ...page2.rows].map(row => row.id)).size).toBe(4)
})

it('导出任务摘要兼容历史v1至v5并识别当前v6规则而拒绝未知版本',async()=>{
  const versions=['current-roster-116-v1','current-roster-116-v2','current-roster-116-v3','current-roster-116-v4','current-roster-116-v5','current-roster-116-v6','unknown-rule']
  const exportIds=versions.map(ruleVersion=>{
    const id=newJobId()
    db.insert(schema.job).values({id,kind:'current-roster-export',state:'failed',params:{titleCode:'specialized_sme'},progress:{done:0,total:0},result:{ruleVersion,phase:'starting'},createdAt:'2026-10-19T00:00:00Z'}).run()
    return id
  })
  const before = db.select().from(schema.job).all()
  const response=await fetch(`${api.baseUrl}/api/task-center?tab=export`)
  expect(response.status).toBe(200)
  const body=await response.json()
  expect(body.total).toBe(7)
  for(let i=0;i<versions.length;i++) expect(body.rows.find((r:any)=>r.id===exportIds[i]).export.ruleVersion).toBe(i===versions.length-1?null:versions[i])
  expect(db.select().from(schema.job).all()).toEqual(before)
})
