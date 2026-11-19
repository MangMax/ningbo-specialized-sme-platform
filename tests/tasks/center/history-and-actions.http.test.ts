import { createClassifiedFile } from '../../../layers/sme-roster/server/utils/roster-file-classification'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initializeDb, schema } from '../../../db/client'
import { eq } from 'drizzle-orm'
import { __resetJobRunner, clearJobSpecs, ensureJobRunnerReady, registerJob, submitJob, whenIdle } from '../../../layers/core/server/utils/job-runner'
import { newJobId } from '../../../layers/core/lib/job'
import { handleTaskCenterRequest } from '../../../layers/sme-roster/server/utils/task-center-http'
import { startHttpFixture, type HttpFixture, type FixtureRequest } from '../../support/http'

let dir: string
let api: HttpFixture
let db: ReturnType<typeof initializeDb>
const ids = { ocr: newJobId(), render: newJobId(), batch: newJobId(), reconcile: newJobId(), unknown: newJobId() }
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'task-center-'))
  db = initializeDb({ create: true,  dbPath: join(dir, 'test.db') })
  __resetJobRunner(); clearJobSpecs(); ensureJobRunnerReady(db)
  for (const [name, kind] of Object.entries({ ocr: 'ocr', render: 'render-pages', batch: 'platform-query-batch', reconcile: 'reconcile', unknown: 'future-kind' })) {
    db.insert(schema.job).values({ id: ids[name as keyof typeof ids], kind, state: 'failed', params: { cookie: 'PRIVATE_COOKIE', files: ['/Users/private/secret.pdf'] }, progress: { done: 1, total: 3 }, result: { raw: 'PRIVATE_RAW'.repeat(100000), token: 'PRIVATE_TOKEN' }, error: 'PRIVATE_TOKEN /Users/private/secret.pdf', createdAt: '2026-10-19T00:00:00Z' }).run()
  }
  const route = (action: 'list' | 'detail' | 'cancel' | 'retry') => (request: FixtureRequest) => handleTaskCenterRequest(action, request, { db, apiToken: 'fixture-key', filesDir: dir })
  api = await startHttpFixture({ routes: { '/api/task-center': route('list'), [`/api/task-center/${ids.ocr}`]: route('detail'), [`/api/task-center/${ids.ocr}/cancel`]: route('cancel'), [`/api/task-center/${ids.batch}`]: route('detail'), [`/api/task-center/${ids.reconcile}`]: route('detail'), [`/api/task-center/${ids.batch}/retry`]: route('retry') } })
})
afterEach(async () => { __resetJobRunner(); clearJobSpecs(); await api?.close(); rmSync(dir, { recursive: true, force: true }) })

