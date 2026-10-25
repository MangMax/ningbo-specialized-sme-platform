import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync, rmSync, renameSync, unlinkSync, symlinkSync, statSync, fstatSync, openSync, writeSync, closeSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { useDb, schema } from '../db/client'
import { getParse105, historyParse105, saveParse105, saveParseMcp105, preflightParse310, commitParse310 } from '../server/utils/parse-maintenance-105'

// Only schedule a real filesystem mutation after a real read. The production
// input checker, digest, database and all other filesystem calls remain real.
const readBoundary = vi.hoisted(() => ({ afterRead: null as null | ((fd: number, bytes: number) => void) }))
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, readSync: (...args: Parameters<typeof actual.readSync>) => {
    const bytes = actual.readSync(...args)
    if (bytes > 0) readBoundary.afterRead?.(args[0], bytes)
    return bytes
  } }
})

const root = mkdtempSync('/tmp/issue310-unit-')
const db = useDb({ dbPath: join(root, 'db.sqlite') })
afterAll(() => { db.$client.close(); rmSync(root, { recursive: true, force: true }) })
let serial = 0
const actor = { type: 'agent' as const, id: 'synthetic-310' }
const part = { titleCode: 'specialized_sme', eventKind: 'award', year: 2024, rowCount: 2 }
function fixture(bytes = Buffer.from('synthetic original bytes')) {
  const relPath = `input-${++serial}.pdf`
  writeFileSync(join(root, relPath), bytes)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const f = db.insert(schema.storedFile).values({ relPath, filename: relPath, ext: 'pdf', bytes: bytes.length, sha256 }).returning().get()
  const p = db.insert(schema.ocrResult).values({ fileId: f.id, pageNo: 1, markdown: 'original OCR', raw: { syntheticCapture310: true, content: ['original nonempty response'] }, channel: 'upload' }).returning().get()
  return { f, p, pages: [{ page: 1, version: `${p.id}:1` }] }
}
function command(version: string, key: string, inputRef?: unknown) {
  return { expectedVersion: version, idempotencyKey: key, actor, reason: 'synthetic parse input', parts: [part], ...(inputRef ? { inputRef } : {}) }
}
it('pins actual bytes and selected OCR versions independently from output CAS', () => {
  const { f, p, pages } = fixture()
  const before = getParse105(db, f.id)
  const plan = preflightParse310(db, f.id, { kind: 'ocr', pages }, root)
  expect(plan.expectedVersion).toBe(before.version)
  expect(plan.inputRef).toEqual({ format: 1, fileId: f.id, relPath: f.relPath, sha256: f.sha256, kind: 'ocr', pages })
  db.update(schema.ocrResult).set({ markdown: 'new OCR', revision: 2 }).where(eq(schema.ocrResult.id, p.id)).run()
  expect(getParse105(db, f.id).version).toBe(before.version)
  expect(() => saveParse105(db, f.id, command(before.version, 'stale-ocr', plan.inputRef), undefined, {}, root)).toThrow('输入已变化')
  expect(getParse105(db, f.id)).toEqual(before)
  expect(historyParse105(db, { fileId: f.id }).rows).toEqual([])
  expect(() => preflightParse310(db, f.id, { kind: 'ocr', pages }, root)).toThrow('重新读取')
})

const readDriftCases = [
  { name: 'same-size atomic rename', kind: 'rename' },
  { name: 'same-size overwrite of already-read prefix', kind: 'inplace' },
  { name: 'path deletion', kind: 'unlink' },
  { name: 'canonical symlink target switch with identical bytes', kind: 'symlink' },
] as const

