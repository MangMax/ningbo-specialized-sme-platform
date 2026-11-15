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
const dir = mkdtempSync(join(tmpdir(), 'statistics-512-'))
const db = initializeDb({ create: true, dbPath: join(dir, 'test.sqlite') }); active.db = db
let server: ReturnType<typeof createServer>, base: string
beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-06T00:00:00Z'))
  for (const [key, value] of Object.entries(h3)) vi.stubGlobal(key, value)
  const route = (await import('../../../server/api/statistics/published.get')).default
  server = createServer(h3.toNodeListener(h3.createApp().use('/api/statistics/published', route)))
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as any).port}/api/statistics/published`
})
afterAll(async () => { if (server) await new Promise<void>(r => server.close(() => r())); db.$client.close(); rmSync(dir, { recursive: true, force: true }); vi.unstubAllGlobals(); vi.useRealTimers() })
async function read(query = '') { const response = await fetch(base + query); return { status: response.status, body: await response.json() } }
it('returns explicit zero titles and rejects invalid detail scopes', async () => {
  expect((await read()).body.titles).toEqual([
    { titleCode: 'little_giant', confirmed: 0, pending: 0 },
    { titleCode: 'specialized_sme', confirmed: 0, pending: 0 },
    { titleCode: 'innovative_sme', confirmed: 0, pending: 0 },
  ])
  expect((await read('?title=bad')).status).toBe(400)
})
it('deduplicates formal awards by enterprise and title while retaining ended and unmatched enterprises and separating ambiguous identities', async () => {
  const add = (id: number, flags: string[] = []) => db.insert(schema.enterprise).values({ id, name: `企业${id}`, nameNorm: `企业${id}`, regStatus: id === 2 ? '注销' : null, qualityFlags: flags }).run()
  for (const id of [1, 2, 3, 4, 5, 6]) add(id, id === 6 ? ['name_ambiguous'] : [])
  let rid = 0
  const record = (id: number, source: 'jxj' | 'miit', type: 'award' | 'review' | 'maintain' | 'nurture', evidence = true, titleCode = 'specialized_sme') => {
    const recordId = ++rid
    db.insert(schema.record).values({ id: recordId, enterpriseId: id, source, titleCode }).run()
    for (let n = 0; n < 2; n++) {
      const event = db.insert(schema.recordEvent).values({ recordId, eventType: type, year: 2020 + n }).returning().get()
      if (evidence) db.insert(schema.recordEvidence).values({ recordEventId: event.id, sourceFile: 'official.pdf', attachment: '名单', listNo: id, page: 1 }).run()
    }
  }
  record(1, 'jxj', 'award'); record(1, 'miit', 'award'); record(1, 'jxj', 'award', true, 'little_giant')
  record(2, 'jxj', 'award'); record(3, 'miit', 'maintain', false); record(4, 'jxj', 'nurture'); record(5, 'jxj', 'review'); record(6, 'jxj', 'award')
  const summary = (await read()).body
  expect(summary.titles).toEqual([{ titleCode: 'little_giant', confirmed: 1, pending: 0 }, { titleCode: 'specialized_sme', confirmed: 2, pending: 1 }, { titleCode: 'innovative_sme', confirmed: 0, pending: 0 }])
  const first = (await read('?title=specialized_sme&pageSize=1')).body
  const second = (await read('?title=specialized_sme&pageSize=1&page=2')).body
  expect(first.total).toBe(2); expect(second.total).toBe(2)
  expect([...first.rows, ...second.rows].map((r: { enterpriseId: number }) => r.enterpriseId)).toEqual([1, 2])
  expect(first.rows[0].evidence).toHaveLength(4)
  expect((await read('?title=specialized_sme&status=pending')).body.rows.map((r: { enterpriseId: number }) => r.enterpriseId)).toEqual([6])
})
