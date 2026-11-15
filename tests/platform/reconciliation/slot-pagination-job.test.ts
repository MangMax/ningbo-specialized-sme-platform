import {newJobId} from '../../../lib/job'
import {submitNativePlatformQuery} from '../fixtures/native-query'
import { nativeRelationRows } from '../fixtures/native-evidence'
import { initializeDb } from '../../../db/client'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'
import * as h3 from 'h3'
import { eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import { schema, useDb } from '../../../db'
import { clearJobSpecs, whenIdle } from '../../../server/utils/job-runner'
import { updateCredential } from '../../../server/utils/credential-state'
import type { TaskList, TaskSummary } from '../../../lib/task-center'

const dir = mkdtempSync(join(tmpdir(), 'issue299-pagination-'))
let dbSerial=0
let db = initializeDb({ create: true, dbPath: join(dir, 'tasks.db') })
const USCC = '91330211255994457P'
const nativeFetch = globalThis.fetch
let server: Server, baseUrl: string
const calls: { source: string; rdjb: string; page: number; cookie: string }[] = []
let reply: (source: string, rdjb: string, page: number) => Promise<string> | string
let upstreamStatus = 200

function page(source: string, number: number, total = 51, overrides: Record<string, unknown> = {}) {
  const count = Math.min(50, Math.max(0, total - (number - 1) * 50))
  return JSON.stringify({ zrarData: { grid: { [source === 'businessList' ? 'businessListGrid' : 'applyGrid']: {
    page: number, pageSize: 50, maxCount: total,
    pageSet: Array.from({ length: count }, (_, i) => ({ id: `SQ${(number - 1) * 50 + i + 1}`, qymc: number === 2 ? '后页独有企业' : '合成企业', tyshxydm: USCC })), ...overrides,
  } } } })
}
const normalReply = (source: string, rdjb: string, n: number) => page(source, n, rdjb === '3' ? 51 : 0)
async function api(path: string, method = 'GET', body?: unknown) {
  const response = await nativeFetch(baseUrl + path, { method, headers: { authorization: 'Bearer issue299-api', 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
  const result = await response.json()
  expect(response.ok, JSON.stringify(result)).toBe(true)
  return result as any
}
async function submit() {
  return api('/api/jobs', 'POST', { kind: 'reconcile', params: { usccs: [USCC], concurrency: 1 } })
}
async function finish(id: string) { await whenIdle(); return api(`/api/jobs/${id}`) }
async function archives() { return (await api(`/api/platform/queries?queryKey=${USCC}&includeRawResponse=true&pageSize=100`)).rows as any[] }

beforeAll(async () => {
  vi.stubEnv('NUXT_DB_PATH', join(dir, 'tasks.db'))
  vi.stubEnv('MIIT_COOKIE', '')
  vi.stubEnv('NUXT_OCR_TOKEN', '')
  vi.stubGlobal('useRuntimeConfig', () => ({ apiToken: 'issue299-api', filesDir: dir, curatedPath: join(dir, 'absent'), reconcilePath: join(dir, 'absent') }))
  for (const key of ['defineEventHandler', 'readBody', 'createError', 'setResponseStatus', 'setHeader', 'getRouterParam', 'getQuery', 'getRequestURL', 'getHeader'] as const) vi.stubGlobal(key, h3[key])
  vi.doMock('@db', () => ({ useDb: () => db }))
  const routes = await Promise.all([
    import('../../../server/api/jobs/index.post'), import('../../../server/api/jobs/[id].get'), import('../../../server/api/jobs/[id].delete'), import('../../../server/api/platform/queries.get'), import('../../../server/api/task-center/[id].get'), import('../../../server/api/task-center/index.get'),
  ])
  const router = h3.createRouter()
  router.post('/api/jobs', routes[0].default).get('/api/jobs/:id', routes[1].default).delete('/api/jobs/:id', routes[2].default).get('/api/platform/queries', routes[3].default)
  router.get('/api/task-center/:id', routes[4].default)
  router.get('/api/task-center', routes[5].default)
  server = createServer(h3.toNodeListener(h3.createApp().use(router)))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const enterprise = db.insert(schema.enterprise).values({ name: '合成企业', nameNorm: '合成企业', usccNorm: USCC }).returning().get()
  db.insert(schema.record).values({ enterpriseId: enterprise.id, source: 'miit', titleCode: 'specialized_sme' }).run()
})
afterEach(async () => {
  await whenIdle()
  db.$client.close()
  const path=join(dir,`tasks-${++dbSerial}.db`)
  db=initializeDb({create:true,dbPath:path})
  vi.stubEnv('NUXT_DB_PATH',path)
  const enterprise=db.insert(schema.enterprise).values({name:'合成企业',nameNorm:'合成企业',usccNorm:USCC}).returning().get()
  db.insert(schema.record).values({enterpriseId:enterprise.id,source:'miit',titleCode:'specialized_sme'}).run()
  calls.length = 0
})
afterAll(async () => {
  await whenIdle()
  await new Promise<void>(resolve => server.close(() => resolve()))
  clearJobSpecs(); vi.doUnmock('@db'); vi.unstubAllGlobals(); vi.unstubAllEnvs()
  db.$client.close(); rmSync(dir, { recursive: true, force: true })
})
function upstream() {
  reply = normalReply
  upstreamStatus = 200
  updateCredential('miitCookie', 'session=issue299-original', { db, env: {} })
  vi.stubGlobal('fetch', async (url: string, init: { body: string; headers: Record<string, string> }) => {
    const body = new URLSearchParams(init.body), source = url.includes('/businessList') ? 'businessList' : 'queryList'
    const rdjb = body.get('rdjb') ?? '', n = Number(body.get('pageNum'))
    const cookie = init.headers.Cookie
    if (typeof cookie !== 'string' || cookie.length === 0) {
      throw new Error('合成上游请求缺少非空 Cookie')
    }
    calls.push({ source, rdjb, page: n, cookie })
    return { ok: upstreamStatus < 400, status: upstreamStatus, text: async () => reply(source, rdjb, n) }
  })
}

it('public job retains both sources’ unique row 51 and exact page evidence; complete cache reuses original IDs', async () => {
  upstream()
  reply=(s,r,n)=>page(s,n,s==='queryList'||r==='3'?51:0)
  const job = await submit(), done = await finish(job.jobId)
  expect(done.state).toBe('done')
  expect(done.result.relations).toBe(102)
  expect(calls.filter(c => c.page === 2).map(c => c.source)).toEqual(['businessList', 'queryList'])
  const stored = await archives()
  for (const entry of stored.filter(e => e.relations.length)) {
    expect(entry.relations).toHaveLength(51)
    expect(entry.relations[50]).toMatchObject({ sequenceNo: 51, relationKey: 'SQ51', nameRaw: '后页独有企业' })
    const raw = JSON.parse(entry.query.rawResponse)
    expect(raw).toMatchObject({ completeness: 'complete', declaredTotal: 51, unfinished: [] })
    expect(raw.pages.map((p: any) => p.page)).toEqual([1, 2])
    expect(raw.pages[1].raw).toBe(page(entry.query.interface === 'business_list' ? 'businessList' : 'queryList', 2))
    expect(entry.query.collectionEvidence).toBeNull()
  }
  const second = await finish((await submit()).jobId)
  expect(second.result.queries).toMatchObject({ network: 0, reused: 4 })
  expect((await archives()).map(e => e.query.id)).toEqual(stored.map(e => e.query.id))
  expect(calls).toHaveLength(6)
  const summary = await api(`/api/jobs/${job.jobId}?view=summary`)
  expect(summary).toMatchObject({ kind: 'reconcile', state: 'done' })
  const task = await api(`/api/task-center/${job.jobId}`)
  expect(task).toMatchObject({ kind: 'reconcile', state: 'done', outcome: null, reconcile: { targets: 1, needsReview: 1, queryFailed: 0 }, capabilities: { retry: false } })
  expect(task.reconcileCollection).toMatchObject({ complete: 4, partial: 0, failed: 0, unknown: 0, unfinished: 0, positions: [], positionsTruncated: false })
  expect((await api('/api/task-center?tab=platform')).rows.find((t: { id: string }) => t.id === job.jobId).reconcileCollection).toEqual(task.reconcileCollection)
  expect((await api(`/api/task-center/${second.id}`)).reconcileCollection).toEqual(task.reconcileCollection)
})

// These multi-page/replay integration cases include native archive verification.
// Their 30s runner budget stays below the source collection's 60s limit; it is
// not an operation latency assertion. Scalar/invalid-metadata cases keep 5s.
it('later-page inconsistency keeps first-page rows, original total, unfinished page and retries only incomplete slots', async () => {
  upstream()
  reply = (s, r, n) => s === 'businessList' && r === '3' && n === 2 ? page(s, n, 52) : normalReply(s, r, n)
  const job = await submit(), done = await finish(job.jobId)
  const partial = (await archives()).find(e => e.query.interface === 'business_list' && e.query.rdjb === '3')
  expect(partial.query.status).toBe('partial')
  expect(partial.relations).toHaveLength(50)
  expect(JSON.parse(partial.query.rawResponse)).toMatchObject({ completeness: 'partial', declaredTotal: 51, unfinished: [{ page: 2 }] })
  expect(done.result.collection).toMatchObject({ complete: 3, partial: 1, failed: 0, unknown: 0 })
  expect(await api(`/api/task-center/${job.jobId}`)).toMatchObject({ outcome: null, reconcile: { needsReview: 1 }, capabilities: { retry: false } })
  expect(await api(`/api/task-center/${job.jobId}`)).toMatchObject({ outcome: null, reconcile: { targets: 1, needsReview: 1 }, reconcileCollection: { complete: 3, partial: 1, failed: 0, unknown: 0, unfinished: 1, positions: [{ source: 'businessList', rdjb: '3', page: 2 }] } })
  const oldId = partial.query.id
  reply = normalReply
  const retry = await finish((await submit()).jobId)
  expect(retry.result.queries).toMatchObject({ network: 1, reused: 3 })
  const after = await archives()
  expect(after.find(e => e.query.id === oldId).query.status).toBe('partial')
  expect(after.filter(e => e.query.interface === 'business_list' && e.query.rdjb === '3')).toHaveLength(2)
}, 30000)

it('cancel between pages stops requests, returns unfinished position and atomically writes no partial batch; resubmission succeeds', async () => {
  upstream()
  let release!: () => void, entered!: () => void
  const gate = new Promise<void>(resolve => { entered = resolve })
  reply = async (s, r, n) => {
    if (s === 'businessList' && r === '3' && n === 1) { entered(); await new Promise<void>(resolve => { release = resolve }) }
    return normalReply(s, r, n)
  }
  const job = await submit(); await gate
  expect(await api(`/api/jobs/${job.jobId}`, 'DELETE')).toMatchObject({ cancelRequested: true })
  release()
  const cancelled = await finish(job.jobId)
  expect(cancelled.state).toBe('cancelled')
  expect(await api(`/api/task-center/${job.jobId}`)).toMatchObject({ outcome: null, reconcile: { targets: 1 }, reconcileCollection: { complete: 2, partial: 1, failed: 0, unknown: 1, unfinished: 2, positions: [{ source: 'businessList', rdjb: '3', page: 2 }, { source: 'queryList', rdjb: null, page: 1 }] } })
  expect(cancelled.result.collection.positions).toEqual(expect.arrayContaining([expect.objectContaining({ interface: 'business_list', rdjb: '3', unfinished: [{ source: 'businessList', rdjb: '3', page: 2 }] })]))
  expect(calls.some(c => c.page === 2)).toBe(false)
  expect(await archives()).toHaveLength(0)
  expect(db.select().from(schema.importBatch).all()).toHaveLength(0)
  reply = normalReply
  expect((await finish((await submit()).jobId)).result.relations).toBe(51)
}, 30000)

it('historical success without page proof is preserved but never reused as complete', async () => {
  upstream()
  const seeded=submitNativePlatformQuery(db,{interface:'business_list',queryKey:USCC,rdjb:'3',queriedAt:new Date().toISOString(),status:'success',rawResponse:page('businessList',1),relations:[{sequenceNo:1,relationKey:'old',rawFields:{id:'old'}}]})
  const old={id:seeded.queryId,rawResponse:page('businessList',1)}
  const done = await finish((await submit()).jobId)
  expect(done.result.queries).toMatchObject({ network: 4, reused: 0 })
  expect((await archives()).find(e => e.query.id === old.id)).toMatchObject({ query: { status: 'success', rawResponse: old.rawResponse }, relations: [{ id: expect.any(Number), relationKey: 'old' }] })
})

it.each(['maxCount', 'page', 'pageSize'])('missing %s stays incomplete and preserves original raw instead of inventing coverage', async field => {
  upstream()
  reply = (s, r, n) => s === 'queryList' ? page(s, n, 0, { [field]: undefined }) : normalReply(s, r, n)
  const done = await finish((await submit()).jobId)
  const entry = (await archives()).find(e => e.query.interface === 'apply_list')
  expect(['success', 'no_record']).not.toContain(entry.query.status)
  const evidence = JSON.parse(entry.query.rawResponse)
  expect(evidence.completeness).not.toBe('complete')
  expect(evidence.pages[0].raw).toBe(page('queryList', 1, 0, { [field]: undefined }))
  expect(evidence.unfinished).toHaveLength(1)
  expect(evidence.failureReason).toBeTruthy()
  expect(done.result.counts.noRecord).toBe(0)
  expect(done.result.collection.complete).toBe(3)
})

it('later-page timeout exhausts bounded retries, retains 50 rows and the actual unfinished page', async () => {
  upstream()
  reply = (s, r, n) => {
    if (s === 'businessList' && r === '3' && n === 2) throw new DOMException('issue299 upstream timeout', 'TimeoutError')
    return normalReply(s, r, n)
  }
  const done = await finish((await submit()).jobId)
  const entry = (await archives()).find(e => e.query.interface === 'business_list' && e.query.rdjb === '3')
  expect(entry.query.status).toBe('partial')
  expect(entry.relations).toHaveLength(50)
  const evidence = JSON.parse(entry.query.rawResponse)
  expect(evidence).toMatchObject({ declaredTotal: 51, requestCount: 4, unfinished: [{ page: 2 }], failureReason: 'issue299 upstream timeout' })
  expect(evidence.pages[1].error.code).toBe('timeout')
  expect(done.result.collection.partial).toBe(1)
}, 30000)

it('network retry and subsequent pages keep the submission credential snapshot after replacement', async () => {
  upstream()
  let failures = 0
  reply = (s, r, n) => {
    updateCredential('miitCookie', 'session=issue299-replacement', { db, env: {} })
    if (s === 'businessList' && r === '3' && n === 2 && failures++ === 0) throw new Error('issue299 transient network error')
    return normalReply(s, r, n)
  }
  const done = await finish((await submit()).jobId)
  expect(done.result.relations).toBe(51)
  expect(calls).toHaveLength(6)
  expect(calls.every(c => c.cookie === 'session=issue299-original')).toBe(true)
  const stored = await archives()
  expect(JSON.stringify({ done, stored })).not.toMatch(/issue299-original|issue299-replacement/)
  const evidence = JSON.parse(stored.find(e => e.query.rdjb === '3').query.rawResponse)
  expect(evidence.requestCount).toBe(3)
}, 30000)

it('newer failed slot invalidates older complete cache without changing either historical query', async () => {
  upstream()
  await finish((await submit()).jobId)
  const before = await archives()
  const old = before.find(e => e.query.rdjb === '3')
  const failure={id:submitNativePlatformQuery(db,{interface:'business_list',queryKey:USCC,rdjb:'3',queriedAt:new Date(Date.now()+1000).toISOString(),status:'failed',failureReason:'newer synthetic failure',rawResponse:'Explicit failed response'}).queryId}
  const retried = await finish((await submit()).jobId)
  expect(retried.result.queries).toMatchObject({ network: 1, reused: 3 })
  const after = await archives()
  expect(after.find(e => e.query.id === old.query.id)).toEqual(old)
  expect(after.find(e => e.query.id === failure.id).query.failureReason).toBe('newer synthetic failure')
}, 30000)

it('archive failure on row 51 rolls back the whole query/relation/decision batch, then retry commits', async () => {
  upstream()
  db.$client.exec("CREATE TEMP TRIGGER issue299_fail BEFORE INSERT ON platform_business_observation WHEN NEW.sequence_no = 51 BEGIN SELECT RAISE(ABORT, 'issue299 synthetic archive failure'); END")
  try {
    const failed = await finish((await submit()).jobId)
    expect(failed.state).toBe('failed')
    expect(await archives()).toHaveLength(0)
    expect(nativeRelationRows(db)).toHaveLength(0)
    expect(db.select().from(schema.differenceReason).all()).toHaveLength(0)
    expect(db.select().from(schema.importReceipt).all().length).toBeGreaterThan(0)
  } finally { db.$client.exec('DROP TRIGGER issue299_fail') }
  expect((await finish((await submit()).jobId)).result.relations).toBe(51)
}, 30000)

it('missing later-page total cannot inherit earlier metadata and masquerade as complete', async () => {
  upstream()
  reply = (s, r, n) => s === 'businessList' && r === '3' && n === 2 ? page(s, n, 51, { maxCount: undefined }) : normalReply(s, r, n)
  await finish((await submit()).jobId)
  const entry = (await archives()).find(e => e.query.rdjb === '3')
  expect(entry.query.status).toBe('partial')
  expect(entry.relations).toHaveLength(50)
  expect(JSON.parse(entry.query.rawResponse)).toMatchObject({ completeness: 'partial', declaredTotal: 51, unfinished: [{ page: 2 }] })
}, 30000)

it('immutable native archives reject a forged complete marker before cache replay', async () => {
  upstream()
  await finish((await submit()).jobId)
  const original = (await archives()).find(e => e.query.rdjb === '3')
  const corrupted = JSON.parse(original.query.rawResponse)
  corrupted.pages[1].raw = page('businessList', 2, 51, { pageSet: [{ id: 'DIFFERENT', qymc: '不同记录', tyshxydm: USCC }] })
  // Synthetic corruption stays in this isolated database only.
  expect(()=>db.$client.prepare('UPDATE platform_archive_value SET bytes = ? WHERE id=(SELECT archive_id FROM platform_collection_archive_ref WHERE owner_id=(SELECT collection_id FROM platform_legacy_query_alias WHERE old_id=?) AND field=?)').run(Buffer.from(JSON.stringify(corrupted)),original.query.id,'rawResponse')).toThrow()
  const retry = await finish((await submit()).jobId)
  expect(retry.result.queries).toMatchObject({ network: 0, reused: 4 })
  const after = await archives()
  expect(after.find(e => e.query.id === original.query.id).query.rawResponse).toBe(original.query.rawResponse)
  expect(after.filter(e => e.query.rdjb === '3')).toHaveLength(1)
}, 30000)

it('four failed slots remain four failed collection slots through public task list and detail, while report targets stay one', async () => {
  upstream(); upstreamStatus = 400; reply = () => 'synthetic upstream failure'
  const job = await submit(), done = await finish(job.jobId)
  expect(done.result.collection).toMatchObject({ complete: 0, partial: 0, failed: 4, unknown: 0 })
  const detail = await api(`/api/task-center/${job.jobId}`)
  expect(detail.outcome).toBeNull()
  expect(detail.reconcile).toMatchObject({ targets: 1, needsReview: 0, queryFailed: 1 })
  expect(detail.reconcileCollection).toEqual({ complete: 0, partial: 0, failed: 4, unknown: 0, unfinished: 4, positions: [
    { source: 'businessList', rdjb: '1', page: 1 }, { source: 'businessList', rdjb: '2', page: 1 },
    { source: 'businessList', rdjb: '3', page: 1 }, { source: 'queryList', rdjb: null, page: 1 },
  ], positionsTruncated: false })
  const list = await api('/api/task-center?tab=platform')
  expect(list.rows.find((t: { id: string }) => t.id === job.jobId).reconcileCollection).toEqual(detail.reconcileCollection)
  expect(calls).toHaveLength(4)
})

function historicalSummaryJob() {
  const id=newJobId(),result={counts:{total:1,needsReview:1,queryFailed:0,notQueried:0},collection:{complete:4,partial:0,failed:0,unknown:0,positions:Array.from({length:4},()=>({unfinished:[]}))}}
  db.insert(schema.job).values({id,kind:'reconcile',state:'done',params:{titles:['specialized_sme']},progress:{done:1,total:1},result,createdAt:'2026-06-01T00:00:00Z'}).run()
  return {job:{jobId:id},done:{result}}
}

it('historical task reports without collection stay explicitly unknown through public list and detail', async () => {
  upstream()
  const {job,done}=historicalSummaryJob()
  const { collection: _collection, ...historicalReport } = done.result
  db.update(schema.job).set({ result: historicalReport }).where(eq(schema.job.id, job.jobId)).run()
  const detail = await api(`/api/task-center/${job.jobId}`)
  expect(detail.outcome).toBeNull()
  expect(detail.reconcile).toMatchObject({ targets: 1, needsReview: 1 })
  expect(detail.reconcileCollection).toEqual({ complete: null, partial: null, failed: null, unknown: null, unfinished: null, positions: [], positionsTruncated: false })
  expect((await api('/api/task-center?tab=platform')).rows.find((t: { id: string }) => t.id === job.jobId).reconcileCollection).toEqual(detail.reconcileCollection)
})

it('task summary bounds locations to 50 while retaining the actual unfinished total and excludes page raw', async () => {
  upstream()
  const {job,done}=historicalSummaryJob()
  db.update(schema.job).set({ result: { ...done.result, raw: 'PRIVATE_RAW'.repeat(100000), collection: {
    complete: 0, partial: 0, failed: 61, unknown: 0,
    positions: Array.from({ length: 61 }, (_, index) => ({ unfinished: [{ source: 'businessList', rdjb: '3', page: index + 1 }], pages: [{ raw: 'PRIVATE_PAGE_RAW' }] })),
  } } }).where(eq(schema.job.id, job.jobId)).run()
  const detail = await api(`/api/task-center/${job.jobId}`)
  expect(detail.outcome).toBeNull()
  expect(detail.reconcile).toMatchObject({ targets: 1, needsReview: 1 })
  expect(detail.reconcileCollection).toMatchObject({ complete: 0, failed: 61, unfinished: 61, positionsTruncated: true })
  expect(detail.reconcileCollection.positions).toHaveLength(50)
  expect(detail.reconcileCollection.positions[0]).toEqual({ source: 'businessList', rdjb: '3', page: 1 })
  expect(detail.reconcileCollection.positions[49]).toEqual({ source: 'businessList', rdjb: '3', page: 50 })
  expect(JSON.stringify(detail)).not.toContain('PRIVATE_')
  expect(JSON.stringify(detail).length).toBeLessThan(12000)
  expect((await api('/api/task-center?tab=platform')).rows.find((t: { id: string }) => t.id === job.jobId).reconcileCollection).toEqual(detail.reconcileCollection)
})

it('malformed historical collection scalars stay unknown without transporting nested raw objects', async () => {
  upstream()
  const {job,done}=historicalSummaryJob()
  db.update(schema.job).set({ result: { ...done.result, collection: {
    complete: { raw: 'PRIVATE_NESTED_RAW'.repeat(100000) }, partial: 0, failed: 0, unknown: 0,
    positions: [{ unfinished: [{ source: 'queryList', rdjb: null, page: { raw: 'PRIVATE_PAGE_RAW'.repeat(100000) } }] }],
  } } }).where(eq(schema.job.id, job.jobId)).run()
  const detail = await api(`/api/task-center/${job.jobId}`)
  expect(detail.reconcileCollection).toEqual({ complete: null, partial: null, failed: null, unknown: null, unfinished: null, positions: [], positionsTruncated: false })
  expect(detail.outcome).toBeNull()
  expect(detail.reconcile).toMatchObject({ targets: 1, needsReview: 1 })
  expect(JSON.stringify(detail)).not.toContain('PRIVATE_')
  expect(JSON.stringify(detail).length).toBeLessThan(12000)
})

const originalCollection = { complete: 4, partial: 0, failed: 0, unknown: 0 }
const pendingRange = { source: 'businessList', rdjb: '3', page: 2 }
const emptySlots = Array.from({ length: 4 }, () => ({ unfinished: [] }))
const unknownCollection = { complete: null, partial: null, failed: null, unknown: null, unfinished: null, positions: [], positionsTruncated: false }

async function publicSummaryPair(id: string) {
  const [detailResponse, listResponse] = await Promise.all([
    nativeFetch(`${baseUrl}/api/task-center/${id}`), nativeFetch(`${baseUrl}/api/task-center?tab=platform`),
  ])
  expect([detailResponse.status, listResponse.status]).toEqual([200, 200])
  const detail = await detailResponse.json() as TaskSummary
  const list = await listResponse.json() as TaskList
  expect(list.rows.find(row => row.id === id)?.reconcileCollection).toEqual(detail.reconcileCollection)
  return detail
}

const invalidHistoricalCollections: { name: string; collection: unknown }[] = [
  ...[undefined, null, 'x', 1, []].map((collection, index) => ({ name: `collection ${['missing', 'null', 'text', 'number', 'array'][index]}`, collection })),
  ...[undefined, 'x', null, {}, 1, true, ['x'], [null], [1], [[]], [{}]].map((positions, index) => ({ name: `positions ${['missing', 'text', 'null', 'object', 'number', 'boolean', 'text slot', 'null slot', 'number slot', 'array slot', 'slot missing unfinished'][index]}`, collection: { ...originalCollection, positions } })),
  ...[undefined, null, 'x', {}, 1, true, ['x'], [null], [1], [[]], [pendingRange, 'x']].map((unfinished, index) => ({ name: `unfinished ${['missing', 'null', 'text', 'object', 'number', 'boolean', 'text range', 'null range', 'number range', 'array range', 'mixed range'][index]}`, collection: { ...originalCollection, positions: [{ unfinished }, ...emptySlots.slice(1)] } })),
  ...[
    {}, { ...pendingRange, source: 'queryBusList' }, { ...pendingRange, source: null },
    { ...pendingRange, rdjb: '4' }, { ...pendingRange, rdjb: 3 }, { ...pendingRange, rdjb: null },
    { source: 'businessList', page: 2 }, { ...pendingRange, source: 'queryList' },
    { ...pendingRange, page: undefined }, { ...pendingRange, page: null }, { ...pendingRange, page: '2' },
    { ...pendingRange, page: 0 }, { ...pendingRange, page: -1 }, { ...pendingRange, page: 1.5 },
    { ...pendingRange, page: true }, { ...pendingRange, page: Number.MAX_SAFE_INTEGER + 1 },
    { ...pendingRange, rdjb: '3x' }, { ...pendingRange, source: 'queryList', rdjb: undefined },
  ].map((position, index) => ({ name: `range ${['missing fields', 'unsupported source', 'null source', 'unknown rdjb', 'numeric rdjb', 'null business rdjb', 'missing rdjb', 'queryList with rdjb', 'missing page', 'null page', 'text page', 'zero page', 'negative page', 'fractional page', 'boolean page', 'unsafe integer page', 'rdjb suffix', 'missing queryList rdjb'][index]}`, collection: { ...originalCollection, positions: [{ unfinished: [position] }, ...emptySlots.slice(1)] } })),
  { name: 'missing slot coverage', collection: { ...originalCollection, positions: emptySlots.slice(1) } },
  { name: 'missing count', collection: { ...originalCollection, complete: undefined, positions: emptySlots } },
  { name: 'negative count', collection: { ...originalCollection, partial: -1, positions: emptySlots } },
  { name: 'invalid slot beyond preview', collection: { complete: 0, partial: 0, failed: 52, unknown: 0, positions: [...Array.from({ length: 51 }, () => ({ unfinished: [pendingRange] })), {}] } },
  { name: 'invalid range beyond preview', collection: { complete: 0, partial: 1, failed: 0, unknown: 0, positions: [{ unfinished: [...Array.from({ length: 51 }, () => pendingRange), 'x'] }] } },
]

it('historical malformed collection matrix stays unknown through public list and detail without filtering bad entries into completion', async () => {
  upstream()
  const {job,done}=historicalSummaryJob()
  for (const { name, collection } of invalidHistoricalCollections) {
  db.update(schema.job).set({ result: { ...done.result, collection } }).where(eq(schema.job.id, job.jobId)).run()
  const before = db.select({ result: schema.job.result }).from(schema.job).where(eq(schema.job.id, job.jobId)).get()?.result
  const detail = await publicSummaryPair(job.jobId)
  expect(detail.reconcileCollection, name).toEqual(unknownCollection)
  expect(detail.outcome).toBeNull()
  expect(detail.reconcile).toMatchObject({ targets: 1, needsReview: 1 })
  expect(db.select({ result: schema.job.result }).from(schema.job).where(eq(schema.job.id, job.jobId)).get()?.result).toEqual(before)
  }
})

it.each([
  { name: 'empty positions', collection: { complete: 0, partial: 0, failed: 0, unknown: 0, positions: [] } },
  { name: 'four complete slots', collection: { ...originalCollection, positions: emptySlots } },
])('only validated $name report zero unfinished ranges through public list and detail', async ({ collection }) => {
  upstream()
  const {job,done}=historicalSummaryJob()
  db.update(schema.job).set({ result: { ...done.result, collection } }).where(eq(schema.job.id, job.jobId)).run()
  const detail = await publicSummaryPair(job.jobId)
  const { positions: _positions, ...counts } = collection
  expect(detail.reconcileCollection).toEqual({ ...counts, unfinished: 0, positions: [], positionsTruncated: false })
  expect(detail.outcome).toBeNull()
  expect(detail.reconcile).toMatchObject({ targets: 1, needsReview: 1 })
})

it.each([50, 51])('validated %i ranges preserve the full count and at most 50 scopes through public list and detail', async count => {
  upstream()
  const {job,done}=historicalSummaryJob()
  db.update(schema.job).set({ result: { ...done.result, collection: {
    complete: 0, partial: 1, failed: 0, unknown: 0,
    positions: [{ unfinished: Array.from({ length: count }, (_, index) => ({ ...pendingRange, page: index + 1 })) }],
  } } }).where(eq(schema.job.id, job.jobId)).run()
  const detail = await publicSummaryPair(job.jobId)
  expect(detail.reconcileCollection).toMatchObject({ complete: 0, partial: 1, unfinished: count, positionsTruncated: count > 50 })
  expect(detail.reconcileCollection?.positions).toHaveLength(50)
  expect(detail.reconcileCollection?.positions[49]).toEqual({ ...pendingRange, page: 50 })
  expect(detail.outcome).toBeNull()
  expect(detail.reconcile).toMatchObject({ targets: 1, needsReview: 1 })
})