it.each(readDriftCases)('rejects $name during hashing and preserves bound output audit evidence and nonempty OCR raw', ({ kind }) => {
  const original = Buffer.alloc(128 * 1024, 'A')
  const { f, pages } = fixture(original)
  const path = join(root, f.relPath)
  if (kind === 'symlink') {
    renameSync(path, path + '.original')
    symlinkSync(path + '.original', path)
  }
  const e = db.insert(schema.enterprise).values({ name: f.relPath, nameNorm: f.relPath }).returning().get()
  const r = db.insert(schema.record).values({ enterpriseId: e.id, source: 'jxj', titleCode: 'specialized_sme' }).returning().get()
  const ev = db.insert(schema.recordEvent).values({ recordId: r.id, eventType: 'award', year: 2024 }).returning().get()
  db.insert(schema.recordEvidence).values({ recordEventId: ev.id, sourceFile: f.relPath, page: 7, attachment: '人工确认分节', listNo: 12 }).run()
  const plan = preflightParse310(db, f.id, { kind: 'ocr', pages }, root)
  const firstBody = command(plan.expectedVersion, `bound-${f.id}`, plan.inputRef)
  const saved = commitParse310(db, f.id, firstBody, root)
  const next = preflightParse310(db, f.id, { kind: 'ocr', pages }, root)
  const snapshot = () => ({
    state: getParse105(db, f.id),
    file: db.select().from(schema.storedFile).where(eq(schema.storedFile.id, f.id)).get(),
    parts: db.select().from(schema.storedFilePart).where(eq(schema.storedFilePart.fileId, f.id)).all(),
    audits: db.select().from(schema.fileParseAudit105).where(eq(schema.fileParseAudit105.fileId, f.id)).all(),
    evidence: db.select().from(schema.recordEvidence).where(eq(schema.recordEvidence.recordEventId, ev.id)).all(),
    event: db.select().from(schema.recordEvent).where(eq(schema.recordEvent.id, ev.id)).get(),
    ocr: db.select().from(schema.ocrResult).where(eq(schema.ocrResult.fileId, f.id)).all(),
  })
  const before = snapshot()
  expect(before.ocr[0]!.raw).toEqual({ syntheticCapture310: true, content: ['original nonempty response'] })
  const identity = statSync(path)
  const replacement = path + '.replacement'
  if (kind === 'rename' || kind === 'symlink') writeFileSync(replacement, kind === 'symlink' ? original : Buffer.alloc(original.length, 'B'))
  let mutated = false
  let firstRead = 0
  readBoundary.afterRead = (fd, bytes) => {
    const opened = fstatSync(fd)
    if (mutated || opened.ino !== identity.ino || opened.dev !== identity.dev) return
    mutated = true
    firstRead = bytes
    if (kind === 'rename') renameSync(replacement, path)
    else if (kind === 'unlink') unlinkSync(path)
    else if (kind === 'symlink') {
      symlinkSync(replacement, path + '.new-link')
      renameSync(path + '.new-link', path)
    } else {
      const writer = openSync(path, 'r+')
      try { writeSync(writer, Buffer.alloc(bytes, 'B'), 0, bytes, 0) }
      finally { closeSync(writer) }
    }
  }
  let failure: unknown
  try {
    commitParse310(db, f.id, { ...command(next.expectedVersion, `drift-${f.id}`, next.inputRef), parts: [{ ...part, rowCount: 99 }], parseState: 'failed' }, root)
  } catch (error) { failure = error }
  finally { readBoundary.afterRead = null }
  expect(mutated).toBe(true)
  expect(firstRead).toBe(64 * 1024)
  if (kind !== 'unlink') expect(statSync(path).size).toBe(original.length)
  if (kind === 'rename' || kind === 'inplace') expect(createHash('sha256').update(readFileSync(path)).digest('hex')).not.toBe(f.sha256)
  expect(failure).toMatchObject({ statusCode: 409, message: expect.stringContaining('重新读取并预检') })
  expect(snapshot()).toEqual(before)
  // Already committed receipts and status edits remain independent of disk drift;
  // a compatibility replacement still cannot erase the bound basis.
  expect(commitParse310(db, f.id, firstBody, root)).toEqual({ ...saved, replayed: true })
  expect(() => saveParseMcp105(db, { fileId: f.id, parts: [] })).toThrow('预检')
  const status = saveParse105(db, f.id, { expectedVersion: before.state.version, idempotencyKey: `status-${f.id}`, actor, reason: 'status only after physical drift', parseState: 'failed' })
  expect(status.state.inputLineage).toEqual(before.state.inputLineage)
  expect(status.state.parts).toEqual(before.state.parts)
  expect(snapshot().ocr).toEqual(before.ocr)
  expect(snapshot().evidence).toEqual(before.evidence)
})

