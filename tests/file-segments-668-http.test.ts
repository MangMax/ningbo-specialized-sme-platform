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
it('retains #669 declaration identity and ranges when changing coordinates through the compatibility description payload', async () => {
  const f = fixture()
  const declared = { titleCode: 'specialized_sme', eventKind: 'award' as const, year: 2022, batch: 1, attachment: null, rowCount: 1 }
  // An existing saved range is fixture state owned by #669; this editor does
  // not claim to have physically verified pages or re-register their source.
  const declarationId = crypto.randomUUID()
  db.insert(schema.storedFilePart).values({ fileId: f.id, ...declared, origin: 'agent' }).run()
  db.insert(schema.fileDeclaration669).values({ declarationId, fileId: f.id, sha256: f.sha256, revision: 1, active: true, contentVersion: 'controlled-existing-epoch', part: declared, pageRanges: [{ start: 1, end: 2 }, { start: 4, end: 4 }] }).run()
  const state = (await http(f.id)).body.state
  const plan = (await http(f.id, '/preflight', { expectedVersion: state.version })).body
  expect((await http(f.id, '/commit', { ...plan, parts: [{ ...declared, declarationId, year: 2025 }], idempotencyKey: 'preserve-range', reason: '仅编辑描述坐标' })).status).toBe(200)
  expect((await http(f.id)).body.state.declarations).toMatchObject([{ declarationId, revision: 2, contentVersion: 'controlled-existing-epoch', part: { year: 2025 }, pageRanges: [{ start: 1, end: 2 }, { start: 4, end: 4 }] }])
})
it('rejects range writes without reliable physical pages and keeps the entire draft uncommitted', async () => {
  const f = fixture(), initial = (await http(f.id)).body.state
  const plan = await http(f.id, '/preflight', { expectedVersion: initial.version, verifyPhysicalPages: true })
  expect(plan.status).toBe(409)
  expect((await http(f.id)).body.state).toEqual(initial)
})
it('round trips disjoint ranges, rejects out of bounds atomically, edits and clears through the browser HTTP adapter', async () => {
  const f = fixture()
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R 6 0 R] /Count 4 >>', ...Array.from({ length: 4 }, () => '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] >>')]
  let pdf = '%PDF-1.4\n'; const offsets = [0]
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${object}\nendobj\n` })
  const xref = Buffer.byteLength(pdf)
  pdf += `xref\n0 7\n0000000000 65535 f \n${offsets.slice(1).map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  writeFileSync(join(root, f.relPath), pdf)
  const { eq } = await import('drizzle-orm')
  db.update(schema.storedFile).set({ sha256: createHash('sha256').update(pdf).digest('hex'), bytes: Buffer.byteLength(pdf) }).where(eq(schema.storedFile.id, f.id)).run()
  const part = { titleCode: 'specialized_sme', eventKind: 'award', year: 2022, batch: 1, rowCount: 2 }
  const save = async (parts: unknown[]) => {
    const state = (await http(f.id)).body.state
    const plan = (await http(f.id, '/preflight', { expectedVersion: state.version, verifyPhysicalPages: true })).body
    expect(plan.inputRef.physicalSource.pageCount).toBe(4)
    return http(f.id, '/commit', { ...plan, parts, idempotencyKey: crypto.randomUUID(), reason: '范围验收' })
  }
  expect((await save([{ ...part, pageRanges: [{ start: 1, end: 2 }, { start: 4, end: 4 }] }])).status).toBe(200)
  const first = (await http(f.id)).body.state
  const id = first.declarations[0].declarationId
  expect(first.declarations[0].pageRanges).toEqual([{ start: 1, end: 2 }, { start: 4, end: 4 }])
  expect((await save([{ ...part, declarationId: id, pageRanges: [{ start: 1, end: 5 }] }])).status).toBe(400)
  expect((await http(f.id)).body.state).toEqual(first)
  expect((await save([{ ...part, declarationId: id, pageRanges: [{ start: 2, end: 3 }] }])).status).toBe(200)
  expect((await http(f.id)).body.state.declarations[0].pageRanges).toEqual([{ start: 2, end: 3 }])
  expect((await save([{ ...part, declarationId: id, pageRanges: [] }])).status).toBe(200)
  expect((await http(f.id)).body.state.declarations[0]).toMatchObject({ declarationId: id, part: { year: 2022, batch: 1 }, pageRanges: [] })
  expect(readFileSync(join(root, f.relPath), 'utf8')).toBe(pdf)
})
