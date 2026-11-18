import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as h3 from 'h3'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { initializeDb } from '../../../db/client'
import * as schema from '../../../db/schema'
const active = vi.hoisted(() => ({ db: null as any }))
vi.mock('@db', () => ({ useDb: () => active.db }))
const dir = mkdtempSync(join(tmpdir(), 'statistics-513-'))
const db = initializeDb({ create: true, dbPath: join(dir, 'test.sqlite') }); active.db = db
let server: ReturnType<typeof createServer>, base: string
beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-06T00:00:00Z'))
  for (const [key, value] of Object.entries(h3)) vi.stubGlobal(key, value)
  const route = (await import('../../../layers/sme-roster/server/api/statistics/movements.get')).default
  server = createServer(h3.toNodeListener(h3.createApp().use('/api/statistics/movements', route)))
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as any).port}/api/statistics/movements`
})
afterAll(async () => { if (server) await new Promise<void>(r => server.close(() => r())); db.$client.close(); rmSync(dir, { recursive: true, force: true }); vi.unstubAllGlobals(); vi.useRealTimers() })
async function read(query = '') { const response = await fetch(base + query); return { status: response.status, body: await response.json() } }
it('returns empty kinds and validates scopes', async () => {
  expect((await read()).body.kinds).toEqual([
    { kind: 'moved_in', confirmed: 0, unknown: 0, pending: 0 },
    { kind: 'moved_out', confirmed: 0, unknown: 0, pending: 0 },
    { kind: 'cancelled', confirmed: 0, unknown: 0, pending: 0 },
  ])
  for (const q of ['?kind=bad', '?year=oops', '?status=bad', '?page=0', '?pageSize=201', '?year=2024&year=2025']) expect((await read(q)).status).toBe(400)
})
it('counts current evidence-complete occurrence facts for all enterprises, not mutually exclusive current status', async () => {
  for (let id = 1; id <= 8; id++) db.insert(schema.enterprise).values({ id, name: `企业${id}`, nameNorm: `企业${id}` }).run()
  const fact = (enterpriseId: number, factId: number, kind: string, value: string | null, status = 'confirmed', revision = 1, basis = '核实原始文件', precision = value ? 'year' : 'unknown') => {
    db.$client.prepare(`insert into enterprise_fact_revision(enterprise_id,fact_id,revision,status,fact,action,actor,basis,created_at) values(?,?,?,?,?,'assert','fixture',?,'2026-11-06')`).run(enterpriseId, factId, revision, status, JSON.stringify({ kind, source: { reference: '原始公告.pdf', statement: '明确记载主体事实' }, effective: { precision, value }, observed: { precision: 'year', value: '2026' }, city: null }), basis)
  }
  fact(1, 1, 'moved_out', '2023'); fact(1, 2, 'moved_out', '2023'); fact(1, 3, 'moved_in', '2024')
  fact(2, 1, 'cancelled', '2024'); fact(2, 1, 'cancelled', '2024', 'withdrawn', 2)
  fact(3, 1, 'moved_out', '2022'); fact(3, 1, 'moved_out', '2022', 'replaced', 2); fact(3, 2, 'moved_in', '2025')
  fact(4, 1, 'cancelled', null)
  fact(5, 1, 'moved_in', '2024', 'pending')
  fact(6, 1, 'moved_out', '2024', 'confirmed', 1, '')
  fact(7, 1, 'moved_in', '2023-12-31T16:30:00Z', 'confirmed', 1, '核实', 'instant')
  fact(8, 1, 'registration_status', '2024')
  const all = (await read()).body
  expect(all.kinds).toEqual([
    { kind: 'moved_in', confirmed: 3, unknown: 0, pending: 1 },
    { kind: 'moved_out', confirmed: 1, unknown: 0, pending: 1 },
    { kind: 'cancelled', confirmed: 1, unknown: 1, pending: 0 },
  ])
  expect(all.rows.map((r: any) => [r.enterpriseId, r.kind])).toEqual([[1, 'moved_out'], [1, 'moved_in'], [3, 'moved_in'], [4, 'cancelled'], [7, 'moved_in']])
  expect(all.rows[0].evidence).toHaveLength(2)
  expect(all.rows[0].evidence[0]).toMatchObject({ factId: 1, revision: 1, basis: '核实原始文件', source: { reference: '原始公告.pdf' } })
  expect((await read('?year=2024')).body.rows.map((r: any) => r.enterpriseId)).toEqual([1, 7])
  expect((await read('?year=unknown')).body.rows.map((r: any) => r.enterpriseId)).toEqual([4])
  expect((await read('?status=unknown')).body.rows.map((r: any) => r.enterpriseId)).toEqual([4])
  expect((await read('?status=pending')).body.rows.map((r: any) => r.enterpriseId)).toEqual([5, 6])
  const paged = (await read('?kind=moved_in&pageSize=1&page=2')).body
  expect(paged.total).toBe(3); expect(paged.rows.map((r: any) => r.enterpriseId)).toEqual([3])
  expect((await read('?year=2026')).body.total).toBe(0)
})
it('keeps contradictory same-occurrence location assertions pending rather than choosing one', async () => {
  db.insert(schema.enterprise).values({ id: 9, name: '冲突企业', nameNorm: '冲突企业' }).run()
  for (const [i, kind] of ['moved_in', 'moved_out'].entries()) db.$client.prepare(`insert into enterprise_fact_revision(enterprise_id,fact_id,revision,status,fact,action,actor,basis,created_at) values(9,?,1,'confirmed',?,'assert','fixture','两份待消歧依据','2026-11-06')`).run(i + 1, JSON.stringify({ kind, effective: { precision: 'year', value: '2024' }, source: { reference: '冲突.pdf', statement: kind } }))
  expect((await read('?year=2024')).body.rows.map((r: any) => r.enterpriseId)).toEqual([1, 7])
  expect((await read('?year=2024&status=pending')).body.rows.map((r: any) => [r.enterpriseId, r.kind])).toEqual([[5, 'moved_in'], [6, 'moved_out'], [9, 'moved_in'], [9, 'moved_out']])
})