it('rejects same-size path replacement during preflight without publishing a false frozen input', () => {
  const { f, pages } = fixture(Buffer.alloc(128 * 1024, 'A'))
  const path = join(root, f.relPath), replacement = path + '.replacement'
  writeFileSync(replacement, Buffer.alloc(128 * 1024, 'B'))
  const before = getParse105(db, f.id)
  const identity = statSync(path)
  let mutated = false
  readBoundary.afterRead = (fd) => {
    const opened = fstatSync(fd)
    if (!mutated && opened.ino === identity.ino && opened.dev === identity.dev) {
      mutated = true
      renameSync(replacement, path)
    }
  }
  let failure: unknown
  try { preflightParse310(db, f.id, { kind: 'ocr', pages }, root) }
  catch (error) { failure = error }
  finally { readBoundary.afterRead = null }
  expect(mutated).toBe(true)
  expect(failure).toMatchObject({ statusCode: 409, message: expect.stringContaining('重新读取') })
  expect(getParse105(db, f.id)).toEqual(before)
  expect(historyParse105(db, { fileId: f.id }).rows).toEqual([])
})

it('commits an unchanged multi-chunk source while retaining its selected OCR basis and nonempty raw', () => {
  const { f, p, pages } = fixture(Buffer.alloc(128 * 1024, 'A'))
  const plan = preflightParse310(db, f.id, { kind: 'ocr', pages }, root)
  const saved = commitParse310(db, f.id, command(plan.expectedVersion, 'unchanged-multi-chunk', plan.inputRef), root)
  expect(saved.replayed).toBe(false)
  expect(saved.state.inputLineage).toEqual({ status: 'bound', inputRef: plan.inputRef })
  expect(saved.state.parts).toMatchObject([{ titleCode: part.titleCode, rowCount: 2 }])
  expect(getParse105(db, f.id)).toEqual(saved.state)
  expect(db.select().from(schema.ocrResult).where(eq(schema.ocrResult.id, p.id)).get()).toEqual(p)
  expect(historyParse105(db, { fileId: f.id }).rows).toHaveLength(1)
})