describe('task center public HTTP', () => {
  it('lists disjoint module tabs and keeps JobSpec-only kinds visible without raw payloads', async () => {
    registerJob({ kind: 'future-kind', status: 'todo', summary: 'synthetic', parse: raw => ({ ok: true, params: raw }) })
    const allResponse = await fetch(`${api.baseUrl}/api/task-center?pageSize=2`)
    expect(allResponse.headers.get('cache-control')).toBe('no-store')
    const all = await allResponse.json()
    expect(all.total).toBe(5)
    expect(all.rows).toHaveLength(2)
    expect(all.counts).toEqual({ all: 5, core: 2, 'sme-roster': 2, 'lead-lists': 0 })
    const ocr = await (await fetch(`${api.baseUrl}/api/task-center?tab=core&group=ocr&state=failed`)).json()
    expect(ocr.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'ocr', label: 'OCR 识别', module: 'core', group: 'ocr' }),
      expect.objectContaining({ kind: 'render-pages', label: 'PDF 转图', module: 'core', group: 'ocr' }),
    ]))
    expect(ocr.total).toBe(2)
    const roster = await (await fetch(`${api.baseUrl}/api/task-center?tab=sme-roster&state=failed`)).json()
    expect(roster.rows.map((row: any) => row.kind).sort()).toEqual(['platform-query-batch', 'reconcile'])
    expect(roster.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'platform-query-batch', label: '平台批量查询', module: 'sme-roster', group: 'platform' }),
      expect.objectContaining({ kind: 'reconcile', label: '平台核查', module: 'sme-roster', group: 'platform' }),
    ]))
    const unknown = await (await fetch(`${api.baseUrl}/api/task-center?pageSize=200`)).text()
    expect(JSON.parse(unknown).rows).toContainEqual(expect.objectContaining({ kind: 'future-kind', label: 'future-kind', module: null, group: 'all' }))
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
  createClassifiedFile(db, { id: 801, relPath: 'synthetic/roster.pdf', filename: 'roster.pdf', ext: 'pdf', bytes: 1, sha256: 'synthetic' }, { source: 'jxj', kind: 'announcement' })
  db.update(schema.job).set({ result: { files: [{ ok: true, fileId: 801, file: '/Users/private/wrong.pdf' }] } }).where(eq(schema.job.id, ids.ocr)).run()
  const detail = await (await fetch(`${api.baseUrl}/api/task-center/${ids.ocr}`)).json()
  expect(detail.links).toContainEqual({ label: '识别结果 #801', to: '/ocr?file=synthetic%2Froster.pdf' })
  db.update(schema.job).set({ result: { attempt: 2, items: [{ itemId: newJobId(), status: 'auth_failed', completeness: 'partial', segments: [{ rows: ['PRIVATE_ROWS'] }], unfinished: [{ source: 'queryBusList', rdjb: '1', page: 4 }] }] } }).where(eq(schema.job.id, ids.batch)).run()
  const list = await (await fetch(`${api.baseUrl}/api/task-center?tab=sme-roster&group=platform`)).json()
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
  const list = await (await fetch(`${api.baseUrl}/api/task-center?tab=sme-roster&group=platform&state=queued`)).json()
  expect(list.rows[0].outcome).toMatchObject({ complete: 0, notQueried: 2 })
})

it('reports queued cancellation as cancelled rather than failed and keeps export unavailable', async () => {
  db.update(schema.job).set({ state: 'queued', error: null }).where(eq(schema.job.id, ids.ocr)).run()
  const cancelled = await fetch(`${api.baseUrl}/api/task-center/${ids.ocr}/cancel`, { method: 'POST', headers: { authorization: 'Bearer fixture-key' } })
  expect(cancelled.status).toBe(200)
  expect(await cancelled.json()).toMatchObject({ cancelRequested: false, task: { state: 'cancelled', error: null } })
  const empty = await (await fetch(`${api.baseUrl}/api/task-center?tab=sme-roster&group=export&pageSize=99999`)).json()
  expect(empty).toMatchObject({ rows: [], total: 0, exportReady: false, pageSize: 200 })
  const page1 = await (await fetch(`${api.baseUrl}/api/task-center?pageSize=2`)).json()
  const page2 = await (await fetch(`${api.baseUrl}/api/task-center?pageSize=2&page=2`)).json()
  expect(page2.rows).toHaveLength(2)
  expect(new Set([...page1.rows, ...page2.rows].map(row => row.id)).size).toBe(4)
})

it('导出任务摘要兼容历史v1至v9并识别当前v10规则而拒绝未知版本',async()=>{
  const versions=['current-roster-116-v1','current-roster-116-v2','current-roster-116-v3','current-roster-116-v4','current-roster-116-v5','current-roster-116-v6','current-roster-116-v7', 'current-roster-116-v8','current-roster-116-v9','current-roster-116-v10','unknown-rule']
  const exportIds=versions.map(ruleVersion=>{
    const id=newJobId()
    db.insert(schema.job).values({id,kind:'current-roster-export',state:'done',params:{titleCode:'specialized_sme'},progress:{done:1,total:1},result:{ruleVersion,phase:'complete',generatedAt:'2026-10-19T00:00:00Z',counts:{eligible:5,pending:2,excluded:1}},createdAt:'2026-10-19T00:00:00Z'}).run()
    return id
  })
  const before = db.select().from(schema.job).all()
  const response=await fetch(`${api.baseUrl}/api/task-center?tab=sme-roster&group=export`)
  expect(response.status).toBe(200)
  const body=await response.json()
  expect(body.total).toBe(versions.length)
  for(let i=0;i<versions.length;i++) expect(body.rows.find((r:any)=>r.id===exportIds[i]).export.ruleVersion).toBe(i===versions.length-1?null:versions[i])
  expect(body.rows.find((r:any)=>r.export?.ruleVersion==='current-roster-116-v9')).toMatchObject({state:'done',export:{phase:'complete',counts:{eligible:5,pending:2,excluded:1},generatedAt:'2026-10-19T00:00:00Z'}})
  expect(db.select().from(schema.job).all()).toEqual(before)
})

