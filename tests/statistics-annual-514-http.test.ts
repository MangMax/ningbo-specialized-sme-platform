import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as h3 from 'h3'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { initializeDb } from '../db/client'
import * as schema from '../db/schema'
const active = vi.hoisted(() => ({ db: null as any }))
vi.mock('@db', () => ({ useDb: () => active.db }))
const dir = mkdtempSync(join(tmpdir(), 'statistics-514-'))
const db = initializeDb({ create: true, dbPath: join(dir, 'test.sqlite') }); active.db = db
let server: ReturnType<typeof createServer>, base: string
beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-06T00:00:00Z'))
  for (const [key, value] of Object.entries(h3)) vi.stubGlobal(key, value)
  const route = (await import('../server/api/statistics/annual.get')).default
  const currentRoute = (await import('../server/api/roster/current-enterprises.get')).default
  server = createServer(h3.toNodeListener(h3.createApp().use('/api/statistics/annual', route).use('/api/roster/current-enterprises', currentRoute)))
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as any).port}/api/statistics/annual`
})
afterAll(async () => { if (server) await new Promise<void>(r => server.close(() => r())); db.$client.close(); rmSync(dir, { recursive: true, force: true }); vi.unstubAllGlobals(); vi.useRealTimers() })
async function read(query = '') { const response = await fetch(base + query); return { status: response.status, body: await response.json() } }
it('uses Shanghai evaluation metadata and rejects future or invalid scopes', async () => {
  const { body, status } = await read()
  expect(status).toBe(200)
  expect(body).toMatchObject({ evaluationDay: '2026-11-06', timeZone: 'Asia/Shanghai', ruleVersion: 'current-roster-116-v10', assessmentVersion: 'enterprise-qualification-478-v3', reconstruction: 'current_recorded_evidence', grain: 'enterprise_title', total: 0 })
  expect(body.years).toEqual([{ year: 2026, evaluationDay: '2026-11-06', titles: [
    { titleCode: 'little_giant', effective: 0, pending: 0 }, { titleCode: 'specialized_sme', effective: 0, pending: 0 }, { titleCode: 'innovative_sme', effective: 0, pending: 0 },
  ] }])
  for (const query of ['?year=2027', '?year=no', '?title=bad', '?status=bad', '?page=0', '?pageSize=201']) expect((await read(query)).status).toBe(400)
})

function enterprise(id: number) {
  db.insert(schema.enterprise).values({ id, name: `年度企业${id}`, nameNorm: `年度企业${id}`, district: id === 1 ? '大榭开发区' : null }).run()
}
function event(id: number, type: 'award' | 'review', year: number | null, decidedYear: number | null = year, outcome: 'passed' | 'failed' | null = null, title = 'specialized_sme') {
  let r = db.select().from(schema.record).all().find(r => r.enterpriseId === id && r.titleCode === title && r.source === 'jxj')
  if (!r) r = db.insert(schema.record).values({ enterpriseId: id, titleCode: title, source: 'jxj' }).returning().get()
  const e = db.insert(schema.recordEvent).values({ recordId: r.id, eventType: type, year, decidedYear, batchSeq: 1, reviewOutcome: outcome }).returning().get()
  const evidence = db.insert(schema.recordEvidence).values({ recordEventId: e.id, sourceFile: 'annual.pdf', attachment: '正式名单', listNo: id, page: 2 }).returning().get()
  return { e, evidence }
}
function validity(item: ReturnType<typeof event>, fact: Record<string, unknown>) {
  db.$client.prepare('update record_event set formal_validity=? where id=?').run(JSON.stringify({ evidenceId: item.evidence.id, sourceSha256: 'a'.repeat(64), statementPages: [2], ...fact }), item.e.id)
}
function fact(id: number, kind: string, precision: string, value: string, options: { revision?: number; status?: 'withdrawn' | 'confirmed'; factId?: number } = {}) {
  db.insert(schema.enterpriseFactRevision).values({ enterpriseId: id, factId: options.factId ?? id, revision: options.revision ?? 1, status: options.status ?? 'confirmed', fact: { kind, effective: { precision, value }, source: { reference: 'official movement', statement: '已确认事实' } }, action: 'append', actor: { type: 'agent', id: 'synthetic' }, basis: '独立核实', createdAt: '2026-11-06T00:00:00Z' }).run()
}
async function ids(year: number, status = 'effective', title = 'specialized_sme') {
  const body = (await read(`?year=${year}&status=${status}&title=${title}&pageSize=200`)).body
  const summary = body.years.find((r: any) => r.year === year)?.titles.find((r: any) => r.titleCode === title)
  expect(body.total).toBe(body.rows.length)
  if (summary) expect(summary[status]).toBe(body.total)
  return body.rows.map((r: any) => r.enterpriseId)
}
it('reconstructs literal yearly stocks through renewal failure expiry reaward and future facts without inbound restoration', async () => {
  for (let id = 1; id <= 12; id++) enterprise(id)
  // 1 renewal; 2 failure then re-award; 3 natural expiry; 4 future cancellation;
  // 5 moved out then in (v10 no repair); 6 inbound only (no grant); 7 unknown grant;
  // 8 explicit interval; 9 future linked continuation; 10 withdrawn movement;
  // 11 source drift retained; 12 coarse year exclusion.
  for (const id of [1, 2, 3, 4, 5, 10, 12]) event(id, 'award', 2022)
  event(1, 'review', 2022, 2025, 'passed')
  event(2, 'review', 2022, 2024, 'failed'); event(2, 'award', 2026)
  event(4, 'review', 2022, 2025, 'passed'); fact(4, 'cancelled', 'day', '2027-01-01')
  fact(5, 'moved_out', 'day', '2024-05-01'); fact(5, 'moved_in', 'day', '2025-01-01', { factId: 500 })
  fact(6, 'moved_in', 'day', '2023-01-01')
  event(7, 'award', null)
  validity(event(8, 'award', 2022), { interval: { validFrom: '2022-07-01', validThrough: '2024-12-31' } })
  const grant = event(9, 'award', 2022)
  validity(event(9, 'review', 2022, 2027, 'failed'), { publishedOn: '2027-03-01', continuation: 'until_this_review_results', originAwardEventId: grant.e.id })
  fact(10, 'moved_out', 'day', '2023-01-01'); fact(10, 'moved_out', 'day', '2023-01-01', { revision: 2, status: 'withdrawn' })
  validity(event(11, 'award', 2023), { interval: { validFrom: '2023-01-01', validThrough: '2028-12-31' } })
  fact(12, 'cancelled', 'year', '2024')
  // Independent hand-worked rowsets, including cutoff-closed interval and v10 expiry.
  expect(await ids(2022)).toEqual([1, 2, 3, 4, 5, 8, 9, 10, 12])
  expect(await ids(2023)).toEqual([1, 2, 3, 4, 5, 8, 9, 10, 11, 12])
  expect(await ids(2024)).toEqual([1, 3, 4, 8, 9, 10, 11])
  expect(await ids(2025)).toEqual([1, 4, 9, 11])
  expect(await ids(2026)).toEqual([1, 2, 4, 9, 11])
  for (const year of [2022, 2023, 2024, 2025, 2026]) expect(await ids(year, 'pending')).toEqual([7])
  const first = (await read('?year=2023&title=specialized_sme&pageSize=2')).body
  const second = (await read('?year=2023&title=specialized_sme&pageSize=2&page=2')).body
  expect(first.total).toBe(10); expect(second.total).toBe(10)
  expect(first.rows.map((r: any) => r.enterpriseId)).toEqual([1, 2]); expect(second.rows.map((r: any) => r.enterpriseId)).toEqual([3, 4])
  expect(first.rows[0].evidence[0]).toMatchObject({ sourceFile: 'annual.pdf', attachment: '正式名单', page: 2 })
})
it('separates historical uncertainty from current v10 diagnostics and respects Shanghai rollover', async () => {
  for (const id of [13, 14, 15]) { enterprise(id); event(id, 'award', 2025) }
  fact(13, 'cancelled', 'month', '2026-11') // overlaps today: current v10 keeps eligibility
  fact(14, 'cancelled', 'unknown', '') // genuinely unknown historical occurrence
  fact(15, 'cancelled', 'day', '2026-11-06')
  expect(await ids(2025)).toEqual([1, 4, 9, 11, 13, 15])
  expect(await ids(2025, 'pending')).toEqual([7, 14])
  expect(await ids(2026)).toEqual([1, 2, 4, 9, 11, 13, 14, 15])
  vi.setSystemTime(new Date('2026-11-06T15:59:59Z'))
  expect((await read()).body.evaluationDay).toBe('2026-11-06')
  vi.setSystemTime(new Date('2026-11-06T16:00:00Z'))
  expect((await read()).body.evaluationDay).toBe('2026-11-07')
  expect(await ids(2026)).toEqual([1, 2, 4, 9, 11, 13, 14])
  vi.setSystemTime(new Date('2026-11-06T00:00:00Z'))
})
it('keeps unresolved review conclusions pending without treating future-only reviews as uncertainty', async () => {
  for (const id of [16, 17]) { enterprise(id); event(id, 'award', 2022) }
  event(16, 'review', 2022, 2025, null)
  event(17, 'review', 2028, null, null)
  expect(await ids(2025, 'pending')).toEqual([7, 14, 16])
  expect(await ids(2026, 'pending')).toEqual([7, 16])
})
it('agrees with current effective HTTP while deduplicating titles and retaining source diagnostics', async () => {
  for (const id of [18, 19, 20, 21]) enterprise(id)
  event(18, 'award', 2025); event(18, 'award', 2025, 2025, null, 'little_giant')
  const invalidLink = event(19, 'award', 2025)
  validity(invalidLink, { originAwardEventId: 999999, interval: { validFrom: '2025-01-01', validThrough: '2027-12-31' } })
  event(20, 'award', 2027) // future-only no pending and no grant
  const future = event(21, 'award', 2025)
  validity(future, { publishedOn: '2027-01-01', interval: { validFrom: '2025-01-01', validThrough: '2027-12-31' } })
  expect(await ids(2026)).toEqual([1, 2, 4, 9, 11, 13, 14, 15, 18, 19])
  expect(await ids(2025)).toEqual([1, 4, 9, 11, 13, 15, 18, 19])
  expect(await ids(2026, 'effective', 'little_giant')).toEqual([18])
  for (const title of ['specialized_sme', 'little_giant', 'innovative_sme']) {
    const current = await fetch(base.replace('/api/statistics/annual', '/api/roster/current-enterprises') + `?titleCode=${title}&pageSize=200`)
    expect(current.status).toBe(200)
    const body = await current.json()
    const fixtureTime = Date.now()
    try {
      // The independent reader worker does not inherit Vitest's fake Date.
      vi.setSystemTime(new Date(body.snapshotStartedAt))
      const annual = (await read(`?title=${title}&pageSize=200`)).body
      expect(annual.asOf).toBe(body.snapshotStartedAt)
      expect(body.rows.map((r: any) => r.enterpriseId).sort((a: number,b: number) => a-b)).toEqual(annual.rows.map((r: any) => r.enterpriseId))
      expect(body.total).toBe(annual.total)
    } finally { vi.setSystemTime(fixtureTime) }
  }
})
it('keeps an instant at next-year midnight outside the preceding stock', async () => {
  enterprise(22)
  validity(event(22, 'award', 2023), { interval: { validFrom: '2023-01-01', validThrough: '2028-12-31' } })
  fact(22, 'cancelled', 'instant', '2025-01-01T00:00:00+08:00')
  expect(await ids(2024)).toEqual([1, 3, 4, 8, 9, 10, 11, 16, 17, 22])
  expect(await ids(2025)).toEqual([1, 4, 9, 11, 13, 15, 18, 19])
})
it('does not revive expired cycles from legacy inbound qualification intervals', async () => {
  enterprise(23); event(23, 'award', 2022)
  db.insert(schema.differenceReason).values({ enterpriseId: 23, titleCode: 'specialized_sme', direction: 'extra_in_miit', status: 'confirmed_reason', reasonCode: 'moved_in', measureCode: 'record_moved_in', verificationStatus: 'confirmed', recordedAt: '2025-01-01T00:00:00Z', lifecycleAction: 'replace', basis: '保留旧迁入决定', ruleVersion: 'legacy-v1', effectiveAt: '2025-01-01T00:00:00Z', currentQualification: { titleCode: 'specialized_sme', validFrom: '2025-01-01T00:00:00Z', validUntil: '2028-01-01T00:00:00Z', basis: '旧规则独立期间', publicationCheck: { status: 'not_found', scope: '新认定公布范围' } } }).run()
  expect(await ids(2025)).toEqual([1, 4, 9, 11, 13, 15, 18, 19])
  expect(await ids(2026)).toEqual([1, 2, 4, 9, 11, 13, 14, 15, 18, 19])
  expect(await ids(2026, 'pending')).toEqual([7, 16])
})
it('retains moved-out exclusion after reentry even while formal qualification remains valid', async () => {
  for (const id of [24, 25, 26]) enterprise(id)
  event(24, 'award', 2025); event(25, 'award', 2025)
  fact(24, 'moved_out', 'day', '2025-05-01'); fact(24, 'moved_in', 'day', '2026-01-01', { factId: 2400 })
  fact(25, 'moved_in', 'day', '2026-01-01')
  const platformOnly = db.insert(schema.record).values({ enterpriseId: 26, titleCode: 'specialized_sme', source: 'miit' }).returning().get()
  db.insert(schema.recordEvent).values({ recordId: platformOnly.id, eventType: 'maintain', year: 2025 }).run()
  fact(26, 'moved_in', 'day', '2026-01-01')
  expect(await ids(2026)).toEqual([1, 2, 4, 9, 11, 13, 14, 15, 18, 19, 25])
  expect(await ids(2026, 'pending')).toEqual([7, 16])
  const response = await fetch(base.replace('/api/statistics/annual', '/api/roster/current-enterprises') + '?titleCode=specialized_sme&status=moved_out&pageSize=200')
  expect(response.status).toBe(200)
  expect((await response.json()).rows.map((r: any) => r.enterpriseId)).toContain(24)
})
it('keeps resolved older unknown-origin reviews out of pending after definite expiry', async () => {
  enterprise(27)
  const older = event(27, 'review', null, 2020, null)
  db.$client.prepare('update record_event set batch_seq=null where id=?').run(older.e.id)
  event(27, 'award', 2022)
  // Literal HTTP rowsets: 27 holds the 2022 grant in 2024, expires in 2025,
  // and its resolved 2020 gap never reappears. 7/14/16 remain genuine gaps.
  expect(await ids(2024)).toEqual([1, 3, 4, 8, 9, 10, 11, 16, 17, 22, 23, 27])
  expect(await ids(2025)).toEqual([1, 4, 9, 11, 13, 15, 18, 19, 25])
  expect(await ids(2025, 'pending')).toEqual([7, 14, 16])
  expect(await ids(2026)).toEqual([1, 2, 4, 9, 11, 13, 14, 15, 18, 19, 25])
  expect(await ids(2026, 'pending')).toEqual([7, 16])
})
