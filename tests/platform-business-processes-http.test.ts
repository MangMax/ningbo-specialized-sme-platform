import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp, createRouter, toNodeListener, defineEventHandler, readBody, setHeader, setResponseStatus, getQuery, getRouterParam, getHeader, createError } from 'h3'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { sql } from 'drizzle-orm'
import { schema, useDb } from '../db'
import { handleRosterImportRequest } from '../server/utils/roster-import-http'
import { whenIdle } from '../server/utils/job-runner'
import type { RosterImportPlatformQuery, RosterImportRequest } from '../lib/roster-import-client'

const dir = mkdtempSync(join(tmpdir(), 'business-processes-http-'))
const dbPath = join(dir, 'business.sqlite')
vi.stubEnv('NUXT_DB_PATH', dbPath)
const db = useDb({ dbPath })
const token = 'synthetic-business-process-token'
let server: ReturnType<typeof createServer>, base: string

function businessQuery(time: string, raw: Record<string, unknown>, rdjb = '2', key = '91330211255994457P'): RosterImportPlatformQuery {
  return {
    interface: 'business_list',
    queryKey: key,
    rdjb,
    queriedAt: time,
    status: 'success',
    relations: [{ sequenceNo: 1, relationKey: typeof raw.id === 'string' ? raw.id : null, usccRaw: typeof raw.tyshxydm === 'string' ? raw.tyshxydm : null, nameRaw: typeof raw.qymc === 'string' ? raw.qymc : null, rawFields: raw }],
  }
}
function applyQuery(time: string, raw: Record<string, unknown>, key = '91330211255994457P'): RosterImportPlatformQuery {
  return {
    interface: 'apply_list',
    queryKey: key,
    queriedAt: time,
    status: 'success',
    relations: [{ sequenceNo: 1, relationKey: typeof raw.id === 'string' ? raw.id : null, rawFields: raw }],
  }
}
function request(key: string, queries: RosterImportPlatformQuery[]): RosterImportRequest {
  return { idempotencyKey: key, sourceKind: 'platform_archive', sourceIdentity: 'tests/business-processes', payload: { platformQueries: queries } }
}
async function post(path: string, body: unknown) {
  const response = await fetch(base + path, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { http: response.status, ...(await response.json() as any) }
}
async function get(path: string) {
  const response = await fetch(base + path)
  return { http: response.status, ...(await response.json() as any) }
}
function addTitleScopes(queryKey: string, queriedAt: string, values: string[]) {
  const query = db.select().from(schema.platformQuery).all().find(row => row.queryKey === queryKey && row.queriedAt === queriedAt)!
  for (const rdjb of values) db.insert(schema.platformQueryTitleScope).values({ queryId: query.id, rdjb }).onConflictDoNothing().run()
}

beforeAll(async () => {
  vi.stubEnv('NUXT_API_TOKEN', token)
  for (const [key, value] of Object.entries({ defineEventHandler, readBody, setHeader, setResponseStatus, getQuery, getRouterParam, getHeader, createError })) vi.stubGlobal(key, value)
  vi.doMock('@nuxtjs/mcp-toolkit/server', () => ({ defineMcpTool: (value: unknown) => value }))
  const importRoute = defineEventHandler(async event => {
    const out = await handleRosterImportRequest('commit', {
      method: 'POST', headers: { authorization: getHeader(event, 'authorization') }, body: await readBody(event),
    }, { db, apiToken: token })
    setResponseStatus(event, out.status)
    for (const [name, value] of Object.entries(out.headers)) setHeader(event, name, value)
    return out.body
  })
  const listRoute = (await import('../server/api/platform/business-processes.get')).default
  const detailRoute = (await import('../server/api/platform/business-processes/[recordId].get')).default
  const router = createRouter()
    .post('/api/roster/import/commit', importRoute)
    .get('/api/platform/business-processes', listRoute)
    .get('/api/platform/business-processes/:recordId', detailRoute)
  server = createServer(toNodeListener(createApp().use(router)))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}, 60000)

afterAll(async () => {
  // Archive commits can enqueue candidate jobs; let the serial runner finish before
  // closing the isolated database, otherwise the queue drains against a closed handle.
  await whenIdle()
  if (server) await new Promise<void>(resolve => server.close(() => resolve()))
  vi.unstubAllGlobals(); vi.unstubAllEnvs(); db.$client.close(); rmSync(dir, { recursive: true, force: true })
})

it('filters by enterprise, 办理编号, explicit title scope, 事项, year, status and batch without raw JSON', async () => {
  const enterpriseA = db.insert(schema.enterprise).values({ name: '甲办理企业', nameNorm: '甲办理企业', usccNorm: '91330211255994457P' }).returning().get()
  const enterpriseB = db.insert(schema.enterprise).values({ name: '乙办理企业', nameNorm: '乙办理企业', usccNorm: '91330211255994458Q' }).returning().get()
  const rawA = { id: 'SQ-B-A', qymc: '甲办理企业', tyshxydm: enterpriseA.usccNorm, sblx: '复核', year: 2023, sqsj: '2023-02-01 09:00:00', cszt: '终审通过', whpc: '2023-2', personuuid: '第三批', szsfmc: '浙江省', secretRaw: 'UNEXPOSED_BUSINESS_RAW' }
  const rawB = { id: 'SQ-B-B', qymc: '乙办理企业', tyshxydm: enterpriseB.usccNorm, sblx: '申请', year: 2022, sqsj: '2022-03-01 09:00:00', cszt: '待审核', whpc: '2022-1' }
  const rawApply = { id: 'SQ-B-A', qymc: '甲办理企业', tyshxydm: enterpriseA.usccNorm, sblx: '申请', year: 2024 }
  const first = await post('/api/roster/import/commit', request('seed-business', [businessQuery('2026-10-01T00:00:00Z', rawA), businessQuery('2026-10-01T00:00:01Z', rawB, '1', enterpriseB.usccNorm!), applyQuery('2026-10-01T00:00:02Z', rawApply)]))
  expect(first.http).toBe(200); expect(first.status).toBe('committed')
  addTitleScopes(enterpriseB.usccNorm!, '2026-10-01T00:00:01Z', ['3'])

  const all = await get('/api/platform/business-processes')
  expect(all.http).toBe(200)
  const keys = all.rows.map((row: any) => row.record.platformKey).sort()
  expect(keys).toEqual(['SQ-B-A', 'SQ-B-B'])
  expect(JSON.stringify(all)).not.toContain('UNEXPOSED_BUSINESS_RAW')

  const recordA = all.rows.find((row: any) => row.record.platformKey === 'SQ-B-A')
  expect(recordA).toMatchObject({
    kind: 'record',
    record: { interface: 'business_list' },
    matchedVersion: { declareKind: 'review', businessYear: 2023, status: '终审通过', batch: '2023-2', awardBatchLabel: '第三批', province: '浙江省' },
    versionCount: 1,
    observationCount: 1,
    titleScopes: ['2'],
  })
  expect(recordA.enterpriseIds).toEqual([enterpriseA.id])
  const recordB = all.rows.find((row: any) => row.record.platformKey === 'SQ-B-B')
  expect(recordB.titleScopes).toEqual(['1', '3'])

  expect((await get('/api/platform/business-processes?platformKey=SQ-B-B')).rows.map((row: any) => row.record.platformKey)).toEqual(['SQ-B-B'])
  expect((await get('/api/platform/business-processes?rdjb=3')).rows.map((row: any) => row.record.platformKey)).toEqual(['SQ-B-B'])
  expect((await get('/api/platform/business-processes?rdjb=2')).rows.map((row: any) => row.record.platformKey)).toEqual(['SQ-B-A'])
  expect((await get('/api/platform/business-processes?declareKind=review')).rows.map((row: any) => row.record.platformKey)).toEqual(['SQ-B-A'])
  expect((await get('/api/platform/business-processes?year=2022')).rows.map((row: any) => row.record.platformKey)).toEqual(['SQ-B-B'])
  expect((await get('/api/platform/business-processes?status=待审核')).rows.map((row: any) => row.record.platformKey)).toEqual(['SQ-B-B'])
  expect((await get('/api/platform/business-processes?batch=2023-2')).rows.map((row: any) => row.record.platformKey)).toEqual(['SQ-B-A'])
  expect((await get('/api/platform/business-processes?q=甲办理')).rows.map((row: any) => row.record.platformKey)).toEqual(['SQ-B-A'])
  expect((await get(`/api/platform/business-processes?enterpriseId=${enterpriseB.id}`)).rows.map((row: any) => row.record.platformKey)).toEqual(['SQ-B-B'])
  const page = await get('/api/platform/business-processes?pageSize=1&page=2')
  expect(page.total).toBe(2); expect(page.rows).toHaveLength(1)

  const detail = await get(`/api/platform/business-processes/${recordA.record.id}`)
  expect(detail.http).toBe(200)
  expect(detail.record).toMatchObject({ platformKey: 'SQ-B-A', interface: 'business_list' })
  expect(detail.versions).toHaveLength(1)
  expect(detail.versions[0]).toMatchObject({ businessYear: 2023, declareKind: 'review', titleScopes: ['2'] })
  expect(detail.observations).toHaveLength(1)
  expect(detail.observations[0]).toMatchObject({ titleScopes: ['2'] })
  expect(detail.counts).toMatchObject({ versions: 1, observations: 1, versionsTruncated: false, observationsTruncated: false })
  expect(JSON.stringify(detail)).not.toContain('UNEXPOSED_BUSINESS_RAW')
  expect(JSON.stringify(detail).length).toBeLessThan(600_000)
})

it('isolates missing-key observations and rejects invalid filters', async () => {
  const missing = await post('/api/roster/import/commit', request('seed-missing-business', [businessQuery('2026-10-03T00:00:00Z', { qymc: '无编号办理企业', sblx: '补录', year: '2024', cszt: '待补充' }, '2', 'name:无编号办理企业')]))
  expect(missing.status).toBe('committed')
  const isolated = await get('/api/platform/business-processes?view=isolated')
  expect(isolated.http).toBe(200)
  expect(isolated.rows.some((row: any) => row.nameRaw === '无编号办理企业' && row.identityState === 'missing_key' && row.declareKind === '补录')).toBe(true)
  expect((await get('/api/platform/business-processes')).rows.every((row: any) => row.kind === 'record')).toBe(true)

  expect((await get('/api/platform/business-processes?rdjb=9')).http).toBe(400)
  expect((await get('/api/platform/business-processes?pageSize=201')).http).toBe(400)
  expect((await get('/api/platform/business-processes?year=abc')).http).toBe(400)
  expect((await get('/api/platform/business-processes/0')).http).toBe(400)
  expect((await get('/api/platform/business-processes/999999')).http).toBe(404)
})

it('bounds detail history and observation reads explicitly', async () => {
  const raw = { id: 'SQ-B-BIG', qymc: '大量版本企业', sblx: '申请', year: 2020, cszt: '待审核', whpc: '2020-1' }
  const queries: RosterImportPlatformQuery[] = []
  for (let index = 0; index < 101; index++) {
    const queriedAt = new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString()
    queries.push(businessQuery(queriedAt, { ...raw, sqsj: `2020-01-01 00:${String(index).padStart(2, '0')}:00` }, '2', 'SQ-B-BIG'))
  }
  const saved = await post('/api/roster/import/commit', request('seed-big', queries))
  expect(saved.status).toBe('committed')
  const record = db.get<{ id: number }>(sql`select id from platform_business_record where interface = 'business_list' and platform_key = 'SQ-B-BIG'`)!
  const detail = await get(`/api/platform/business-processes/${record.id}`)
  expect(detail.http).toBe(200)
  expect(detail.counts.versions).toBe(101)
  expect(detail.counts.versionsTruncated).toBe(true)
  expect(detail.versions).toHaveLength(100)
  expect(detail.counts.observations).toBe(101)
  expect(detail.counts.observationsTruncated).toBe(false)
  expect(detail.observations).toHaveLength(101)
  expect(JSON.stringify(detail).length).toBeLessThan(900_000)

  const extra: RosterImportPlatformQuery[] = []
  for (let index = 0; index < 100; index++) {
    const queriedAt = new Date(Date.UTC(2026, 1, 1, 0, index)).toISOString()
    extra.push(businessQuery(queriedAt, raw, '2', 'SQ-B-BIG'))
  }
  const replayed = await post('/api/roster/import/commit', request('seed-big-observations', extra))
  expect(replayed.status).toBe('committed')
  const bounded = await get(`/api/platform/business-processes/${record.id}`)
  expect(bounded.counts.observations).toBe(201)
  expect(bounded.counts.observationsTruncated).toBe(true)
  expect(bounded.observations).toHaveLength(200)
  expect(JSON.stringify(bounded).length).toBeLessThan(900_000)
})
