import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp, createRouter, toNodeListener, defineEventHandler, setHeader, getQuery, getRouterParam, createError } from 'h3'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { sql } from 'drizzle-orm'
import { schema, useDb } from '../db'
import { ensurePlatformObservation } from '../server/utils/platform-business-record'

const dir = mkdtempSync(join(tmpdir(), 'recognized-directory-http-'))
const dbPath = join(dir, 'recognized.sqlite')
vi.stubEnv('NUXT_DB_PATH', dbPath)
const db = useDb({ dbPath })
let server: ReturnType<typeof createServer>, base: string

interface SeedOptions {
  key: string
  rdjb: string
  at: string
  raw: Record<string, unknown>
  scopes?: string[]
  enterpriseId?: number | null
  relationKey?: string | null
  interfaceName?: 'recognized_list' | 'business_list'
}

/** One archived query + original row + the typed projection the write path builds in the same transaction. */
function seed(options: SeedOptions) {
  const query = db.insert(schema.platformQuery).values({
    interface: options.interfaceName ?? 'recognized_list',
    queryKey: options.key,
    rdjb: options.rdjb,
    queriedAt: options.at,
    status: 'success',
  }).returning().get()
  for (const rdjb of options.scopes ?? []) db.insert(schema.platformQueryTitleScope).values({ queryId: query.id, rdjb }).onConflictDoNothing().run()
  const relation = db.insert(schema.platformRelation).values({
    queryId: query.id,
    sequenceNo: 1,
    relationKey: options.relationKey === undefined ? (typeof options.raw.id === 'string' ? options.raw.id : null) : options.relationKey,
    enterpriseId: options.enterpriseId ?? null,
    nameRaw: typeof options.raw.qymc === 'string' ? options.raw.qymc : null,
    usccRaw: typeof options.raw.tyshxydm === 'string' ? options.raw.tyshxydm : null,
    rawFields: options.raw,
  }).returning().get()
  const projection = ensurePlatformObservation(db, relation.id)
  return { query, relation, recordId: projection.recordId }
}

async function get(path: string) {
  const response = await fetch(base + path)
  return { http: response.status, cacheControl: response.headers.get('cache-control'), ...(await response.json() as any) }
}

beforeAll(async () => {
  for (const [key, value] of Object.entries({ defineEventHandler, setHeader, getQuery, getRouterParam, createError })) vi.stubGlobal(key, value)
  const listRoute = (await import('../server/api/platform/recognized-directory.get')).default
  const detailRoute = (await import('../server/api/platform/recognized-directory/[recordId].get')).default
  const router = createRouter()
    .get('/api/platform/recognized-directory', listRoute)
    .get('/api/platform/recognized-directory/:recordId', detailRoute)
  server = createServer(toNodeListener(createApp().use(router)))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}, 60000)

afterAll(async () => {
  if (server) await new Promise<void>(resolve => server.close(() => resolve()))
  vi.unstubAllGlobals(); vi.unstubAllEnvs(); db.$client.close(); rmSync(dir, { recursive: true, force: true })
})