it('keeps reconcile report targets distinct from collection completeness and missing counts unknown', async () => {
  db.update(schema.job).set({ result: { counts: { total: 7, needsReview: 3, queryFailed: 2, notQueried: 1 }, raw: 'PRIVATE_RAW' } }).where(eq(schema.job.id, ids.reconcile)).run()
  const before = db.select().from(schema.job).all()
  const list = await (await fetch(`${api.baseUrl}/api/task-center?tab=sme-roster&group=platform`)).json()
  const report = list.rows.find((row: any) => row.id === ids.reconcile)
  expect(report.outcome).toBeNull()
  expect(report.reconcile).toEqual({ targets: 7, needsReview: 3, queryFailed: 2, notQueried: 1 })
  const detail = await (await fetch(`${api.baseUrl}/api/task-center/${ids.reconcile}`)).json()
  expect(detail.reconcile).toEqual(report.reconcile)
  expect(detail.reconcileCollection).toEqual(report.reconcileCollection)
  expect(db.select().from(schema.job).all()).toEqual(before)
  db.update(schema.job).set({ result: { counts: { total: '7', needsReview: -1 } } }).where(eq(schema.job.id, ids.reconcile)).run()
  const history = await (await fetch(`${api.baseUrl}/api/task-center?tab=sme-roster&group=platform`)).json()
  expect(history.rows.find((row: any) => row.id === ids.reconcile).reconcile).toEqual({ targets: null, needsReview: null, queryFailed: null, notQueried: null })
})

it('bounds domain metadata and unknown historical results without forwarding extra count payloads', async () => {
  const candidate = newJobId()
  db.insert(schema.job).values({ id: candidate, kind: 'event-archive-candidates', state: 'failed', params: { eventIds: [1] }, progress: { done: 1, total: 1 }, result: { counts: { succeeded: 1, needsReview: 0, failed: 0, created: 2, existing: 0, raw: 'PRIVATE_RAW'.repeat(100000) }, items: [] }, createdAt: '2026-10-19T00:00:00Z' }).run()
  const response = await fetch(`${api.baseUrl}/api/task-center?pageSize=200`)
  expect(response.status).toBe(200)
  const text = await response.text()
  expect(text).not.toContain('PRIVATE_')
  expect(text.length).toBeLessThan(14000)
  const body = JSON.parse(text)
  expect(body.rows.find((row: any) => row.id === candidate).discovery.counts).toEqual({ succeeded: 1, needsReview: 0, failed: 0, created: 2, existing: 0 })
  expect(body.rows.find((row: any) => row.id === ids.unknown)).toMatchObject({ group: 'all', outcome: null, capabilities: { retry: false } })
})

it('summarizes annual event outcomes without exposing final checkpoints and directs retry to the domain', async () => {
  db.update(schema.job).set({ kind: 'event-annual-correspondence', result: { ruleVersion: '1', attempt: 2, events: [
    { eventId: 71, status: 'done', outcomes: ['PRIVATE_CHECKPOINT'.repeat(100000)], finalQualification: { status: 'eligible' } },
    { eventId: 72, status: 'failed', generation: 'PRIVATE_GENERATION' },
    { eventId: 73, status: 'pending' },
  ] } }).where(eq(schema.job.id, ids.reconcile)).run()
  const response = await fetch(`${api.baseUrl}/api/task-center/${ids.reconcile}`, { headers: { authorization: 'Bearer fixture-key' } })
  expect(response.status).toBe(200)
  const task = await response.json()
  expect(task).toMatchObject({ label: '年度过程对应', group: 'platform', annual: { total: 3, done: 1, failed: 1, unfinished: 1, attempt: 2 }, capabilities: { retry: false } })
  expect(task.capabilities.reason).toContain('年度专属接口')
  expect(task.links).toContainEqual({ label: '年度任务详情与重试资格', to: `/api/roster/annual-correspondence-tasks/${ids.reconcile}` })
  expect(JSON.stringify(task)).not.toContain('PRIVATE_')
  expect(JSON.stringify(task)).not.toContain('eligible')
  expect(JSON.stringify(task).length).toBeLessThan(3000)
})

