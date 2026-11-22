import { newJobId } from '../../../layers/core/lib/job'
import { initializeDb } from '../../../db/client'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'
import * as h3 from 'h3'
import pg from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { schema } from '../../../db/client'
import { closePostgresDirectoryDb } from '../../../db/postgresql/client'
import { closeApplicationLogging } from '../../../layers/core/lib/logging'
import { stopPostgresJobs } from '../../../layers/core/server/utils/postgres-jobs'
import { installLeadListSchema } from '../../../layers/lead-lists/install-schema'
import type { RosterImportPlatformQuery } from '../../../layers/sme-roster/lib/roster-import-client'
import { postgresRuntimeFixture } from '../../support/postgres-fixture.mjs'
import type { TaskList, TaskSummary } from '../../../layers/core/lib/task-center'

// Keep real retries/page capture/credentials; advance only the injected backoff.
// The client/reconcile I/O suites own real scheduling and cancellation during sleep.
const backoffs = vi.hoisted(() => [] as number[])
vi.mock('../../../layers/sme-roster/lib/platform/client', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../layers/sme-roster/lib/platform/client')>()
  return { ...actual, queryPlatformSlots: (options: Parameters<typeof actual.queryPlatformSlots>[0], slots: Parameters<typeof actual.queryPlatformSlots>[1]) =>
    actual.queryPlatformSlots({ ...options, sleep: async ms => { backoffs.push(ms) } }, slots) }
})