it('filters the archived directory rows without raw JSON and reports recorded conflicts', async () => {
  const enterpriseA = db.insert(schema.enterprise).values({ name: '甲目录企业', nameNorm: '甲目录企业', usccNorm: '91330211AAAAAAAA1X' }).returning().get()
  const enterpriseB = db.insert(schema.enterprise).values({ name: '乙目录企业', nameNorm: '乙目录企业', usccNorm: '91330211BBBBBBBB2X' }).returning().get()
  const rawA = {
    id: 'DIR-1', qymc: '甲目录企业', tyshxydm: enterpriseA.usccNorm, rdjb: '2',
    rddqrq: '2027-12-31', whpcyear: '2024', whpc: '2024-2', szq: '33020000', rdxx: '原认定说明',
    secretRaw: 'UNEXPOSED_RECOGNIZED_RAW',
  }
  const first = seed({ key: enterpriseA.usccNorm!, rdjb: '2', at: '2026-10-01T00:00:00Z', raw: rawA, scopes: ['2', '3'], enterpriseId: enterpriseA.id })
  seed({ key: enterpriseA.usccNorm!, rdjb: '2', at: '2026-10-02T00:00:00Z', raw: { ...rawA, whpcyear: 2023, rdxx: '第二版认定说明' }, enterpriseId: enterpriseA.id })
  seed({
    key: enterpriseB.usccNorm!, rdjb: '1', at: '2026-10-03T00:00:00Z', enterpriseId: enterpriseB.id,
    raw: { id: 'DIR-2', qymc: '乙目录企业', tyshxydm: enterpriseB.usccNorm, rdjb: '3', rddqrq: '2028', whpc: '2023-1', szq: '33028100' },
  })
  // Same key archived under business_list stays a separate record and never merges into the directory.
  seed({
    key: '91330211AAAAAAAA1X', rdjb: '2', at: '2026-10-05T00:00:00Z', interfaceName: 'business_list', enterpriseId: enterpriseA.id,
    raw: { id: 'DIR-1', qymc: '甲目录企业', tyshxydm: enterpriseA.usccNorm, sblx: '复核', year: 2023, cszt: '终审通过', whpc: '2023-2' },
  })

  const all = await get('/api/platform/recognized-directory')
  expect(all.http).toBe(200)
  expect(all.cacheControl).toBe('no-store')
  expect(all.rows.map((row: any) => row.record.platformKey).sort()).toEqual(['DIR-1', 'DIR-2'])
  expect(JSON.stringify(all)).not.toContain('UNEXPOSED_RECOGNIZED_RAW')

  const recordA = all.rows.find((row: any) => row.record.platformKey === 'DIR-1')
  expect(recordA).toMatchObject({
    kind: 'record',
    record: { interface: 'recognized_list' },
    matchedVersion: {
      validityDateRaw: '2027-12-31', maintenanceYear: 2023, maintenanceBatch: '2024-2',
      district: '33020000', awardNote: '第二版认定说明', titleRaw: '2', nameRaw: '甲目录企业', ruleVersion: 'platform-recognized-v1',
    },
    matchedVersionCount: 2,
    versionCount: 2,
    observationCount: 2,
    latestObservationAt: '2026-10-02T00:00:00Z',
    titleScopes: ['2', '3'],
    conflicts: [],
  })
  expect(recordA.enterpriseIds).toEqual([enterpriseA.id])
  expect(recordA.enterpriseNames).toEqual(['甲目录企业'])

  const recordB = all.rows.find((row: any) => row.record.platformKey === 'DIR-2')
  expect(recordB.matchedVersion).toMatchObject({ validityDateRaw: '2028', maintenanceYear: null, maintenanceBatch: '2023-1', district: '33028100', awardNote: null, titleRaw: '3' })
  expect(recordB.titleScopes).toEqual(['1'])
  expect(recordB.conflicts).toEqual(['title_conflict'])

  expect((await get('/api/platform/recognized-directory?platformKey=DIR-2')).rows).toHaveLength(1)
  expect((await get('/api/platform/recognized-directory?rdjb=2')).rows.map((row: any) => row.record.platformKey)).toEqual(['DIR-1'])
  expect((await get('/api/platform/recognized-directory?rdjb=3')).rows.map((row: any) => row.record.platformKey)).toEqual(['DIR-1'])
  expect((await get('/api/platform/recognized-directory?rdjb=1')).rows.map((row: any) => row.record.platformKey)).toEqual(['DIR-2'])
  expect((await get('/api/platform/recognized-directory?rddqrq=2027-12-31')).rows.map((row: any) => row.record.platformKey)).toEqual(['DIR-1'])
  // Raw equality only: a prefix, a reformatted date and a numeric year never match.
  expect((await get('/api/platform/recognized-directory?rddqrq=2027')).rows).toEqual([])
  expect((await get('/api/platform/recognized-directory?rddqrq=2027-12-30')).rows).toEqual([])
  expect((await get('/api/platform/recognized-directory?whpcyear=2023')).rows.map((row: any) => row.record.platformKey)).toEqual(['DIR-1'])
  expect((await get('/api/platform/recognized-directory?whpc=2023-1')).rows.map((row: any) => row.record.platformKey)).toEqual(['DIR-2'])
  expect((await get('/api/platform/recognized-directory?szq=33028100')).rows.map((row: any) => row.record.platformKey)).toEqual(['DIR-2'])
  expect((await get('/api/platform/recognized-directory?q=甲目录')).rows.map((row: any) => row.record.platformKey)).toEqual(['DIR-1'])
  expect((await get(`/api/platform/recognized-directory?enterpriseId=${enterpriseB.id}`)).rows.map((row: any) => row.record.platformKey)).toEqual(['DIR-2'])
  const page = await get('/api/platform/recognized-directory?pageSize=1&page=2')
  expect(page.total).toBe(2); expect(page.rows).toHaveLength(1)

  const detail = await get(`/api/platform/recognized-directory/${first.recordId}`)
  expect(detail.http).toBe(200)
  expect(detail.record).toMatchObject({ platformKey: 'DIR-1', interface: 'recognized_list' })
  expect(detail.versions).toHaveLength(2)
  expect(detail.versions[0]).toMatchObject({ validityDateRaw: '2027-12-31', maintenanceYear: 2023, titleScopes: ['2'] })
  expect(detail.observations).toHaveLength(2)
  expect(detail.observations[0]).toMatchObject({ titleScopes: ['2'], titleConflict: false, correspondenceRefs: [] })
  expect(detail.counts).toMatchObject({ versions: 2, observations: 2, versionsTruncated: false, observationsTruncated: false })
  expect(JSON.stringify(detail)).not.toContain('UNEXPOSED_RECOGNIZED_RAW')
  expect(JSON.stringify(detail).length).toBeLessThan(600_000)
})