it('keeps missing annual history unknown and does not authorize generic annual retry', async () => {
  db.update(schema.job).set({ kind: 'event-annual-correspondence', result: null }).where(eq(schema.job.id, ids.batch)).run()
  const task = await (await fetch(`${api.baseUrl}/api/task-center/${ids.batch}`)).json()
  expect(task.annual).toEqual({ total: null, done: 0, failed: 0, unfinished: null, attempt: null })
  expect(task.capabilities).toMatchObject({ cancel: false, retry: false, reason: '当前请求仅可查看任务。' })
  const retry = await fetch(`${api.baseUrl}/api/task-center/${ids.batch}/retry`, { method: 'POST', headers: { authorization: 'Bearer fixture-key' } })
  expect(retry.status).toBe(409)
})


it('reads bounded snapshot results only with task-center authorization and keeps unfinished rows unknown', async () => {
  db.update(schema.job).set({ kind: 'difference-snapshot', params: { backup: { path: '/PRIVATE_BACKUP' } }, result: {
    counts: { enterprises: 2, requests: 3, rows: 5, unfinished: 1 },
    items: [{ enterpriseId: 12, source: 'queryList', rdjb: null, complete: false, rows: null, segments: [] }], raw: 'PRIVATE_ARCHIVE',
  } }).where(eq(schema.job.id, ids.batch)).run()
  const url = `${api.baseUrl}/api/task-center/${ids.batch}`
  const anonymous = await (await fetch(url)).json()
  expect(anonymous.snapshot).toBeUndefined()
  const response = await fetch(url, { headers: { authorization: 'Bearer fixture-key' } })
  expect(response.headers.get('cache-control')).toBe('no-store')
  const body = await response.json()
  expect(body.snapshot).toMatchObject({ enterprises: 2, requests: 3, rows: 5, unfinished: 1, positions: [{ enterpriseId: 12, source: 'queryList', rdjb: null, rows: null }] })
  expect(body.links).toContainEqual({ label: '快照范围、计数与未完成位置', to: `/tasks?tab=sme-roster&group=platform&job=${ids.batch}#snapshot-result` })
  expect(JSON.stringify(body)).not.toContain('PRIVATE_')
})

it('accepts same-origin browser snapshot reads over HTTP but withholds details from unmarked and cross-origin reads', async () => {
  const { createServer } = await import('node:http')
  const { createApp, toNodeListener, defineEventHandler, getRequestURL, getHeader } = await import('h3')
  const { taskCenterBrowserAccess } = await import('../../../layers/core/server/utils/task-center-access')
  db.update(schema.job).set({ kind: 'difference-snapshot', result: { counts: { enterprises: 1, requests: 0, rows: 0, unfinished: 7 }, items: [] } }).where(eq(schema.job.id, ids.batch)).run()
  const server = createServer(toNodeListener(createApp().use(defineEventHandler(async event => {
    const result = await handleTaskCenterRequest('detail', { method: 'GET', path: getRequestURL(event).pathname, headers: { authorization: getHeader(event,'authorization') } },
      { db, apiToken: 'fixture-key', filesDir: dir, browserAuthorized: taskCenterBrowserAccess(event) })
    return result.body
  }))))
  await new Promise<void>(resolve => server.listen(0,'127.0.0.1',resolve))
  const origin = `http://127.0.0.1:${(server.address() as {port:number}).port}`
  try {
    const url = `${origin}/api/task-center/${ids.batch}`
    const headers = { 'x-task-center-browser':'1', 'sec-fetch-site':'same-origin', referer:`${origin}/tasks` }
    expect((await (await fetch(url,{headers})).json()).snapshot).toMatchObject({ enterprises:1, unfinished:7 })
    expect((await (await fetch(url)).json()).snapshot).toBeUndefined()
    expect((await (await fetch(url,{headers:{...headers,referer:'https://evil.invalid/tasks'}})).json()).snapshot).toBeUndefined()
  } finally { await new Promise<void>(resolve=>server.close(()=>resolve())) }
})
