import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { useDb, schema } from '../db/client'
import { getParse105, historyParse105, saveParse105, saveParseMcp105, preflightParse310, commitParse310 } from '../server/utils/parse-maintenance-105'

const root = mkdtempSync('/tmp/issue310-unit-')
const db = useDb({ dbPath: join(root, 'db.sqlite') })
afterAll(() => { db.$client.close(); rmSync(root, { recursive: true, force: true }) })
let serial = 0
const actor = { type: 'agent', id: 'synthetic-310' }
const part = { titleCode: 'specialized_sme', eventKind: 'award', year: 2024, rowCount: 2 }
function fixture() {
  const relPath = `input-${++serial}.pdf`
  writeFileSync(join(root, relPath), 'synthetic original bytes')
  const sha256 = createHash('sha256').update('synthetic original bytes').digest('hex')
  const f = db.insert(schema.storedFile).values({ relPath, filename: relPath, ext: 'pdf', bytes: 24, sha256 }).returning().get()
  const p = db.insert(schema.ocrResult).values({ fileId: f.id, pageNo: 1, markdown: 'original OCR', channel: 'upload' }).returning().get()
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