it('keeps runtime hash and OCR version validation strict independently of OpenAPI descriptions', () => {
  const { f, pages } = fixture()
  const plan = preflightParse310(db, f.id, { kind: 'ocr', pages }, root)
  const expectInvalid = (action: () => unknown) => {
    try { action() }
    catch (error) { expect(error).toMatchObject({ statusCode: 400 }); return }
    expect.fail('invalid request must fail before publication')
  }
  for (const version of ['01:1', '1:0', '1e2:1', '1:1x']) {
    expectInvalid(() => preflightParse310(db, f.id, { kind: 'ocr', pages: [{ page: 1, version }] }, root))
  }
  for (const sha256 of ['A'.repeat(64), 'a'.repeat(63), 'g'.repeat(64)]) {
    expectInvalid(() => commitParse310(db, f.id, command(plan.expectedVersion, 'invalid-input-hash', { ...plan.inputRef, sha256 }), root))
  }
  expectInvalid(() => commitParse310(db, f.id, { ...command(plan.expectedVersion, 'invalid-output-hash', plan.inputRef), expectedVersion: 'A'.repeat(64) }, root))
  expectInvalid(() => commitParse310(db, f.id, command(plan.expectedVersion, 'invalid-file-id', { ...plan.inputRef, fileId: 1.5 }), root))
  expect(historyParse105(db, { fileId: f.id }).rows).toEqual([])
})
it('rejects changed disk bytes without a file registry refresh and retains the frozen plan', () => {
  const { f } = fixture()
  const plan = preflightParse310(db, f.id, { kind: 'file' }, root)
  writeFileSync(join(root, f.relPath), 'replacement bytes')
  expect(() => saveParse105(db, f.id, command(plan.expectedVersion, 'changed-bytes', plan.inputRef), undefined, {}, root)).toThrow('输入已变化')
  expect(() => preflightParse310(db, f.id, { kind: 'file' }, root)).toThrow('文件内容身份')
  expect(historyParse105(db, { fileId: f.id }).rows).toEqual([])
})
it('replays the original receipt after input changes and refuses same-key different input', () => {
  const { f, p, pages } = fixture()
  const plan = preflightParse310(db, f.id, { kind: 'ocr', pages }, root)
  const body = command(plan.expectedVersion, 'durable', plan.inputRef)
  const saved = saveParse105(db, f.id, body, undefined, {}, root)
  expect(saved.state.inputLineage).toEqual({ status: 'bound', inputRef: plan.inputRef })
  db.update(schema.ocrResult).set({ markdown: 'changed', revision: 2 }).where(eq(schema.ocrResult.id, p.id)).run()
  writeFileSync(join(root, f.relPath), 'replaced after success')
  expect(saveParseMcp105(db, { fileId: f.id, ...body }, {}, root)).toEqual({ ...saved, replayed: true })
  expect(() => saveParse105(db, f.id, { ...body, inputRef: { ...plan.inputRef, kind: 'file', pages: [] } }, undefined, {}, root)).toThrow('幂等键')
  expect(historyParse105(db, { fileId: f.id, receiptId: saved.receiptId })).toMatchObject({ after: { inputLineage: saved.state.inputLineage } })
})
it('checks only used OCR pages and rolls back output lineage and audit together on storage failure', () => {
  const { f, pages } = fixture()
  const plan = preflightParse310(db, f.id, { kind: 'ocr', pages }, root)
  db.insert(schema.ocrResult).values({ fileId: f.id, pageNo: 2, markdown: 'unused', channel: 'mcp' }).run()
  const before = getParse105(db, f.id)
  const body = command(plan.expectedVersion, 'storage-retry', plan.inputRef)
  db.$client.exec(`CREATE TRIGGER fail_parse310 BEFORE INSERT ON file_parse_audit_105 BEGIN SELECT RAISE(ABORT, 'synthetic storage fault'); END`)
  try {
    expect(() => saveParse105(db, f.id, body, undefined, {}, root)).toThrow('synthetic storage fault')
    expect(getParse105(db, f.id)).toEqual(before)
    expect(historyParse105(db, { fileId: f.id }).rows).toEqual([])
  } finally { db.$client.exec('DROP TRIGGER fail_parse310') }
  const saved = saveParse105(db, f.id, body, undefined, {}, root)
  expect(saved.state.parts).toMatchObject([{ year: 2024, rowCount: 2 }])
  expect(saved.state.inputLineage).toEqual({ status: 'bound', inputRef: plan.inputRef })
})
it('keeps legacy lineage unknown and preserves bound basis through status-only edits', () => {
  const { f } = fixture()
  expect(getParse105(db, f.id).inputLineage).toEqual({ status: 'unknown' })
  saveParseMcp105(db, { fileId: f.id, parts: [part] })
  expect(getParse105(db, f.id).inputLineage).toEqual({ status: 'unknown' })
  const plan = preflightParse310(db, f.id, { kind: 'file' }, root)
  const saved = saveParse105(db, f.id, command(plan.expectedVersion, 'known', plan.inputRef), undefined, {}, root)
  const status = saveParse105(db, f.id, { expectedVersion: saved.state.version, idempotencyKey: 'status', actor, reason: 'status only', parseState: 'failed' })
  expect(status.state.inputLineage).toEqual(saved.state.inputLineage)
  expect(status.state.parts).toEqual(saved.state.parts)
})
it('rejects duplicate missing and cross-file input references without publishing output', () => {
  const { f, pages } = fixture()
  expect(() => preflightParse310(db, f.id, { kind: 'ocr', pages: [...pages, ...pages] }, root)).toThrow()
  expect(() => preflightParse310(db, f.id, { kind: 'ocr', pages: [] }, root)).toThrow()
  expect(() => preflightParse310(db, f.id, { kind: 'ocr', pages: [{ page: 99, version: '999:1' }] }, root)).toThrow('重新读取')
  const other = fixture()
  const plan = preflightParse310(db, f.id, { kind: 'file' }, root)
  expect(() => saveParse105(db, other.f.id, command(getParse105(db, other.f.id).version, 'cross-file', plan.inputRef), undefined, {}, root)).toThrow('输入已变化')
  expect(historyParse105(db, { fileId: other.f.id }).rows).toEqual([])
})

