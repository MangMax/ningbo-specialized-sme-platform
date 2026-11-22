import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import { createApp, createRouter, defineEventHandler, toNodeListener } from 'h3'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { postgresRuntimeFixture } from '../../support/postgres-fixture.mjs'
import { closePostgresDirectoryDb, usePostgresDirectoryDb } from '../../../db/postgresql/client'
import { storedFile, ocrResult } from '../../../db/postgresql/file-tables'
import { fileDeclaration669, rosterFileClassification, storedFilePart } from '../../../db/postgresql/roster-file-tables'
import { enterprise } from '../../../db/postgresql/enterprise-tables'
import { record, recordEvent, recordEvidence } from '../../../db/postgresql/ledger-tables'
const root = mkdtempSync('/tmp/segments-668-')
let runtime: Awaited<ReturnType<typeof postgresRuntimeFixture>>
let db: ReturnType<typeof usePostgresDirectoryDb>
let server: Server, base: string
beforeAll(async () => {
  vi.stubGlobal('defineEventHandler', defineEventHandler)
  vi.stubGlobal('useRuntimeConfig', () => ({ apiToken: 'synthetic-server-only', filesDir: root }))
  runtime = await postgresRuntimeFixture({ dir: root })
  vi.stubEnv('NUXT_POSTGRES_DIRECTORY_URL', runtime.url)
  vi.stubEnv('NUXT_DB_READONLY', '0')
  db = usePostgresDirectoryDb()
  const { browserFileSegmentsRoute } = await import('../../../layers/sme-roster/server/utils/browser-file-segments')
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
  try { await closePostgresDirectoryDb(); runtime?.close() }
  finally { rmSync(root, { recursive: true, force: true }) }
  vi.unstubAllGlobals(); vi.unstubAllEnvs()
})
async function http(id: number, action = '', body?: unknown, origin?: string) {
  const r = await fetch(`${base}/${id}${action}`, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', origin: origin ?? base }, ...(body ? { body: JSON.stringify(body) } : {}) })
  return { status: r.status, body: await r.json() }
}
async function fixture() {
  const name = `controlled-${crypto.randomUUID()}.pdf`, bytes = 'controlled source, never OCR'
  writeFileSync(join(root, name), bytes)
  return db.transaction(async tx => {
    const [file] = await tx.insert(storedFile).values({
      relPath: name, filename: name, ext: 'pdf', bytes: BigInt(bytes.length), createdAt: new Date().toISOString(),
      sha256: createHash('sha256').update(bytes).digest('hex'),
    }).returning()
    await tx.insert(rosterFileClassification).values({ fileId: file!.id, parseState: 'failed' })
    return file!
  })
}
it('saves explicit combinations through real HTTP, preserves parse state and replays without granting a token', async () => {
  const f = await fixture(), initial = (await http(f.id)).body
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
it('rejects cross-origin, forged actors, stale versions, duplicates, illegal values and oversized collections atomically', async () => {
  const f = await fixture(), initial = (await http(f.id)).body
  const request = { expectedVersion: initial.state.version }
  expect((await http(f.id, '/preflight', request, 'https://other.example')).status).toBe(403)
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
  const f = await fixture()
  const [e] = await db.insert(enterprise).values({ name: '受控企业668', nameNorm: '受控企业668' }).returning()
  const [r] = await db.insert(record).values({ enterpriseId: e!.id, source: 'jxj', titleCode: 'specialized_sme' }).returning()
  const [ev] = await db.insert(recordEvent).values({ recordId: r!.id, eventType: 'award', year: 2022, batchSeq: 1 }).returning()
  await db.insert(recordEvidence).values({ recordEventId: ev!.id, sourceFile: f.relPath, page: 1, attachment: '附件1' })
  await db.insert(ocrResult).values({ fileId: f.id, page: 1, markdown: '受控OCR', channel: 'upload', engine: 'paddleocr', revision: 1n, createdAt: new Date().toISOString() })
  const facts = () => Promise.all([db.select().from(enterprise), db.select().from(record), db.select().from(recordEvent), db.select().from(recordEvidence), db.select().from(ocrResult)])
  const before = await facts()
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
  expect(await facts()).toEqual(before)
  writeFileSync(join(root, f.relPath), 'changed')
  expect((await http(f.id, '/preflight', { expectedVersion: (await http(f.id)).body.state.version })).status).toBe(409)
})
it("retains declaration identity and ranges when changing coordinates through the compatibility description payload", async () => {
  const f = await fixture()
  const declared = { titleCode: 'specialized_sme', eventKind: 'award' as const, year: 2022, batch: 1, attachment: null, rowCount: 1 }
  // An existing saved range is fixture state owned by #669; this editor does
  // not claim to have physically verified pages or re-register their source.
  const declarationId = crypto.randomUUID()
  await db.insert(storedFilePart).values({ fileId: f.id, ...declared, origin: 'agent', hasConflict: 0 })
  await db.insert(fileDeclaration669).values({
    declarationId, fileId: f.id, sha256: f.sha256, revision: 1, active: 1, displaySequence: 1,
    contentVersion: 'controlled-existing-epoch', part: JSON.stringify(declared),
    pageRanges: JSON.stringify([{ start: 1, end: 2 }, { start: 4, end: 4 }]),
  })
  const state = (await http(f.id)).body.state
  const plan = (await http(f.id, '/preflight', { expectedVersion: state.version })).body
  expect((await http(f.id, '/commit', { ...plan, parts: [{ ...declared, declarationId, year: 2025 }], idempotencyKey: 'preserve-range', reason: '仅编辑描述坐标' })).status).toBe(200)
  expect((await http(f.id)).body.state.declarations).toMatchObject([{ declarationId, revision: 2, contentVersion: 'controlled-existing-epoch', part: { year: 2025 }, pageRanges: [{ start: 1, end: 2 }, { start: 4, end: 4 }] }])
})
it('rejects range writes without reliable physical pages and keeps the entire draft uncommitted', async () => {
  const f = await fixture(), initial = (await http(f.id)).body.state
  const plan = await http(f.id, '/preflight', { expectedVersion: initial.version, verifyPhysicalPages: true })
  expect(plan.status).toBe(409)
  expect((await http(f.id)).body.state).toEqual(initial)
})
it('round trips disjoint ranges, rejects out of bounds atomically, edits and clears through the browser HTTP adapter', async () => {
  const f = await fixture()
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R 6 0 R] /Count 4 >>', ...Array.from({ length: 4 }, () => '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] >>')]
  let pdf = '%PDF-1.4\n'; const offsets = [0]
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${object}\nendobj\n` })
  const xref = Buffer.byteLength(pdf)
  pdf += `xref\n0 7\n0000000000 65535 f \n${offsets.slice(1).map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  writeFileSync(join(root, f.relPath), pdf)
  const { eq } = await import('drizzle-orm')
  await db.update(storedFile).set({ sha256: createHash('sha256').update(pdf).digest('hex'), bytes: BigInt(Buffer.byteLength(pdf)) }).where(eq(storedFile.id, f.id))
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
it("persists display order across edits, reversed legacy payloads, deletion and append with shared summaries", async () => {
  const f = await fixture()
  const save = async (parts: unknown[], key = crypto.randomUUID()) => {
    const state = (await http(f.id)).body.state
    const plan = (await http(f.id, '/preflight', { expectedVersion: state.version })).body
    const request = { ...plan, parts, idempotencyKey: key, reason: '681 order' }
    const result = await http(f.id, '/commit', request)
    expect(result.status).toBe(200)
    return { request, result: result.body }
  }
  const a = { titleCode: 'specialized_sme', eventKind: 'award', year: null, batch: 1, rowCount: 7 }
  const b = { ...a, year: 2020, batch: null }
  const first = await save([a, b])
  const declarations = (await http(f.id)).body.state.declarations
  expect(declarations.map((d: {displaySequence: number}) => d.displaySequence)).toEqual([1, 2])
  const [da, db] = declarations
  await save([{ ...b, declarationId: db.declarationId }, { ...a, year: 2025, declarationId: da.declarationId }])
  const state = (await http(f.id)).body.state
  expect(state.declarations.map((d: {declarationId: string}) => d.declarationId)).toEqual([da.declarationId, db.declarationId])
  expect(state.registeredSummary).toEqual({ count: 2, declarations: state.declarations })
  await save([{ ...b }])
  await save([{ ...b }, { ...a, year: 2026 }])
  expect((await http(f.id)).body.state.declarations.map((d: {displaySequence: number}) => d.displaySequence)).toEqual([2, 3])
  const replay = await http(f.id, '/commit', first.request)
  expect(replay.body).toEqual({ ...first.result, replayed: true })
  expect((await http(f.id, '/commit', { ...first.request, idempotencyKey: 'stale681' })).status).toBe(409)
})
