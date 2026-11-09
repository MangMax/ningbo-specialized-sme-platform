import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import { createApp, createRouter, defineEventHandler, toNodeListener } from 'h3'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { initializeDb } from '../db/client'
import { schema } from '../db'
const root = mkdtempSync('/tmp/segments-668-')
const db = initializeDb({ create: true, dbPath: join(root, 'test.sqlite') })
let server: Server, base: string, enabled = true
beforeAll(async () => {
  vi.stubGlobal('defineEventHandler', defineEventHandler)
  vi.stubGlobal('useRuntimeConfig', () => ({ apiToken: 'synthetic-server-only', browserReviewEnabled: enabled, filesDir: root }))
  vi.doMock('@db', () => ({ useDb: () => db }))
  const { browserFileSegmentsRoute } = await import('../server/utils/browser-file-segments')
  const router = createRouter()
  for (const action of ['read', 'preflight', 'commit'] as const) {
    const path = '/:id' + (action === 'read' ? '' : '/' + action)
    if (action === 'read') router.get(path, browserFileSegmentsRoute(action))
    else router.post(path, browserFileSegmentsRoute(action))
  }
  server = createServer(toNodeListener(createApp().use(router)))
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const address = server.address()
  if (!address || typeof address === 'string') throw Error('No port')
  base = `http://127.0.0.1:${address.port}`
})
afterAll(async () => {
  if (server) await new Promise<void>(r => server.close(() => r()))
  db.$client.close(); vi.unstubAllGlobals(); vi.doUnmock('@db')
})
async function http(id: number, action = '', body?: unknown, origin?: string) {
  const r = await fetch(`${base}/${id}${action}`, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', origin: origin ?? base }, ...(body ? { body: JSON.stringify(body) } : {}) })
  return { status: r.status, body: await r.json() }
}
function fixture() {
  const name = `controlled-${crypto.randomUUID()}.pdf`, bytes = 'controlled source, never OCR'
  writeFileSync(join(root, name), bytes)
  return db.insert(schema.storedFile).values({ relPath: name, filename: name, ext: 'pdf', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), parseState: 'failed' }).returning().get()
}
it('saves explicit combinations through real HTTP, preserves parse state and replays without granting a token', async () => {
  const f = fixture(), initial = (await http(f.id)).body
  expect(initial.writeEnabled).toBe(true)
  const plan = await http(f.id, '/preflight', { expectedVersion: initial.state.version })
  expect(plan.status).toBe(200)
  const parts = [{ titleCode: 'specialized_sme', eventKind: 'review', year: 2022, batch: 1, attachment: '附件1', rowCount: 2 }, { titleCode: 'specialized_sme', eventKind: 'award', year: 2025, batch: 2, rowCount: 3 }]
  const body = { ...plan.body, parts, idempotencyKey: 'first', reason: '登记内容描述' }
  const saved = await http(f.id, '/commit', body)
  expect(saved.status).toBe(200)
  expect(saved.body.state.parseState).toBe('failed')
  expect((await http(f.id)).body.state.parts.map((p: {year: number, batch: number}) => [p.year, p.batch])).toEqual([[2025, 2], [2022, 1]])
  expect((await http(f.id, '/commit', body)).body.replayed).toBe(true)
  expect(readFileSync(join(root, f.relPath), 'utf8')).toBe('controlled source, never OCR')
  expect(JSON.stringify(await http(f.id))).not.toContain('synthetic-server-only')
})
it('rejects cross-origin, disabled, forged actors, stale versions, duplicates, illegal values and oversized collections atomically', async () => {
  const f = fixture(), initial = (await http(f.id)).body
  const request = { expectedVersion: initial.state.version }
  expect((await http(f.id, '/preflight', request, 'https://other.example')).status).toBe(403)
  enabled = false
  expect((await http(f.id)).body.writeEnabled).toBe(false)
  expect((await http(f.id, '/preflight', request)).status).toBe(403)
  enabled = true
  const plan = (await http(f.id, '/preflight', request)).body
  const part = { titleCode: 'specialized_sme', eventKind: 'award', year: 2022, batch: 1, rowCount: 1 }
  const body = { ...plan, parts: [part], idempotencyKey: 'guard', reason: '登记' }
  for (const extra of [{ actor: { type: 'user', id: 'forged' } }, { parseState: 'parsed' }, { parts: [part, part] }, { parts: [{ ...part, year: 0 }] }, { parts: Array.from({ length: 1001 }, () => part) }]) {
    expect((await http(f.id, '/commit', { ...body, ...extra })).status).toBe(400)
    expect((await http(f.id)).body.state).toEqual(initial.state)
  }
  expect((await http(f.id, '/commit', body)).status).toBe(200)
  expect((await http(f.id, '/preflight', request)).status).toBe(409)
  expect((await http(f.id, '/commit', { ...body, idempotencyKey: 'stale', parts: [] })).status).toBe(409)
  expect((await http(f.id, '/commit', { ...body, parts: [] })).status).toBe(409)
})
it('withdraws declarations to reveal source-derived rows and preserves official facts and OCR', async () => {
  const f = fixture()
  const e = db.insert(schema.enterprise).values({ name: '受控企业668', nameNorm: '受控企业668' }).returning().get()
  const r = db.insert(schema.record).values({ enterpriseId: e.id, source: 'jxj', titleCode: 'specialized_sme' }).returning().get()
  const ev = db.insert(schema.recordEvent).values({ recordId: r.id, eventType: 'award', year: 2022, batchSeq: 1 }).returning().get()
  db.insert(schema.recordEvidence).values({ recordEventId: ev.id, sourceFile: f.relPath, page: 1, attachment: '附件1' }).run()
  db.insert(schema.ocrResult).values({ fileId: f.id, pageNo: 1, markdown: '受控OCR', channel: 'upload' }).run()
  const facts = () => [db.select().from(schema.enterprise).all(), db.select().from(schema.record).all(), db.select().from(schema.recordEvent).all(), db.select().from(schema.recordEvidence).all(), db.select().from(schema.ocrResult).all()]
  const before = facts()
  async function save(parts: unknown[], key: string) {
    const state = (await http(f.id)).body.state
    const plan = (await http(f.id, '/preflight', { expectedVersion: state.version })).body
    const result = await http(f.id, '/commit', { ...plan, parts, idempotencyKey: key, reason: '描述维护' })
    expect(result.status).toBe(200)
    return result.body
  }
  const saved = await save([{ titleCode: 'specialized_sme', eventKind: 'award', year: 2022, batch: 1, attachment: '附件1', rowCount: 3 }], 'declare')
  expect(saved.state.parts[0]).toMatchObject({ origin: 'agent', hasConflict: true, rowCount: 3 })
  await save([], 'withdraw')
  expect((await http(f.id)).body.state).toMatchObject({ parseState: 'failed', parts: [{ origin: 'derived', rowCount: 1 }] })
  expect(facts()).toEqual(before)
  writeFileSync(join(root, f.relPath), 'changed')
  expect((await http(f.id, '/preflight', { expectedVersion: (await http(f.id)).body.state.version })).status).toBe(409)
})