it('refuses frozen commit downgrade and protects output CAS independently of unchanged input', () => {
  const { f } = fixture()
  const plan = preflightParse310(db, f.id, { kind: 'file' }, root)
  expect(() => commitParse310(db, f.id, command(plan.expectedVersion, 'missing-ref'), root)).toThrow()
  const current = saveParse105(db, f.id, { expectedVersion: plan.expectedVersion, idempotencyKey: 'interleaved-status', actor, reason: 'status edit', parseState: 'failed' })
  expect(() => commitParse310(db, f.id, command(plan.expectedVersion, 'stale-output', plan.inputRef), root)).toThrow('解析版本冲突')
  expect(getParse105(db, f.id)).toEqual(current.state)
  expect(historyParse105(db, { fileId: f.id }).rows).toHaveLength(1)
})

it('reads old audit lineage as unknown without rewriting snapshots or inventing current file hashes', () => {
  const { f } = fixture()
  const historical = { fileId: f.id, version: 'historical-output', parseState: 'parsed', parts: [] }
  const audit = db.insert(schema.fileParseAudit105).values({ fileId: f.id, idempotencyKey: 'old-audit', requestHash: 'historical-hash', operation: 'replace', actor, reason: 'historical unknown', before: historical, after: historical, createdAt: '2026-01-01T00:00:00Z' }).returning().get()
  expect(getParse105(db, f.id).inputLineage).toEqual({ status: 'unknown' })
  const receipt = historyParse105(db, { fileId: f.id, receiptId: audit.id })
  expect(receipt).toMatchObject({ inputLineage: { status: 'unknown' }, before: historical, after: historical })
  expect(db.select().from(schema.fileParseAudit105).where(eq(schema.fileParseAudit105.id, audit.id)).get()).toEqual(audit)
  expect(JSON.stringify(receipt)).not.toContain(f.sha256)
})

it('blocks legacy replacements of a bound result while allowing status edits and genuine replay', () => {
  const { f, p, pages } = fixture()
  const plan = preflightParse310(db, f.id, { kind: 'ocr', pages }, root)
  const body = command(plan.expectedVersion, 'bound-first', plan.inputRef)
  const saved = commitParse310(db, f.id, body, root)
  const before = getParse105(db, f.id)
  const history = historyParse105(db, { fileId: f.id })
  db.update(schema.ocrResult).set({ markdown: 'newer source', revision: 2 }).where(eq(schema.ocrResult.id, p.id)).run()
  writeFileSync(join(root, f.relPath), 'changed source bytes')
  expect(getParse105(db, f.id).version).toBe(before.version)
  expect(() => saveParse105(db, f.id, command(before.version, 'legacy-modern'))).toThrow('预检')
  expect(() => saveParseMcp105(db, { fileId: f.id, parts: [] })).toThrow('预检')
  expect(getParse105(db, f.id)).toEqual(before)
  expect(historyParse105(db, { fileId: f.id })).toEqual(history)
  expect(commitParse310(db, f.id, body, root)).toEqual({ ...saved, replayed: true })
  const status = saveParse105(db, f.id, { expectedVersion: before.version, idempotencyKey: 'bound-status', actor, reason: 'status only', parseState: 'failed' })
  expect(status.state.inputLineage).toEqual(before.inputLineage)
  expect(status.state.parts).toEqual(before.parts)
})
