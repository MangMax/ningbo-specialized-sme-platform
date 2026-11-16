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
const dir = mkdtempSync(join(tmpdir(), 'statistics-515-'))
const db = initializeDb({ create: true, dbPath: join(dir, 'test.sqlite') }); active.db = db
let server: ReturnType<typeof createServer>, base: string
beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-06T00:00:00Z'))
  for (const [key, value] of Object.entries(h3)) vi.stubGlobal(key, value)
  const route = (await import('../../../server/api/statistics/districts.get')).default
  const annual = (await import('../../../server/api/statistics/annual.get')).default
  server = createServer(h3.toNodeListener(h3.createApp().use('/api/statistics/districts', route).use('/api/statistics/annual', annual)))
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as any).port}/api/statistics/districts`
})
afterAll(async () => { if (server) await new Promise<void>(r => server.close(() => r())); db.$client.close(); rmSync(dir, { recursive: true, force: true }); vi.unstubAllGlobals(); vi.useRealTimers() })
async function read(query = '') { const response = await fetch(base + query); return { status: response.status, body: await response.json() } }
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

it('validates filters and retains explicit empty totals', async () => {
  expect((await read()).body.titles.map((t: any) => t.effective)).toEqual([0,0,0])
  for (const q of ['?title=bad','?district=','?district=a&district=b','?page=0','?pageSize=201','?page=1.5']) expect((await read(q)).status).toBe(400)
})
it('conserves literal effective enterprise/title rowsets including unknown and independent districts', async () => {
  for (const id of [1,2,3,4,5]) enterprise(id)
  for (const id of [1,2,3,4]) event(id,'award',2025)
  event(1,'award',2025); event(1,'award',2025,2025,null,'little_giant')
  event(5,'award',2020) // expired
  db.$client.prepare('update enterprise set district=? where id=3').run('保税区')
  // Historical published district must never replace current enterprise district.
  db.$client.prepare('update record set district=?').run('海曙区')
  const all=(await read('?title=specialized_sme&pageSize=200')).body
  expect(all.rows.map((r:any)=>r.enterpriseId)).toEqual([1,2,3,4])
  expect(all.districts.map((d:any)=>[d.district,d.titles.find((t:any)=>t.titleCode==='specialized_sme').effective])).toEqual([['保税区',1],['大榭开发区',1],[null,2]])
  for (const title of ['little_giant','specialized_sme','innovative_sme']) {
    const annual=await (await fetch(base.replace('districts','annual')+'?title='+title)).json()
    expect(all.districts.reduce((n:number,d:any)=>n+d.titles.find((t:any)=>t.titleCode===title).effective,0)).toBe(annual.total)
    expect(all.asOf).toBe(annual.asOf); expect(all.ruleVersion).toBe(annual.ruleVersion)
  }
  const first=(await read('?title=specialized_sme&district=unknown&pageSize=1')).body
  const second=(await read('?title=specialized_sme&district=unknown&pageSize=1&page=2')).body
  expect(first.total).toBe(2); expect(second.total).toBe(2)
  expect(first.rows.map((r:any)=>r.enterpriseId)).toEqual([2]); expect(second.rows.map((r:any)=>r.enterpriseId)).toEqual([4])
  expect(first.rows[0].evidence[0]).toMatchObject({sourceFile:'annual.pdf',page:2})
  expect((await read('?district='+encodeURIComponent('大榭开发区'))).body.rows.map((r:any)=>r.titleCode)).toEqual(['innovative_sme','little_giant','specialized_sme'])
})
