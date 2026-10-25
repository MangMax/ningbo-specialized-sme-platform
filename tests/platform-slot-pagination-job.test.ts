import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'
import * as h3 from 'h3'
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import { schema, useDb } from '../db'
import { clearJobSpecs, whenIdle } from '../server/utils/job-runner'
import { updateCredential } from '../server/utils/credential-state'

const dir = mkdtempSync(join(tmpdir(), 'issue299-pagination-'))
const db = useDb({ dbPath: join(dir, 'tasks.db') })
const USCC = '91330211255994457P'
const nativeFetch = globalThis.fetch
let server: Server, baseUrl: string
const calls: { source: string; rdjb: string; page: number; cookie: string }[] = []
let reply: (source: string, rdjb: string, page: number) => Promise<string> | string

function page(source: string, number: number, total = 51, overrides: Record<string, unknown> = {}) {
  const count = Math.min(50, Math.max(0, total - (number - 1) * 50))
  return JSON.stringify({ zrarData: { grid: { [source === 'businessList' ? 'businessListGrid' : 'applyGrid']: {
    page: number, pageSize: 50, maxCount: total,
    pageSet: Array.from({ length: count }, (_, i) => ({ id: `SQ${(number - 1) * 50 + i + 1}`, qymc: number === 2 ? '后页独有企业' : '合成企业', tyshxydm: USCC })), ...overrides,
  } } } })
}
const normalReply = (source: string, rdjb: string, n: number) => page(source, n, source === 'queryList' || rdjb === '3' ? 51 : 0)
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
    import('../server/api/jobs/index.post'), import('../server/api/jobs/[id].get'), import('../server/api/jobs/[id].delete'), import('../server/api/platform/queries.get'), import('../server/api/task-center/[id].get'),
  ])
  const router = h3.createRouter()
  router.post('/api/jobs', routes[0].default).get('/api/jobs/:id', routes[1].default).delete('/api/jobs/:id', routes[2].default).get('/api/platform/queries', routes[3].default)
  router.get('/api/task-center/:id', routes[4].default)
  server = createServer(h3.toNodeListener(h3.createApp().use(router)))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const enterprise = db.insert(schema.enterprise).values({ name: '合成企业', nameNorm: '合成企业', usccNorm: USCC }).returning().get()
  db.insert(schema.record).values({ enterpriseId: enterprise.id, source: 'miit', titleCode: 'specialized_sme' }).run()
})
afterEach(async () => {
  await whenIdle()
  for (const table of [schema.differenceReason, schema.platformBusinessObservation, schema.platformBusinessRecordVersion, schema.platformBusinessRecord, schema.platformRelation, schema.platformQuery, schema.importReceipt, schema.importBatch, schema.job]) db.delete(table).run()
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
  updateCredential('miitCookie', 'session=issue299-original', { db, env: {} })
  vi.stubGlobal('fetch', async (url: string, init: { body: string; headers: Record<string, string> }) => {
    const body = new URLSearchParams(init.body), source = url.includes('/businessList') ? 'businessList' : 'queryList'
    const rdjb = body.get('rdjb') ?? '', n = Number(body.get('pageNum'))
    calls.push({ source, rdjb, page: n, cookie: init.headers.Cookie })
    return { ok: true, status: 200, text: async () => reply(source, rdjb, n) }
  })
}

it('public job retains both sources’ unique row 51 and exact page evidence; complete cache reuses original IDs', async () => {
  upstream()
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
  expect(task).toMatchObject({ kind: 'reconcile', state: 'done', outcome: { complete: 1, partial: 1, failed: 0 }, capabilities: { retry: false } })
})

it('later-page inconsistency keeps first-page rows, original total, unfinished page and retries only incomplete slots', async () => {
  upstream()
  reply = (s, r, n) => s === 'businessList' && r === '3' && n === 2 ? page(s, n, 52) : normalReply(s, r, n)
  const job = await submit(), done = await finish(job.jobId)
  const partial = (await archives()).find(e => e.query.interface === 'business_list' && e.query.rdjb === '3')
  expect(partial.query.status).toBe('partial')
  expect(partial.relations).toHaveLength(50)
  expect(JSON.parse(partial.query.rawResponse)).toMatchObject({ completeness: 'partial', declaredTotal: 51, unfinished: [{ page: 2 }] })
  expect(done.result.collection).toMatchObject({ complete: 3, partial: 1, failed: 0, unknown: 0 })
  expect(await api(`/api/task-center/${job.jobId}`)).toMatchObject({ outcome: { partial: 1 }, capabilities: { retry: false } })
  const oldId = partial.query.id
  reply = normalReply
  const retry = await finish((await submit()).jobId)
  expect(retry.result.queries).toMatchObject({ network: 1, reused: 3 })
  const after = await archives()
  expect(after.find(e => e.query.id === oldId).query.status).toBe('partial')
  expect(after.filter(e => e.query.interface === 'business_list' && e.query.rdjb === '3')).toHaveLength(2)
})

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
  expect(cancelled.result.collection.positions).toEqual(expect.arrayContaining([expect.objectContaining({ interface: 'business_list', rdjb: '3', unfinished: [{ source: 'businessList', rdjb: '3', page: 2 }] })]))
  expect(calls.some(c => c.page === 2)).toBe(false)
  expect(await archives()).toHaveLength(0)
  expect(db.select().from(schema.importBatch).all()).toHaveLength(0)
  reply = normalReply
  expect((await finish((await submit()).jobId)).result.relations).toBe(102)
})