it('applies every filter to the same matched content version', async () => {
  // One record, two content versions observed under different query title scopes.
  seed({ key: 'DIR-STABLE', rdjb: '1', at: '2026-08-01T00:00:00Z', scopes: ['1'], raw: { id: 'DIR-STABLE', qymc: '分页稳定企业', rdjb: '1', whpcyear: '2024' } })
  seed({ key: 'DIR-STABLE', rdjb: '2', at: '2026-08-02T00:00:00Z', scopes: ['2'], raw: { id: 'DIR-STABLE', qymc: '分页稳定企业', rdjb: '2', whpcyear: '2025' } })

  const mismatched = await get('/api/platform/recognized-directory?rdjb=1&whpcyear=2025')
  expect(mismatched.total).toBe(0)
  expect(mismatched.rows).toEqual([])

  const matched = await get('/api/platform/recognized-directory?rdjb=2&whpcyear=2025')
  expect(matched.total).toBe(1)
  expect(matched.rows).toHaveLength(1)
  expect(matched.rows[0]).toMatchObject({
    record: { platformKey: 'DIR-STABLE' },
    matchedVersion: { maintenanceYear: 2025 },
    matchedVersionCount: 1,
  })
})

it('bounds record conflicts by record ids when one record carries many observations', async () => {
  const raw = { id: 'DIR-MANY', qymc: '大量观察企业', rdjb: '2', rddqrq: '2027-12-31' }
  for (let index = 0; index < 59; index++) {
    seed({ key: 'DIR-MANY', rdjb: '2', at: new Date(Date.UTC(2026, 6, 1, 0, index)).toISOString(), scopes: ['2'], raw })
  }
  seed({ key: 'DIR-MANY', rdjb: '2', at: '2026-07-02T00:00:00Z', scopes: ['2'], raw: { ...raw, rdjb: '3' } })

  const response = await get('/api/platform/recognized-directory?platformKey=DIR-MANY')
  expect(response.total).toBe(1)
  expect(response.rows).toHaveLength(1)
  expect(response.rows[0]).toMatchObject({
    record: { platformKey: 'DIR-MANY' },
    observationCount: 60,
    conflicts: ['title_conflict'],
  })
  // Conflicts must stay record-shaped, never echo the 60 observation rows.
  expect(JSON.stringify(response).length).toBeLessThan(10_000)
})

it('keeps conflict semantics for padded scopes and unknown row titles', async () => {
  // Whitespace in the archived scope list must not suppress a real title conflict.
  seed({ key: 'name:空白范围企业', rdjb: '1, 2', at: '2026-09-01T00:00:00Z', raw: { id: 'DIR-SPACE', qymc: '空白范围企业', rdjb: '3' } })
  const padded = await get('/api/platform/recognized-directory?platformKey=DIR-SPACE')
  expect(padded.total).toBe(1)
  expect(padded.rows[0]).toMatchObject({ record: { platformKey: 'DIR-SPACE' }, titleScopes: ['1', '2'], conflicts: ['title_conflict'] })

  // An unknown or absent row title is never a conflict, even when the scope list is non-empty.
  seed({ key: 'name:未知称号企业', rdjb: '1, 2', at: '2026-09-02T00:00:00Z', raw: { id: 'DIR-UNKNOWN', qymc: '未知称号企业', rdjb: '9' } })
  const unknown = await get('/api/platform/recognized-directory?platformKey=DIR-UNKNOWN')
  expect(unknown.rows[0]).toMatchObject({ record: { platformKey: 'DIR-UNKNOWN' }, conflicts: [] })
})

