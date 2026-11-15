import { whenIdle } from '../../../server/utils/job-runner'
import { initializeDb } from '../../../db/client'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp, createRouter, toNodeListener, getQuery, defineEventHandler, createError } from 'h3'
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useDb } from '../../../db'
import { createRosterImportClient, type RosterImportPayload } from '../../../lib/roster-import-client'
import type { RosterRecognitionsResult } from '../../../lib/roster/recognitions'
import { startRosterApi, executeNativeImport } from '../imports/fixtures/import-server'

const dir = mkdtempSync(join(tmpdir(), 'recognitions-130-'))
let db: ReturnType<typeof useDb>
let fixture = 0
let server: ReturnType<typeof createServer>, base: string
let imports: Awaited<ReturnType<typeof startRosterApi>>
let batch = 0
async function seed(payload: RosterImportPayload) {
  const result = await createRosterImportClient({ baseUrl: imports.baseUrl, token: 'synthetic-130' }).commit({
    idempotencyKey: `recognitions-130-${++batch}`, sourceKind: 'announcement',
    sourceIdentity: `synthetic/130/${batch}`, payload,
  })
  expect(result.status).toBe('committed')
  return result
}

// Observe actual SQLite materialization, including cursors, without substituting results.
function observeReads() {
  let bytes = 0, rows = 0
  const statements: string[] = []
  const size = (v: unknown): number => typeof v === 'string' ? Buffer.byteLength(v) : typeof v === 'number' ? 8
    : v && typeof v === 'object' ? Object.values(v).reduce<number>((n, x) => n + size(x), 0) : 0
  const prepare = db.$client.prepare.bind(db.$client)
  db.$client.prepare = ((...args: Parameters<typeof prepare>) => {
    const statement = prepare(...args)
    const record = (value: unknown) => { rows++; bytes += size(value) }
    for (const method of ['all', 'get'] as const) {
      const run = statement[method].bind(statement)
      Object.assign(statement, { [method]: (...params: unknown[]) => {
        statements.push(args[0]); const result = run(...params)
        if (method === 'all') for (const row of result as unknown[]) record(row)
        else if (result != null) record(result)
        return result
      } })
    }
    const iterate = statement.iterate.bind(statement)
    Object.assign(statement, { iterate: function* (...params: unknown[]) {
      statements.push(args[0]); for (const row of iterate(...params)) { record(row); yield row }
    } })
    return statement
  }) as typeof prepare
  return { snapshot: () => ({ bytes, rows, statements: [...statements] }), restore: () => { db.$client.prepare = prepare } }
}