it('historical success without page proof is preserved but never reused as complete', async () => {
  upstream()
  const old = db.insert(schema.platformQuery).values({ interface: 'business_list', queryKey: USCC, rdjb: '3', queriedAt: new Date().toISOString(), status: 'success', rawResponse: page('businessList', 1) }).returning().get()
  db.insert(schema.platformRelation).values({ queryId: old.id, sequenceNo: 1, relationKey: 'old', rawFields: { id: 'old' } }).run()
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
})

it('network retry and subsequent pages keep the submission credential snapshot after replacement', async () => {
  upstream()
  let failures = 0
  reply = (s, r, n) => {
    updateCredential('miitCookie', 'session=issue299-replacement', { db, env: {} })
    if (s === 'businessList' && r === '3' && n === 2 && failures++ === 0) throw new Error('issue299 transient network error')
    return normalReply(s, r, n)
  }
  const done = await finish((await submit()).jobId)
  expect(done.result.relations).toBe(102)
  expect(calls).toHaveLength(7)
  expect(calls.every(c => c.cookie === 'session=issue299-original')).toBe(true)
  const stored = await archives()
  expect(JSON.stringify({ done, stored })).not.toMatch(/issue299-original|issue299-replacement/)
  const evidence = JSON.parse(stored.find(e => e.query.rdjb === '3').query.rawResponse)
  expect(evidence.requestCount).toBe(3)
})

it('newer failed slot invalidates older complete cache without changing either historical query', async () => {
  upstream()
  await finish((await submit()).jobId)
  const before = await archives()
  const old = before.find(e => e.query.rdjb === '3')
  const failure = db.insert(schema.platformQuery).values({ interface: 'business_list', queryKey: USCC, rdjb: '3', queriedAt: new Date(Date.now() + 1000).toISOString(), status: 'failed', failureReason: 'newer synthetic failure' }).returning().get()
  const retried = await finish((await submit()).jobId)
  expect(retried.result.queries).toMatchObject({ network: 1, reused: 3 })
  const after = await archives()
  expect(after.find(e => e.query.id === old.query.id)).toEqual(old)
  expect(after.find(e => e.query.id === failure.id).query.failureReason).toBe('newer synthetic failure')
})

it('archive failure on row 51 rolls back the whole query/relation/decision batch, then retry commits', async () => {
  upstream()
  db.$client.exec("CREATE TEMP TRIGGER issue299_fail BEFORE INSERT ON platform_relation WHEN NEW.sequence_no = 51 BEGIN SELECT RAISE(ABORT, 'issue299 synthetic archive failure'); END")
  try {
    const failed = await finish((await submit()).jobId)
    expect(failed.state).toBe('failed')
    expect(await archives()).toHaveLength(0)
    expect(db.select().from(schema.platformRelation).all()).toHaveLength(0)
    expect(db.select().from(schema.differenceReason).all()).toHaveLength(0)
    expect(db.select().from(schema.importReceipt).all().length).toBeGreaterThan(0)
  } finally { db.$client.exec('DROP TRIGGER issue299_fail') }
  expect((await finish((await submit()).jobId)).result.relations).toBe(102)
})

it('missing later-page total cannot inherit earlier metadata and masquerade as complete', async () => {
  upstream()
  reply = (s, r, n) => s === 'businessList' && r === '3' && n === 2 ? page(s, n, 51, { maxCount: undefined }) : normalReply(s, r, n)
  await finish((await submit()).jobId)
  const entry = (await archives()).find(e => e.query.rdjb === '3')
  expect(entry.query.status).toBe('partial')
  expect(entry.relations).toHaveLength(50)
  expect(JSON.parse(entry.query.rawResponse)).toMatchObject({ completeness: 'partial', declaredTotal: 51, unfinished: [{ page: 2 }] })
})

it('cache verifies archived page bytes against ordered relations, rejecting a forged complete marker', async () => {
  upstream()
  await finish((await submit()).jobId)
  const original = (await archives()).find(e => e.query.rdjb === '3')
  const corrupted = JSON.parse(original.query.rawResponse)
  corrupted.pages[1].raw = page('businessList', 2, 51, { pageSet: [{ id: 'DIFFERENT', qymc: '不同记录', tyshxydm: USCC }] })
  // Synthetic corruption stays in this isolated database only.
  db.$client.prepare('UPDATE platform_query SET raw_response = ? WHERE id = ?').run(JSON.stringify(corrupted), original.query.id)
  const retry = await finish((await submit()).jobId)
  expect(retry.result.queries).toMatchObject({ network: 1, reused: 3 })
  const after = await archives()
  expect(after.find(e => e.query.id === original.query.id).query.rawResponse).toBe(JSON.stringify(corrupted))
  expect(after.filter(e => e.query.rdjb === '3')).toHaveLength(2)
})