it('isolates unprojected observations and rejects invalid or cross-interface reads', async () => {
  const missing = seed({ key: 'name:无编号目录企业', rdjb: '2', at: '2026-11-01T00:00:00Z', raw: { qymc: '无编号目录企业', rddqrq: '2029-01-01' }, relationKey: null })
  expect(missing.recordId).toBeNull()
  const conflict = seed({ key: 'name:编号冲突目录企业', rdjb: '1', at: '2026-11-02T00:00:00Z', raw: { id: 'RAW-CONFLICT', qymc: '编号冲突目录企业' }, relationKey: 'REL-CONFLICT' })
  expect(conflict.recordId).toBeNull()

  const isolated = await get('/api/platform/recognized-directory?view=isolated')
  expect(isolated.http).toBe(200)
  expect(isolated.rows.map((row: any) => row.identityState).sort()).toEqual(['conflict', 'missing_key'])
  expect(isolated.rows.every((row: any) => row.kind === 'observation')).toBe(true)
  expect(isolated.rows.find((row: any) => row.nameRaw === '无编号目录企业')).toMatchObject({ contentState: 'unverifiable', titleScopes: ['2'], enterpriseId: null })
  expect((await get('/api/platform/recognized-directory')).rows.every((row: any) => row.kind === 'record')).toBe(true)

  expect((await get('/api/platform/recognized-directory?rdjb=9')).http).toBe(400)
  expect((await get('/api/platform/recognized-directory?pageSize=201')).http).toBe(400)
  expect((await get('/api/platform/recognized-directory?whpcyear=abc')).http).toBe(400)
  expect((await get('/api/platform/recognized-directory?unknown=1')).http).toBe(400)
  expect((await get('/api/platform/recognized-directory/0')).http).toBe(400)
  expect((await get('/api/platform/recognized-directory/999999')).http).toBe(404)

  const businessRecord = db.get<{ id: number }>(sql`select id from platform_business_record where interface = 'business_list' and platform_key = 'DIR-1'`)!
  expect((await get(`/api/platform/recognized-directory/${businessRecord.id}`)).http).toBe(404)
  expect((await get(`/api/platform/recognized-directory/${missing.relation.id + 100000}`)).http).toBe(404)
})

it('bounds detail history and observation reads explicitly', async () => {
  const enterprise = db.insert(schema.enterprise).values({ name: '大量目录版本企业', nameNorm: '大量目录版本企业', usccNorm: '91330211CCCCCCCC3X' }).returning().get()
  const raw = { id: 'DIR-BIG', qymc: '大量目录版本企业', tyshxydm: enterprise.usccNorm, rdjb: '2', rddqrq: '2030-01-01', whpcyear: '2024', whpc: '2024-2', szq: '33020000' }
  let recordId = 0
  for (let index = 0; index < 101; index++) {
    const at = new Date(Date.UTC(2026, 2, 1, 0, index)).toISOString()
    const seeded = seed({ key: 'DIR-BIG', rdjb: '2', at, raw: { ...raw, rdxx: `版本说明 ${index}` }, enterpriseId: enterprise.id })
    recordId = seeded.recordId!
  }
  const detail = await get(`/api/platform/recognized-directory/${recordId}`)
  expect(detail.http).toBe(200)
  expect(detail.counts.versions).toBe(101)
  expect(detail.counts.versionsTruncated).toBe(true)
  expect(detail.versions).toHaveLength(100)
  expect(detail.counts.observations).toBe(101)
  expect(detail.counts.observationsTruncated).toBe(false)
  expect(detail.observations).toHaveLength(101)
  expect(JSON.stringify(detail).length).toBeLessThan(900_000)

  for (let index = 0; index < 100; index++) {
    const at = new Date(Date.UTC(2026, 3, 1, 0, index)).toISOString()
    seed({ key: 'DIR-BIG', rdjb: '2', at, raw: { ...raw, rdxx: '版本说明 0' }, enterpriseId: enterprise.id })
  }
  const bounded = await get(`/api/platform/recognized-directory/${recordId}`)
  expect(bounded.counts.observations).toBe(201)
  expect(bounded.counts.observationsTruncated).toBe(true)
  expect(bounded.observations).toHaveLength(200)
  expect(JSON.stringify(bounded).length).toBeLessThan(900_000)
})