beforeEach(async () => {
  const dbPath = join(dir, `synthetic-${++fixture}.sqlite`)
  db = initializeDb({ create: true, dbPath })
  vi.stubEnv('NUXT_DB_PATH', dbPath)
  // Complete application-open schema validation before measuring page reads.
  expect(useDb()).toBe(db)
  vi.stubGlobal('defineEventHandler', defineEventHandler)
  vi.stubGlobal('getQuery', getQuery)
  vi.stubGlobal('createError', createError)
  imports = await startRosterApi({ db, apiToken: 'synthetic-130', executeImport: executeNativeImport })
  const route = (await import('../../../server/api/roster/recognitions.get')).default
  server = createServer(toNodeListener(createApp({ debug: false }).use(createRouter().get('/api/roster/recognitions', route))))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/roster/recognitions`
})
afterEach(async () => {
  await whenIdle()
  if (server) await new Promise<void>(resolve => server.close(() => resolve()))
  if (imports) await imports.close()
  vi.unstubAllGlobals(); vi.unstubAllEnvs(); db.$client.close()
})

afterAll(() => rmSync(dir, { recursive: true, force: true }))

it('public recognition pages exclude unrelated platform archive columns and bytes', async () => {
  await seed({ announcement: {
    sourceDocument: { source: 'jxj', title: '合成首次认定' },
    records: [{ enterprise: { name: '合成甲企业' }, titleCode: 'specialized_sme', events: [
      { eventType: 'award', year: 2021, evidence: [{ sourceFile: 'synthetic/130/first.pdf', attachment: '附件一', listNo: 7, page: 3 }] },
    ] }],
  }, platformQueries: [{ interface: 'business_list', queryKey: 'synthetic-archive', queriedAt: '2026-10-20', status: 'partial',
    rawResponse: 'synthetic'.repeat(32768), relations: [{ sequenceNo: 1, sourceText: 'synthetic'.repeat(32768), rawFields: { original: 'synthetic'.repeat(32768) } }],
  }], exportSnapshot: { titleCode: 'innovative_sme', year: 2026, collectedOn: '2026-10-20', originalFilename: 'synthetic.xlsx', sha256: 'a'.repeat(64),
    rows: [{ sourceRowNo: 1, nameRaw: '无关合成企业', rawFields: { original: 'synthetic'.repeat(32768) } }],
  } })
  let expected: RosterRecognitionsResult | undefined
  let original: ReturnType<ReturnType<typeof observeReads>['snapshot']> | undefined
  for (const factor of [1, 2, 5]) {
    if (factor > 1) for (let n = factor === 2 ? 1 : 2; n < factor; n++) await seed({
      platformQueries: [{ interface: 'business_list', queryKey: `synthetic-growth-${n}`, queriedAt: '2026-10-20', status: 'partial',
        rawResponse: 'synthetic'.repeat(32768), relations: [{ sequenceNo: 1, sourceText: 'synthetic'.repeat(32768), rawFields: { original: 'synthetic'.repeat(32768) } }],
      }], exportSnapshot: { titleCode: 'innovative_sme', year: 2026, collectedOn: '2026-10-20', originalFilename: `synthetic-${n}.xlsx`, sha256: String(n).repeat(64),
        rows: [{ sourceRowNo: 1, nameRaw: '无关合成企业', rawFields: { original: 'synthetic'.repeat(32768) } }],
      },
    })
    await whenIdle()
    const meter = observeReads()
    try {
      const response = await fetch(base + '?pageSize=1')
      expect(response.status).toBe(200)
      const out = await response.json() as RosterRecognitionsResult
      expect(out).toMatchObject({ counts: { titlePairs: 1, enterprises: 1 }, rows: [{ name: '合成甲企业', firstYear: 2021, status: 'confirmed', evidence: [{ sourceFile: 'synthetic/130/first.pdf', attachment: '附件一', listNo: 7, page: 3 }] }] })
      const read = meter.snapshot()
      expect(read.bytes).toBeLessThan(64 * 1024)
      expect(read.statements.join('\n')).not.toMatch(/raw_response|collection_evidence|raw_fields|source_text/i)
      console.info('recognitions-130 archive factor/read bytes/rows', factor, read.bytes, read.rows)
      if (expected) { expect(out).toEqual(expected); expect(read).toEqual(original) }
      else { expected = out; original = read }
    } finally { meter.restore() }
  }
}, 30000)

it('public recognition filtering preserves cross-source first awards, pending reasons and both count units', async () => {
  const receipt = await seed({ announcement: { sourceDocument: { source: 'jxj', title: '合成跨来源首次认定' }, records: [
    { enterprise: { name: 'A合成企业', district: '鄞州区' }, titleCode: 'specialized_sme', events: [
      { eventType: 'award', year: 2022, decidedYear: 2023, evidence: [{ sourceFile: 'synthetic/new.pdf', listNo: 1, page: 8 }] },
      { eventType: 'review', year: 2022, decidedYear: 2024, reviewOutcome: 'failed' },
      { eventType: 'award', year: 2025, evidence: [{ sourceFile: 'synthetic/reaward.pdf', listNo: 1, page: 9 }] },
    ] },
    { enterprise: { name: 'A合成企业' }, titleCode: 'specialized_sme', source: 'miit', events: [
      { eventType: 'award', year: 2019, decidedYear: 2021, evidence: [
        { sourceFile: 'synthetic/first.pdf', attachment: '附件二', listNo: 12, page: 5 },
        { sourceFile: 'synthetic/first.xlsx', attachment: 'sheet', listNo: 13 },
        { sourceFile: 'synthetic/second.pdf', attachment: '附件三', listNo: 14, page: 6 },
      ] },
      { eventType: 'award', year: 2021, batchSeq: 2, evidence: [{ sourceFile: 'synthetic/same-year.pdf', listNo: 99 }] },
    ] },
    { enterprise: { name: 'A合成企业' }, titleCode: 'innovative_sme', events: [
      { eventType: 'award', year: null, decidedYear: 2022, evidence: [{ sourceFile: 'synthetic/innovative.pdf', listNo: 4, page: 7 }] },
    ] },
    { enterprise: { name: 'B合成企业' }, titleCode: 'specialized_sme', events: [{ eventType: 'award', year: 2021 }] },
    { enterprise: { name: 'C合成企业' }, titleCode: 'specialized_sme', events: [
      { eventType: 'award', year: null }, { eventType: 'award', year: 2024, evidence: [{ sourceFile: 'synthetic/dated.pdf' }] },
    ] },
    { enterprise: { name: 'D合成企业' }, titleCode: 'specialized_sme', events: [{ eventType: 'award', year: null }] },
    { enterprise: { name: '非认定合成企业' }, titleCode: 'little_giant', events: [
      { eventType: 'review', year: 2010, decidedYear: 2013, reviewOutcome: 'passed' },
      { eventType: 'maintain', year: 2009 }, { eventType: 'nurture', year: 2008 },
    ] },
  ] } })
  const read = async (query = '') => {
    const response = await fetch(base + query)
    expect(response.status).toBe(200)
    return response.json() as Promise<RosterRecognitionsResult>
  }
  const all = await read('?pageSize=50')
  expect(all.counts).toEqual({ titlePairs: 5, enterprises: 4, titles: { little_giant: 0, specialized_sme: 4, innovative_sme: 1 } })
  expect(all.rows.map(r => `${r.titleCode}/${r.name}`)).toEqual([
    'specialized_sme/A合成企业', 'specialized_sme/B合成企业', 'specialized_sme/C合成企业', 'specialized_sme/D合成企业', 'innovative_sme/A合成企业',
  ])
  const first = all.rows[0]!
  expect(first).toMatchObject({ firstYear: 2021, source: 'miit', status: 'confirmed', pendingReason: null, district: '鄞州区', undatedAwardIds: [], evidence: [
    { sourceFile: 'synthetic/first.pdf', attachment: '附件二', listNo: 12, page: 5 },
    { sourceFile: 'synthetic/first.xlsx', attachment: 'sheet', listNo: 13, page: null },
    { sourceFile: 'synthetic/second.pdf', attachment: '附件三', listNo: 14, page: 6 },
  ] })
  const written = receipt.items.filter(item => item.kind === 'record_event').map(item => item.detail?.events as number[])
  expect(first.firstEventId).toBe(written[1]![0])
  expect(all.rows[2]).toMatchObject({ firstYear: 2024, status: 'pending', pendingReason: 'undated_award' })
  expect(all.rows[2]!.undatedAwardIds).toEqual([written[4]![0]])
  expect(all.rows[3]).toMatchObject({ firstYear: null, firstEventId: null, source: null, status: 'pending', pendingReason: 'no_dated_award', evidence: [] })
  expect(all.rows[1]).toMatchObject({ firstYear: 2021, status: 'pending', pendingReason: 'no_evidence', evidence: [] })
  expect(all.rows[4]).toMatchObject({ firstYear: 2022, status: 'confirmed' })
  expect((await read('?title=specialized_sme&year=2021&status=pending')).rows.map(r => r.name)).toEqual(['B合成企业'])
  expect((await read('?title=innovative_sme&year=2021')).counts).toMatchObject({ titlePairs: 0, enterprises: 0 })
  expect((await read('?status=pending&year=2021&year=2024')).counts).toMatchObject({ titlePairs: 2, enterprises: 2 })
  expect((await read('?title=innovative_sme&title=specialized_sme&status=confirmed')).counts).toMatchObject({ titlePairs: 2, enterprises: 1 })
  const pages = await Promise.all([1, 2, 3, 4, 5].map(page => read(`?pageSize=1&page=${page}`)))
  expect(pages.flatMap(p => p.rows)).toEqual(all.rows)
  expect(pages.every(p => JSON.stringify(p.counts) === JSON.stringify(all.counts))).toBe(true)
  expect(await read('?pageSize=1&page=999')).toMatchObject({ rows: [], counts: all.counts, page: 999, pageSize: 1 })
  for (const query of ['?title=invalid', '?status=invalid']) expect((await fetch(base + query)).status).toBe(400)
})

it('public deep pages hydrate only selected evidence and keep the cross-title district fallback', async () => {
  const largeAttachment = 'synthetic'.repeat(8192)
  await seed({ announcement: { sourceDocument: { source: 'jxj', title: '合成分页出处' }, records: [
    { enterprise: { name: 'A属地回退合成企业' }, titleCode: 'innovative_sme', events: [] },
    { enterprise: { name: 'A属地回退合成企业', district: '余姚市' }, titleCode: 'specialized_sme', events: [{ eventType: 'award', year: 2020 }] },
    { enterprise: { name: 'A属地回退合成企业', district: '鄞州区' }, titleCode: 'little_giant', events: [{ eventType: 'award', year: 2021 }] },
    ...Array.from({ length: 60 }, (_, n) => ({ enterprise: { name: `B${String(n).padStart(3, '0')}合成企业` }, titleCode: 'innovative_sme', events: [
      { eventType: 'award' as const, year: 2022, evidence: [{ sourceFile: 'synthetic/130/paged.pdf', attachment: n === 0 || n === 59 ? '附件一' : largeAttachment, listNo: n + 1, page: n + 1 }] },
    ] })),
  ] } })
  await whenIdle()
  const meter = observeReads()
  try {
    for (const page of [1, 60, 61]) {
      const response = await fetch(base + `?title=innovative_sme&pageSize=1&page=${page}`)
      expect(response.status).toBe(200)
      const out = await response.json() as RosterRecognitionsResult
      expect(out.counts).toEqual({ titlePairs: 60, enterprises: 60, titles: { little_giant: 0, specialized_sme: 0, innovative_sme: 60 } })
      if (page <= 60) expect(out.rows).toMatchObject([{ name: page === 1 ? 'B000合成企业' : 'B059合成企业', evidence: [{ attachment: '附件一', listNo: page, page }] }])
      else expect(out.rows).toEqual([])
    }
    expect(meter.snapshot().bytes).toBeLessThan(64 * 1024)
  } finally { meter.restore() }
  const large = await (await fetch(base + '?title=innovative_sme&pageSize=1&page=2')).json() as RosterRecognitionsResult
  expect(large.rows[0]!.evidence).toEqual([{ sourceFile: 'synthetic/130/paged.pdf', attachment: largeAttachment, listNo: 2, page: 2 }])
  const fallback = await (await fetch(base + '?title=little_giant')).json() as RosterRecognitionsResult
  expect(fallback.rows).toMatchObject([{ name: 'A属地回退合成企业', district: '余姚市' }])
  for (const pageSize of [20, 50]) {
    const out = await (await fetch(base + `?title=innovative_sme&pageSize=${pageSize}`)).json() as RosterRecognitionsResult
    expect(out.rows).toHaveLength(pageSize)
    expect(out.counts.titlePairs).toBe(60)
    expect(out.rows.map(row => row.evidence[0]!.listNo)).toEqual(Array.from({ length: pageSize }, (_, n) => n + 1))
  }
}, 30000)

it('public first recognition preserves cross-source awards, effective years and every selected evidence pointer', async () => {
  const committed = await seed({ announcement: { sourceDocument: { source: 'jxj', title: '首认共享计算合成历史' }, records: [
    { enterprise: { name: 'A跨来源合成企业' }, titleCode: 'little_giant', source: 'miit', events: [
      { eventType: 'award', year: 2019, decidedYear: 2021, evidence: [
        { sourceFile: 'synthetic/130/first.pdf', attachment: '附件一', listNo: 4, page: 3 },
        { sourceFile: 'synthetic/130/second.pdf', attachment: '附件二', listNo: 8, page: 5 },
      ] },
    ] },
    { enterprise: { name: 'A跨来源合成企业' }, titleCode: 'little_giant', events: [
      { eventType: 'award', year: 2021 },
      { eventType: 'review', year: 2021, decidedYear: 2024, reviewOutcome: 'failed' },
      { eventType: 'award', year: 2025 },
      { eventType: 'maintain', year: 2010 }, { eventType: 'nurture', year: 2009 },
    ] },
    { enterprise: { name: 'B缺出处合成企业' }, titleCode: 'little_giant', events: [
      { eventType: 'award', year: 2020, decidedYear: 2023 },
    ] },
    { enterprise: { name: 'C仅复核合成企业' }, titleCode: 'little_giant', events: [
      { eventType: 'review', year: 2018, decidedYear: 2021, reviewOutcome: 'passed' },
    ] },
  ] } })
  const response = await fetch(base + '?title=little_giant')
  expect(response.status).toBe(200)
  const out = await response.json() as RosterRecognitionsResult
  expect(out.counts).toEqual({ titlePairs: 2, enterprises: 2,
    titles: { little_giant: 2, specialized_sme: 0, innovative_sme: 0 } })
  expect(out.rows).toMatchObject([
    { name: 'A跨来源合成企业', firstYear: 2021, source: 'miit', status: 'confirmed', pendingReason: null,
      undatedAwardIds: [], evidence: [
        { sourceFile: 'synthetic/130/first.pdf', attachment: '附件一', listNo: 4, page: 3 },
        { sourceFile: 'synthetic/130/second.pdf', attachment: '附件二', listNo: 8, page: 5 },
      ] },
    { name: 'B缺出处合成企业', firstYear: 2023, source: 'jxj', status: 'pending', pendingReason: 'no_evidence', evidence: [] },
  ])
  const firstRecord = committed.items.find(item => item.kind === 'record_event' && item.ok)!
  const [firstAwardId] = firstRecord.detail!.events as number[]
  expect(out.rows[0]!.firstEventId).toBe(firstAwardId)
  const filtered = await (await fetch(base + '?title=little_giant&year=2021&status=confirmed&pageSize=1')).json() as RosterRecognitionsResult
  expect(filtered.rows).toEqual([out.rows[0]])
  expect(filtered.counts).toEqual({ titlePairs: 1, enterprises: 1,
    titles: { little_giant: 1, specialized_sme: 0, innovative_sme: 0 } })
})

it('public pending reasons retain undated-only and mixed awards ahead of missing evidence', async () => {
  const committed = await seed({ announcement: { sourceDocument: { source: 'jxj', title: '缺年合成历史' }, records: [
    { enterprise: { name: 'A全缺年合成企业' }, titleCode: 'specialized_sme', events: [
      { eventType: 'award', year: null },
    ] },
    { enterprise: { name: 'B部分缺年合成企业' }, titleCode: 'specialized_sme', events: [
      { eventType: 'award', year: 2022 }, { eventType: 'award', year: null },
    ] },
  ] } })
  const records = committed.items.filter(item => item.kind === 'record_event' && item.ok)
  expect(records).toHaveLength(2)
  const [undated] = records[0]!.detail!.events as number[]
  const [dated, mixedUndated] = records[1]!.detail!.events as number[]
  const response = await fetch(base + '?status=pending')
  expect(response.status).toBe(200)
  const out = await response.json() as RosterRecognitionsResult
  expect(out.rows).toMatchObject([
    { firstYear: null, firstEventId: null, source: null, status: 'pending',
      pendingReason: 'no_dated_award', undatedAwardIds: [undated], evidence: [] },
    { firstYear: 2022, firstEventId: dated, source: 'jxj', status: 'pending',
      pendingReason: 'undated_award', undatedAwardIds: [mixedUndated], evidence: [] },
  ])
  expect(out.rows).toHaveLength(2)
  expect(out.counts.titlePairs).toBe(2)
  expect(out.counts.enterprises).toBe(2)
})