const bin = process.env.ROSTER_TEST_POSTGRES_BIN
const postgresTest = it.skipIf(!bin)
let dir: string
let dbSerial = 0, database: string
let postgres: Awaited<ReturnType<typeof postgresRuntimeFixture>> | undefined
let admin: pg.Pool | undefined, db: pg.Pool
let casePool: pg.Pool | undefined
let requests: AbortController
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
async function api(path: string, method = 'GET', body?: unknown, signal = requests.signal) {
  const response = await nativeFetch(baseUrl + path, { method, signal, headers: { authorization: 'Bearer issue299-api', 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
  const result = await response.json()
  expect(response.ok, JSON.stringify(result)).toBe(true)
  return result as any
}
async function submit() {
  return api('/api/jobs', 'POST', { kind: 'reconcile', params: { usccs: [USCC], concurrency: 1 } })
}
async function finish(id: string) {
  const { signal } = requests
  const read = () => api(`/api/jobs/${id}`, 'GET', undefined, signal)
  await expect.poll(async () => (await read()).state, { timeout: 30_000 }).toMatch(/^(done|failed|cancelled)$/)
  return read()
}
async function queries() { return (await api(`/api/platform/queries?queryKey=${USCC}&pageSize=100`)).rows as any[] }

beforeAll(async () => {
  if (!bin) return
  dir = mkdtempSync(join(tmpdir(), 'reconcile-pagination-'))
  const dbPath = join(dir, 'source.db')
  const source = initializeDb({ create: true, dbPath })
  try {
    installLeadListSchema(source.$client)
    const enterprise = source.insert(schema.enterprise).values({ name: '合成企业', nameNorm: '合成企业', usccNorm: USCC }).returning().get()
    source.insert(schema.record).values({ enterpriseId: enterprise.id, source: 'miit', titleCode: 'specialized_sme' }).run()
  } finally {
    source.$client.close()
  }
  postgres = await postgresRuntimeFixture({ dir, sourcePath: dbPath, bin })
  admin = new pg.Pool({ connectionString: postgres.url })
  vi.stubEnv('NUXT_DB_PATH', join(dir, 'must-not-open.db'))
  vi.stubEnv('NUXT_DB_READONLY', '0')
  vi.stubEnv('NUXT_ROSTER_EXPORT_DIR', join(dir, 'exports'))
  vi.stubEnv('MIIT_COOKIE', '')
  vi.stubEnv('NUXT_OCR_TOKEN', '')
  vi.stubGlobal('useRuntimeConfig', () => ({ apiToken: 'issue299-api', filesDir: dir, curatedPath: join(dir, 'absent'), reconcilePath: join(dir, 'absent') }))
  for (const key of ['defineEventHandler', 'readBody', 'createError', 'setResponseStatus', 'setHeader', 'getRouterParam', 'getQuery', 'getRequestURL', 'getHeader'] as const) vi.stubGlobal(key, h3[key])
  const routes = await Promise.all([
    import('../../../layers/core/server/api/jobs/index.post'), import('../../../layers/core/server/api/jobs/[id].get'), import('../../../layers/core/server/api/jobs/[id].delete'), import('../../../layers/sme-roster/server/api/platform/queries.get'), import('../../../layers/core/server/api/task-center/[id].get'), import('../../../layers/core/server/api/task-center/index.get'), import('../../../layers/sme-roster/server/api/roster/import/commit.post'),
  ])
  const router = h3.createRouter()
  router.post('/api/jobs', routes[0].default).get('/api/jobs/:id', routes[1].default).delete('/api/jobs/:id', routes[2].default).get('/api/platform/queries', routes[3].default)
  router.get('/api/task-center/:id', routes[4].default)
  router.get('/api/task-center', routes[5].default)
  router.post('/api/roster/import/commit', routes[6].default)
  server = createServer(h3.toNodeListener(h3.createApp().use(router)))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`
}, 60_000)

beforeEach(async () => {
  if (!bin) return
  requests = new AbortController()
  // Give each case an untouched database without rerunning offline conversion.
  database = 'reconcile_case_' + ++dbSerial
  await admin!.query('CREATE DATABASE ' + database + ' TEMPLATE postgres')
  const url = new URL(postgres!.url)
  url.pathname = '/' + database
  vi.stubEnv('NUXT_POSTGRES_DIRECTORY_URL', url.href)
  vi.stubEnv('NUXT_POSTGRES_LOG_URL', url.href)
  vi.stubEnv('NUXT_POSTGRES_LOG_SCHEMA', 'runtime_logs')
  casePool = db = new pg.Pool({ connectionString: url.href })
}, 30_000)

afterEach(async () => {
  try {
    requests?.abort()
    await stopPostgresJobs()
    await closeApplicationLogging()
    await closePostgresDirectoryDb()
    const owned = casePool
    casePool = undefined
    await owned?.end()
    await admin?.query('DROP DATABASE IF EXISTS ' + database)
  } finally {
    vi.stubGlobal('fetch', nativeFetch)
    calls.length = 0
    backoffs.length = 0
  }
}, 30_000)
afterAll(async () => {
  try {
    if (server) await new Promise<void>(resolve => server.close(() => resolve()))
    await admin?.end()
  } finally {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    postgres?.close()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

async function setCookie(value: string) {
  await db.query(`
    INSERT INTO business.service_credential (key,value,updated_at) VALUES ('sme-roster.miitCookie',$1,$2)
    ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value,updated_at=EXCLUDED.updated_at
  `, [value, new Date().toISOString()])
}

async function seedQuery(query: Omit<RosterImportPlatformQuery, 'queryKey' | 'interface' | 'rdjb'>) {
  const result = await api('/api/roster/import/commit', 'POST', {
    idempotencyKey: 'reconcile-pagination-seed',
    sourceKind: 'platform_archive',
    sourceIdentity: 'synthetic/reconcile-pagination',
    payload: { platformQueries: [{ interface: 'business_list', queryKey: USCC, rdjb: '3', ...query }] },
  })
  expect(result.status).toBe('committed')
  return Number(result.items[0].ref.replace('query:', ''))
}

async function tableCount(table: 'import_batch' | 'platform_business_observation' | 'difference_reason' | 'import_receipt') {
  const { rows } = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM business.' + table)
  return rows[0]!.n
}

async function upstream() {
  reply = normalReply
  upstreamStatus = 200
  await setCookie('session=issue299-original')
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

postgresTest('public job retains both sources’ unique row 51 and page positions, then recollects all four slots', async () => {
  await upstream()
  reply=(s,r,n)=>page(s,n,s==='queryList'||r==='3'?51:0)
  const job = await submit(), done = await finish(job.jobId)
  expect(done.state).toBe('done')
  expect(done.result.relations).toBe(102)
  expect(calls.filter(c => c.page === 2).map(c => c.source)).toEqual(['businessList', 'queryList'])
  const stored = await queries()
  const populated = stored.filter(entry => entry.relations.length)
  expect(populated).toHaveLength(2)
  for (const entry of populated) {
    expect(entry.relations).toHaveLength(51)
    expect(entry.relations[50]).toMatchObject({ sequenceNo: 51, relationKey: 'SQ51', nameRaw: '后页独有企业' })
    expect(entry.query).not.toHaveProperty('rawResponse')
    const position = done.result.collection.positions.find((slot: { interface: string; rdjb: string }) =>
      slot.interface === entry.query.interface && slot.rdjb === entry.query.rdjb)
    expect(position).toMatchObject({ completeness: 'complete', declaredTotal: 51, unfinished: [], pages: [
      { page: 1, status: 'success', fetchedCount: 50 }, { page: 2, status: 'success', fetchedCount: 1 },
    ] })
    for (const acceptedPage of position.pages) expect(acceptedPage).not.toHaveProperty('raw')
  }
  const second = await finish((await submit()).jobId)
  expect(second.result.queries).toMatchObject({ network: 4, reused: 0 })
  const recollected = await queries()
  expect(recollected).toHaveLength(8)
  for (const original of stored) expect(recollected.find(entry => entry.query.id === original.query.id)).toEqual(original)
  expect(calls).toHaveLength(12)
  const summary = await api(`/api/jobs/${job.jobId}?view=summary`)
  expect(summary).toMatchObject({ kind: 'reconcile', state: 'done' })
  const task = await api(`/api/task-center/${job.jobId}`)
  expect(task).toMatchObject({ kind: 'reconcile', state: 'done', outcome: null, reconcile: { targets: 1, needsReview: 1, queryFailed: 0 }, capabilities: { retry: false } })
  expect(task.reconcileCollection).toMatchObject({ complete: 4, partial: 0, failed: 0, unknown: 0, unfinished: 0, positions: [], positionsTruncated: false })
  expect((await api('/api/task-center?tab=sme-roster&group=platform')).rows.find((t: { id: string }) => t.id === job.jobId).reconcileCollection).toEqual(task.reconcileCollection)
  expect((await api(`/api/task-center/${second.id}`)).reconcileCollection).toEqual(task.reconcileCollection)
}, 65_000)

// The case budget allows two bounded job waits across submission and recollection.
postgresTest('later-page inconsistency keeps first-page rows and the original total and locates the unfinished page before recollection', async () => {
  await upstream()
  reply = (s, r, n) => s === 'businessList' && r === '3' && n === 2 ? page(s, n, 52) : normalReply(s, r, n)
  const job = await submit(), done = await finish(job.jobId)
  const partial = (await queries()).find(e => e.query.interface === 'business_list' && e.query.rdjb === '3')
  expect(partial.query.status).toBe('partial')
  expect(partial.relations).toHaveLength(50)
  expect(done.result.collection.positions).toEqual(expect.arrayContaining([expect.objectContaining({
    interface: 'business_list', rdjb: '3', completeness: 'partial', declaredTotal: 51, unfinished: [{ source: 'businessList', rdjb: '3', page: 2 }],
  })]))
  expect(done.result.collection).toMatchObject({ complete: 3, partial: 1, failed: 0, unknown: 0 })
  expect(await api(`/api/task-center/${job.jobId}`)).toMatchObject({ outcome: null, reconcile: { needsReview: 1 }, capabilities: { retry: false } })
  expect(await api(`/api/task-center/${job.jobId}`)).toMatchObject({ outcome: null, reconcile: { targets: 1, needsReview: 1 }, reconcileCollection: { complete: 3, partial: 1, failed: 0, unknown: 0, unfinished: 1, positions: [{ source: 'businessList', rdjb: '3', page: 2 }] } })
  const oldId = partial.query.id
  reply = normalReply
  const retry = await finish((await submit()).jobId)
  expect(retry.result.queries).toMatchObject({ network: 4, reused: 0 })
  const after = await queries()
  expect(after.find(e => e.query.id === oldId).query.status).toBe('partial')
  expect(after.filter(e => e.query.interface === 'business_list' && e.query.rdjb === '3')).toHaveLength(2)
}, 65_000)

postgresTest('cancel between pages stops requests, returns unfinished position and atomically writes no partial batch; resubmission succeeds', async () => {
  await upstream()
  let release!: () => void, entered!: () => void
  const gate = new Promise<void>(resolve => { entered = resolve })
  reply = async (s, r, n) => {
    if (s === 'businessList' && r === '3' && n === 1) { entered(); await new Promise<void>(resolve => { release = resolve }) }
    return normalReply(s, r, n)
  }
  const job = await submit(); await gate
  try {
    expect(await api(`/api/jobs/${job.jobId}`, 'DELETE')).toMatchObject({ cancelRequested: true })
  } finally {
    release()
  }
  const cancelled = await finish(job.jobId)
  expect(cancelled.state).toBe('cancelled')
  expect.soft(calls.map(({ source, rdjb, page }) => [source, rdjb, page])).toEqual([
    ['businessList', '1', 1], ['businessList', '2', 1], ['businessList', '3', 1],
  ])
  expect(await api(`/api/task-center/${job.jobId}`)).toMatchObject({ outcome: null, reconcile: { targets: 1 }, reconcileCollection: { complete: 2, partial: 1, failed: 0, unknown: 1, unfinished: 2, positions: [{ source: 'businessList', rdjb: '3', page: 2 }, { source: 'queryList', rdjb: null, page: 1 }] } })
  expect(cancelled.result.collection.positions).toEqual(expect.arrayContaining([expect.objectContaining({ interface: 'business_list', rdjb: '3', unfinished: [{ source: 'businessList', rdjb: '3', page: 2 }] })]))
  expect(await queries()).toHaveLength(0)
  expect(await tableCount('import_batch')).toBe(0)
  reply = normalReply
  expect((await finish((await submit()).jobId)).result.relations).toBe(51)
}, 65_000)

postgresTest('historical success without page proof remains visible when all slots are recollected', async () => {
  await upstream()
  const rawResponse = page('businessList', 1)
  const oldId = await seedQuery({
    queriedAt: '2026-11-01T00:00:00.000Z', status: 'success', rawResponse,
    relations: [{ sequenceNo: 1, relationKey: 'old', rawFields: { id: 'old' } }],
  })
  const done = await finish((await submit()).jobId)
  expect(done.result.queries).toMatchObject({ network: 4, reused: 0 })
  const old = (await queries()).find(e => e.query.id === oldId)
  expect(old).toMatchObject({ query: { status: 'success' }, relations: [{ id: expect.any(Number), relationKey: 'old' }] })
  expect(old.query).not.toHaveProperty('rawResponse')
}, 65_000)

postgresTest.each(['maxCount', 'page', 'pageSize'])('missing %s stays incomplete and reports an unfinished page', async field => {
  await upstream()
  reply = (s, r, n) => s === 'queryList' ? page(s, n, 0, { [field]: undefined }) : normalReply(s, r, n)
  const done = await finish((await submit()).jobId)
  const entry = (await queries()).find(e => e.query.interface === 'apply_list')
  expect(['success', 'no_record']).not.toContain(entry.query.status)
  const evidence = done.result.collection.positions.find((slot: { interface: string }) => slot.interface === 'apply_list')
  expect(evidence.completeness).not.toBe('complete')
  expect(evidence.pages[0]).toMatchObject({ page: 1, status: 'failed' })
  expect(evidence.pages[0]).not.toHaveProperty('raw')
  expect(evidence.unfinished).toEqual([{ source: 'queryList', rdjb: null, page: 1 }])
  expect(evidence.failureReason).toBeTruthy()
  expect(done.result.counts.noRecord).toBe(0)
  expect(done.result.collection.complete).toBe(3)
}, 65_000)

postgresTest('later-page timeout exhausts bounded retries, retains 50 rows and the actual unfinished page', async () => {
  await upstream()
  reply = (s, r, n) => {
    if (s === 'businessList' && r === '3' && n === 2) throw new DOMException('issue299 upstream timeout', 'TimeoutError')
    return normalReply(s, r, n)
  }
  const done = await finish((await submit()).jobId)
  const entry = (await queries()).find(e => e.query.interface === 'business_list' && e.query.rdjb === '3')
  expect(entry.query.status).toBe('partial')
  expect(entry.relations).toHaveLength(50)
  const evidence = done.result.collection.positions.find((slot: { rdjb: string }) => slot.rdjb === '3')
  expect(evidence).toMatchObject({ declaredTotal: 51, requestCount: 4, unfinished: [{ page: 2 }], failureReason: 'issue299 upstream timeout' })
  expect(evidence.pages[1].error.code).toBe('timeout')
  expect(done.result.collection.partial).toBe(1)
  expect(backoffs).toEqual([1000, 3000])
}, 65_000)

postgresTest('network retry and subsequent pages keep the submission credential snapshot after replacement', async () => {
  await upstream()
  let failures = 0
  reply = async (s, r, n) => {
    await setCookie('session=issue299-replacement')
    if (s === 'businessList' && r === '3' && n === 2 && failures++ === 0) throw new Error('issue299 transient network error')
    return normalReply(s, r, n)
  }
  const done = await finish((await submit()).jobId)
  expect(done.result.relations).toBe(51)
  expect(calls).toHaveLength(6)
  expect(calls.every(c => c.cookie === 'session=issue299-original')).toBe(true)
  const stored = await queries()
  expect(JSON.stringify({ done, stored })).not.toMatch(/issue299-original|issue299-replacement/)
  const evidence = done.result.collection.positions.find((slot: { rdjb: string }) => slot.rdjb === '3')
  expect(evidence.requestCount).toBe(3)
  expect(backoffs).toEqual([1000])
}, 65_000)

postgresTest('fresh recollection leaves earlier complete and failed slots independently addressable', async () => {
  await upstream()
  await finish((await submit()).jobId)
  const before = await queries()
  const old = before.find(e => e.query.rdjb === '3')
  const failureId = await seedQuery({
    queriedAt: new Date(Date.now() + 1000).toISOString(), status: 'failed',
    failureReason: 'newer synthetic failure', rawResponse: 'Explicit failed response',
  })
  const retried = await finish((await submit()).jobId)
  expect(retried.result.queries).toMatchObject({ network: 4, reused: 0 })
  const after = await queries()
  expect(after.find(e => e.query.id === old.query.id)).toEqual(old)
  expect(after.find(e => e.query.id === failureId).query.failureReason).toBe('newer synthetic failure')
  expect(after.filter(e => e.query.interface === 'business_list' && e.query.rdjb === '3')).toHaveLength(3)
}, 65_000)

postgresTest('storage failure on row 51 rolls back the whole query/relation/decision batch, then retry commits', async () => {
  await upstream()
  await db.query('ALTER TABLE business.platform_business_observation ADD CONSTRAINT fixture_reject_row_51 CHECK (sequence_no <> 51)')
  try {
    const failed = await finish((await submit()).jobId)
    expect(failed.state).toBe('failed')
    expect(await queries()).toHaveLength(0)
    expect(await tableCount('platform_business_observation')).toBe(0)
    expect(await tableCount('difference_reason')).toBe(0)
    expect(await tableCount('import_receipt')).toBeGreaterThan(0)
  } finally { await db.query('ALTER TABLE business.platform_business_observation DROP CONSTRAINT fixture_reject_row_51') }
  expect((await finish((await submit()).jobId)).result.relations).toBe(51)
}, 65_000)

postgresTest('missing later-page total cannot inherit earlier metadata and masquerade as complete', async () => {
  await upstream()
  reply = (s, r, n) => s === 'businessList' && r === '3' && n === 2 ? page(s, n, 51, { maxCount: undefined }) : normalReply(s, r, n)
  const done = await finish((await submit()).jobId)
  const entry = (await queries()).find(e => e.query.rdjb === '3')
  expect(entry.query.status).toBe('partial')
  expect(entry.relations).toHaveLength(50)
  expect(done.result.collection.positions).toEqual(expect.arrayContaining([expect.objectContaining({
    interface: 'business_list', rdjb: '3', completeness: 'partial', declaredTotal: 51, unfinished: [{ source: 'businessList', rdjb: '3', page: 2 }],
  })]))
}, 65_000)

postgresTest('a changed later page becomes a new observation without replacing the original rows', async () => {
  await upstream()
  await finish((await submit()).jobId)
  const original = (await queries()).find(e => e.query.rdjb === '3')
  reply = (s, r, n) => s === 'businessList' && r === '3' && n === 2
    ? page(s, n, 51, { pageSet: [{ id: 'DIFFERENT', qymc: '不同记录', tyshxydm: USCC }] })
    : normalReply(s, r, n)
  const retry = await finish((await submit()).jobId)
  expect(retry.result.queries).toMatchObject({ network: 4, reused: 0 })
  expect((await queries()).find(e => e.query.id === original.query.id)).toEqual(original)
  const latest = (await queries()).find(e => e.query.rdjb === '3' && e.query.id !== original.query.id)
  expect(latest.relations[50]).toMatchObject({ sequenceNo: 51, relationKey: 'DIFFERENT', nameRaw: '不同记录' })
}, 65_000)

postgresTest('four failed slots remain four failed collection slots through public task list and detail, while report targets stay one', async () => {
  await upstream(); upstreamStatus = 400; reply = () => 'synthetic upstream failure'
  const job = await submit(), done = await finish(job.jobId)
  expect(done.result.collection).toMatchObject({ complete: 0, partial: 0, failed: 4, unknown: 0 })
  const detail = await api(`/api/task-center/${job.jobId}`)
  expect(detail.outcome).toBeNull()
  expect(detail.reconcile).toMatchObject({ targets: 1, needsReview: 0, queryFailed: 1 })
  expect(detail.reconcileCollection).toEqual({ complete: 0, partial: 0, failed: 4, unknown: 0, unfinished: 4, positions: [
    { source: 'businessList', rdjb: '1', page: 1 }, { source: 'businessList', rdjb: '2', page: 1 },
    { source: 'businessList', rdjb: '3', page: 1 }, { source: 'queryList', rdjb: null, page: 1 },
  ], positionsTruncated: false })
  const list = await api('/api/task-center?tab=sme-roster&group=platform')
  expect(list.rows.find((t: { id: string }) => t.id === job.jobId).reconcileCollection).toEqual(detail.reconcileCollection)
  expect(calls).toHaveLength(4)
}, 65_000)

async function setJobResult(id: string, result: object) {
  await db.query('UPDATE business.job SET result = $1 WHERE id = $2', [JSON.stringify(result), id])
}

async function getJobResult(id: string) {
  return (await db.query<{ result: string }>('SELECT result FROM business.job WHERE id = $1', [id])).rows[0]?.result
}

async function historicalSummaryJob() {
  const id=newJobId(),result={counts:{total:1,needsReview:1,queryFailed:0,notQueried:0},collection:{complete:4,partial:0,failed:0,unknown:0,positions:Array.from({length:4},()=>({unfinished:[]}))}}
  await db.query(`
    INSERT INTO business.job (id,kind,state,params,progress,result,created_at)
    VALUES ($1,'reconcile','done','{"titles":["specialized_sme"]}','{"done":1,"total":1}',$2,'2026-06-01T00:00:00Z')
  `, [id, JSON.stringify(result)])
  return {job:{jobId:id},done:{result}}
}

postgresTest('historical task reports without collection stay explicitly unknown through public list and detail', async () => {
  await upstream()
  const { job, done } = await historicalSummaryJob()
  const { collection: _collection, ...historicalReport } = done.result
  await setJobResult(job.jobId, historicalReport)
  const detail = await api(`/api/task-center/${job.jobId}`)
  expect(detail.outcome).toBeNull()
  expect(detail.reconcile).toMatchObject({ targets: 1, needsReview: 1 })
  expect(detail.reconcileCollection).toEqual({ complete: null, partial: null, failed: null, unknown: null, unfinished: null, positions: [], positionsTruncated: false })
  expect((await api('/api/task-center?tab=sme-roster&group=platform')).rows.find((t: { id: string }) => t.id === job.jobId).reconcileCollection).toEqual(detail.reconcileCollection)
})

postgresTest('task summary bounds locations to 50 while retaining the actual unfinished total and excludes page raw', async () => {
  await upstream()
  const {job,done}= await historicalSummaryJob()
  await setJobResult(job.jobId, { ...done.result, raw: 'PRIVATE_RAW'.repeat(100000), collection: {
    complete: 0, partial: 0, failed: 61, unknown: 0,
    positions: Array.from({ length: 61 }, (_, index) => ({ unfinished: [{ source: 'businessList', rdjb: '3', page: index + 1 }], pages: [{ raw: 'PRIVATE_PAGE_RAW' }] })),
  } })
  const detail = await api(`/api/task-center/${job.jobId}`)
  expect(detail.outcome).toBeNull()
  expect(detail.reconcile).toMatchObject({ targets: 1, needsReview: 1 })
  expect(detail.reconcileCollection).toMatchObject({ complete: 0, failed: 61, unfinished: 61, positionsTruncated: true })
  expect(detail.reconcileCollection.positions).toHaveLength(50)
  expect(detail.reconcileCollection.positions[0]).toEqual({ source: 'businessList', rdjb: '3', page: 1 })
  expect(detail.reconcileCollection.positions[49]).toEqual({ source: 'businessList', rdjb: '3', page: 50 })
  expect(JSON.stringify(detail)).not.toContain('PRIVATE_')
  expect(JSON.stringify(detail).length).toBeLessThan(12000)
  expect((await api('/api/task-center?tab=sme-roster&group=platform')).rows.find((t: { id: string }) => t.id === job.jobId).reconcileCollection).toEqual(detail.reconcileCollection)
})

postgresTest('malformed historical collection scalars stay unknown without transporting nested raw objects', async () => {
  await upstream()
  const {job,done}= await historicalSummaryJob()
  await setJobResult(job.jobId, { ...done.result, collection: {
    complete: { raw: 'PRIVATE_NESTED_RAW'.repeat(100000) }, partial: 0, failed: 0, unknown: 0,
    positions: [{ unfinished: [{ source: 'queryList', rdjb: null, page: { raw: 'PRIVATE_PAGE_RAW'.repeat(100000) } }] }],
  } })
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
    nativeFetch(`${baseUrl}/api/task-center/${id}`), nativeFetch(`${baseUrl}/api/task-center?tab=sme-roster&group=platform`),
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

postgresTest('historical malformed collection matrix stays unknown through public list and detail without filtering bad entries into completion', async () => {
  await upstream()
  const {job,done}= await historicalSummaryJob()
  for (const { name, collection } of invalidHistoricalCollections) {
  await setJobResult(job.jobId, { ...done.result, collection })
  const before = await getJobResult(job.jobId)
  const detail = await publicSummaryPair(job.jobId)
  expect(detail.reconcileCollection, name).toEqual(unknownCollection)
  expect(detail.outcome).toBeNull()
  expect(detail.reconcile).toMatchObject({ targets: 1, needsReview: 1 })
  expect(await getJobResult(job.jobId)).toEqual(before)
  }
})

postgresTest.each([
  { name: 'empty positions', collection: { complete: 0, partial: 0, failed: 0, unknown: 0, positions: [] } },
  { name: 'four complete slots', collection: { ...originalCollection, positions: emptySlots } },
])('only validated $name report zero unfinished ranges through public list and detail', async ({ collection }) => {
  await upstream()
  const {job,done}= await historicalSummaryJob()
  await setJobResult(job.jobId, { ...done.result, collection })
  const detail = await publicSummaryPair(job.jobId)
  const { positions: _positions, ...counts } = collection
  expect(detail.reconcileCollection).toEqual({ ...counts, unfinished: 0, positions: [], positionsTruncated: false })
  expect(detail.outcome).toBeNull()
  expect(detail.reconcile).toMatchObject({ targets: 1, needsReview: 1 })
})

postgresTest.each([50, 51])('validated %i ranges preserve the full count and at most 50 scopes through public list and detail', async count => {
  await upstream()
  const {job,done}= await historicalSummaryJob()
  await setJobResult(job.jobId, { ...done.result, collection: {
    complete: 0, partial: 1, failed: 0, unknown: 0,
    positions: [{ unfinished: Array.from({ length: count }, (_, index) => ({ ...pendingRange, page: index + 1 })) }],
  } })
  const detail = await publicSummaryPair(job.jobId)
  expect(detail.reconcileCollection).toMatchObject({ complete: 0, partial: 1, unfinished: count, positionsTruncated: count > 50 })
  expect(detail.reconcileCollection?.positions).toHaveLength(50)
  expect(detail.reconcileCollection?.positions[49]).toEqual({ ...pendingRange, page: 50 })
  expect(detail.outcome).toBeNull()
  expect(detail.reconcile).toMatchObject({ targets: 1, needsReview: 1 })
})
