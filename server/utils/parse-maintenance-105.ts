import { appLog, type LogContext } from '../../lib/logging'
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, fstatSync, openSync, readSync, realpathSync, statSync, type BigIntStats } from 'node:fs'
import { resolve, sep } from 'node:path'
import { and, desc, eq, gt } from 'drizzle-orm'
import { z } from 'zod'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../../db/schema'
import { EVENT_ORDER, TITLE_ORDER } from '../../lib/labels'
import { derivedPartsForFile, listFileParts } from './file-parts'
import { applyParseResult, normalizeParseParts } from './parse-result'
import { getStoredFile } from './stored-files'

type Db = BetterSQLite3Database<typeof schema>
const ocrPage310 = z.strictObject({ page: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), version: z.string().regex(/^[1-9]\d*:[1-9]\d*$/) })
const pages310 = z.array(ocrPage310).max(10000).refine(pages => new Set(pages.map(p => p.page)).size === pages.length, 'OCR 页不得重复')
export const parsePreflight310 = z.strictObject({
  kind: z.enum(['file', 'ocr']), pages: pages310.default([]),
}).refine(v => v.kind === 'ocr' ? v.pages.length > 0 : v.pages.length === 0, 'OCR 必须指定实际采用页及读取版本;文件输入不得带 OCR 页')
export const parseInputRef310 = z.strictObject({
  format: z.literal(1), fileId: z.number().int().positive(), relPath: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/), kind: z.enum(['file', 'ocr']), pages: pages310,
}).refine(v => v.kind === 'ocr' ? v.pages.length > 0 : v.pages.length === 0, '输入类型与 OCR 页不一致')
type InputRef310 = z.infer<typeof parseInputRef310>
type InputLineage310 = { status: 'unknown' } | { status: 'bound'; inputRef: InputRef310 }
export const parsePart105 = z.strictObject({
  titleCode: z.enum(TITLE_ORDER as [string, ...string[]]),
  eventKind: z.enum(EVENT_ORDER as [string, ...string[]]),
  year: z.number().int().min(1900).max(2100).nullish(),
  batch: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullish(),
  attachment: z.string().max(500).nullish(),
  rowCount: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
})
export const parseWrite105 = z.strictObject({
  parts: z.array(parsePart105).max(1000).optional(),
  parseState: z.enum(['unparsed', 'parsed', 'failed']).optional(),
  expectedVersion: z.string().regex(/^[a-f0-9]{64}$/),
  inputRef: parseInputRef310.optional(),
  idempotencyKey: z.string().trim().min(1).max(200),
  actor: z.strictObject({ type: z.enum(['user', 'agent']), id: z.string().trim().min(1).max(200) }),
  reason: z.string().trim().min(1).max(2000),
}).refine(v => v.parts !== undefined || v.parseState !== undefined, '至少给 parts 或 parseState')
  .refine(v => v.inputRef === undefined || v.parts !== undefined, '输入依据只用于替换解析段,状态更正保留原依据')
const modernEnvelope105 = ['expectedVersion', 'idempotencyKey', 'actor', 'reason'] as const
export const parseSave105 = z.strictObject({
  ...parseWrite105.shape,
  fileId: z.number().int().positive().optional(), relPath: z.string().trim().min(1).optional(),
  expectedVersion: parseWrite105.shape.expectedVersion.optional(),
  idempotencyKey: parseWrite105.shape.idempotencyKey.optional(),
  actor: parseWrite105.shape.actor.optional(), reason: parseWrite105.shape.reason.optional(),
})
  .refine(v => (v.fileId !== undefined) !== (v.relPath !== undefined), 'fileId 与 relPath 恰给一个')
  .refine(v => v.parts !== undefined || v.parseState !== undefined, '至少给 parts 或 parseState')
  .refine(v => !modernEnvelope105.some(key => v[key] !== undefined) || modernEnvelope105.every(key => v[key] !== undefined), '现代封套必须完整提供 expectedVersion/idempotencyKey/actor/reason,不得降级为旧盲写')
  .refine(v => v.inputRef === undefined || (v.parts !== undefined && modernEnvelope105.every(key => v[key] !== undefined)), 'inputRef 必须与完整现代解析段封套提交')
export const parseRead105 = z.strictObject({ fileId: z.number().int().positive() })
export const parseFrozenCommit310 = parseWrite105.safeExtend({ inputRef: parseInputRef310, parts: parseWrite105.shape.parts.unwrap() })
export const parsePreflightMcp310 = parsePreflight310.safeExtend({ fileId: parseRead105.shape.fileId })
export const parseCommitMcp310 = parseFrozenCommit310.safeExtend({ fileId: parseRead105.shape.fileId })
export const parseHistory105 = z.strictObject({
  fileId: z.number().int().positive(),
  afterId: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  limit: z.number().int().min(1).max(50).optional(),
  receiptId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
}).refine(v => v.receiptId === undefined || (v.afterId === undefined && v.limit === undefined), 'receiptId 点读不得混用分页')
export class ParseMaintenanceError extends Error {
  constructor(public statusCode: number, message: string) { super(message) }
}
function fail(status: number, message: string): never { throw new ParseMaintenanceError(status, message) }
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
// Reading may update atime. It must not change source identity, contents or metadata.
const inputFileStamp310 = (stat: BigIntStats) => [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].join(':')

/** Local to parse maintenance: inspect one real source, never scan/backfill the store. */
function currentInput310(db: Db, fileId: number, selection: z.infer<typeof parsePreflight310>, filesDir: string): InputRef310 {
  const file = db.select({ id: schema.storedFile.id, relPath: schema.storedFile.relPath, sha256: schema.storedFile.sha256, removedAt: schema.storedFile.removedAt })
    .from(schema.storedFile).where(eq(schema.storedFile.id, fileId)).get()
  if (!file) return fail(404, '文件不存在')
  if (file.removedAt) return fail(409, '已移出文件不允许解析预检')
  let sha256: string
  try {
    const root = realpathSync(filesDir), path = realpathSync(resolve(root, file.relPath))
    if (!path.startsWith(root + sep)) return fail(409, '文件路径越界')
    const before = statSync(path, { bigint: true })
    if (!before.isFile()) return fail(409, '解析输入必须是普通文件')
    const fd = openSync(path, 'r')
    try {
      const opened = fstatSync(fd, { bigint: true })
      if (inputFileStamp310(opened) !== inputFileStamp310(before)) return fail(409, '解析输入在打开时已变化')
      const digest = createHash('sha256'), chunk = Buffer.allocUnsafe(64 * 1024)
      let n: number
      while ((n = readSync(fd, chunk)) > 0) digest.update(chunk.subarray(0, n))
      sha256 = digest.digest('hex')
      // An open fd can still yield the old digest after rename/unlink, and an
      // already-read prefix can be overwritten without changing that digest.
      // Reconcile the fd with the configured pathname after the full read.
      const currentRoot = realpathSync(filesDir)
      const currentPath = realpathSync(resolve(currentRoot, file.relPath))
      // Canonical strings retain containment/identity checks, but sampling a
      // cached canonical target would miss a link switched after realpath.
      const current = statSync(resolve(filesDir, file.relPath), { bigint: true })
      const finished = fstatSync(fd, { bigint: true })
      if (currentRoot !== root || currentPath !== path
        || inputFileStamp310(finished) !== inputFileStamp310(opened)
        || inputFileStamp310(current) !== inputFileStamp310(opened)) return fail(409, '解析输入在读取期间已变化')
      // This is a read-consistency check, not a filesystem lock. External
      // replacements after this final verification remain the #311 boundary.
    } finally { closeSync(fd) }
  } catch { return fail(409, '无法核实解析文件内容身份,请重新读取并核实文件') }
  if (sha256 !== file.sha256) return fail(409, '解析文件内容身份与登记不符,请重新读取并核实文件')
  const pages = [...selection.pages].sort((a, b) => a.page - b.page)
  for (const page of pages) {
    const current = db.select({ id: schema.ocrResult.id, revision: schema.ocrResult.revision }).from(schema.ocrResult)
      .where(and(eq(schema.ocrResult.fileId, fileId), eq(schema.ocrResult.pageNo, page.page))).get()
    if (!current || `${current.id}:${current.revision}` !== page.version) return fail(409, '解析 OCR 输入已变化,请重新读取实际采用页后预检')
  }
  return { format: 1, fileId, relPath: file.relPath, sha256, kind: selection.kind, pages }
}

/** The caller supplies versions from the OCR it actually read; never choose newer pages. */
export function preflightParse310(db: Db, fileId: number, raw: unknown, filesDir: string) {
  const parsed = parsePreflight310.safeParse(raw)
  if (!parsed.success) return fail(400, parsed.error.message)
  return db.transaction(tx => ({ expectedVersion: readParse105(tx as Db, fileId).version,
    inputRef: currentInput310(tx as Db, fileId, parsed.data, filesDir) }))
}

/** The recommended current writer cannot fall back to the compatibility adapter. */
export function commitParse310(db: Db, fileId: number, raw: unknown, filesDir: string, context: LogContext = {}) {
  const parsed = parseFrozenCommit310.safeParse(raw)
  if (!parsed.success) return fail(400, parsed.error.message)
  return saveParse105(db, fileId, parsed.data, undefined, context, filesDir)
}

function lineage310(snapshot: Record<string, unknown> | undefined): InputLineage310 {
  const lineage = snapshot?.inputLineage as InputLineage310 | undefined
  return lineage?.status === 'bound' ? lineage : { status: 'unknown' }
}

/** Exact-ID projection. Source-derived coordinates participate in the edit version too. */
export function readParse105(db: Db, fileId: number) {
  const file = db.select({ id: schema.storedFile.id, parseState: schema.storedFile.parseState, removedAt: schema.storedFile.removedAt })
    .from(schema.storedFile).where(eq(schema.storedFile.id, fileId)).get()
  if (!file) return fail(404, '文件不存在')
  const parts = listFileParts(db, [fileId]).get(fileId) ?? []
  const last = db.select({ id: schema.fileParseAudit105.id, after: schema.fileParseAudit105.after }).from(schema.fileParseAudit105)
    .where(eq(schema.fileParseAudit105.fileId, fileId)).orderBy(desc(schema.fileParseAudit105.id)).limit(1).get()
  const version = hash({ fileId, parseState: file.parseState, removedAt: file.removedAt, parts, derived: derivedPartsForFile(db, fileId), revision: last?.id ?? 0 })
  return { fileId, parseState: file.parseState, parts, version, removedAt: file.removedAt, inputLineage: lineage310(last?.after) }
}
export function getParse105(db: Db, fileId: number) {
  return db.transaction(tx => readParse105(tx as Db, fileId))
}

/** One atomic parse resource write, shared by REST and MCP. Replay precedes version checks. */
function saveParse105Unlogged(db: Db, fileId: number, raw: unknown, mode?: 'replace' | 'status', filesDir?: string) {
  const parsed = parseWrite105.safeParse(raw)
  if (!parsed.success) return fail(400, parsed.error.message)
  const input = parsed.data
  if (mode === 'replace' && input.parts === undefined) return fail(400, 'PUT 必须提供全部代理段 parts')
  if (mode === 'status' && (input.parts !== undefined || input.parseState === undefined)) return fail(400, 'PATCH 只允许 parseState,不得提供 parts')
  const normalized = input.parts === undefined ? undefined : normalizeParseParts(input.parts)
  if (normalized && !normalized.ok) return fail(400, normalized.message)
  const parts = normalized?.ok ? normalized.parts : undefined
  const parseState = input.parseState ?? 'parsed'
  const inputRef = input.inputRef && { ...input.inputRef, pages: [...input.inputRef.pages].sort((a, b) => a.page - b.page) }
  // Omit absent lineage to preserve old request hashes and immutable receipt replay.
  const requestHash = hash({ expectedVersion: input.expectedVersion, parts, parseState, actor: input.actor, reason: input.reason, ...(inputRef ? { inputRef } : {}) })
  return db.transaction(tx => {
    const scoped = tx as Db
    const receipt = tx.select({ id: schema.fileParseAudit105.id, requestHash: schema.fileParseAudit105.requestHash, after: schema.fileParseAudit105.after }).from(schema.fileParseAudit105)
      .where(and(eq(schema.fileParseAudit105.fileId, fileId), eq(schema.fileParseAudit105.idempotencyKey, input.idempotencyKey))).get()
    if (receipt) {
      if (receipt.requestHash !== requestHash) return fail(409, '幂等键已用于不同解析请求')
      return { receiptId: receipt.id, replayed: true, state: receipt.after }
    }
    const before = readParse105(scoped, fileId)
    if (before.removedAt) return fail(409, '已移出文件不允许修改解析结果')
    if (before.version !== input.expectedVersion) return fail(409, '解析版本冲突,请重新读取后提交')
    // Compatibility may edit unknown history, but cannot erase an established basis.
    // True immutable receipt replay has already returned above this gate.
    if (parts !== undefined && !inputRef && before.inputLineage.status === 'bound') {
      return fail(409, '解析已绑定输入依据,请重新读取并预检后携完整 inputRef 提交;不得降级覆盖')
    }
    if (inputRef) {
      if (!filesDir) return fail(409, '无法核实解析输入,请重新读取并预检')
      try {
        if (hash(currentInput310(scoped, fileId, inputRef, filesDir)) !== hash(inputRef)) return fail(409, '解析输入已变化,请重新读取并预检后提交')
      } catch (error) {
        if (error instanceof ParseMaintenanceError) return fail(409, '解析输入已变化,请重新读取并预检后提交')
        throw error
      }
    }
    const written = applyParseResult(scoped, fileId, { parts, parseState })
    if (!written.ok) return fail(400, written.message)
    const audit = tx.insert(schema.fileParseAudit105).values({
      fileId, idempotencyKey: input.idempotencyKey, requestHash,
      operation: parts === undefined ? 'status' : 'replace', actor: input.actor, reason: input.reason,
      before, after: {}, createdAt: new Date().toISOString(),
    }).returning({ id: schema.fileParseAudit105.id }).get()
    const after = { ...readParse105(scoped, fileId), inputLineage: parts === undefined ? before.inputLineage : inputRef ? { status: 'bound' as const, inputRef } : { status: 'unknown' as const } }
    tx.update(schema.fileParseAudit105).set({ after }).where(eq(schema.fileParseAudit105.id, audit.id)).run()
    return { receiptId: audit.id, replayed: false, state: after }
  }, { behavior: 'immediate' })
}

/** Bounded summaries, or one explicitly requested immutable receipt including snapshots. */
export function historyParse105(db: Db, raw: unknown) {
  const parsed = parseHistory105.safeParse(raw)
  if (!parsed.success) return fail(400, parsed.error.message)
  const { fileId, receiptId, afterId = 0, limit = 20 } = parsed.data
  if (!db.select({ id: schema.storedFile.id }).from(schema.storedFile).where(eq(schema.storedFile.id, fileId)).get()) return fail(404, '文件不存在')
  if (receiptId !== undefined) {
    const receipt = db.select().from(schema.fileParseAudit105)
      .where(and(eq(schema.fileParseAudit105.fileId, fileId), eq(schema.fileParseAudit105.id, receiptId))).get()
    if (!receipt) return fail(404, '解析回执不存在')
    const { requestHash: _requestHash, ...publicReceipt } = receipt
    return { ...publicReceipt, inputLineage: lineage310(receipt.after) }
  }
  const rows = db.select({ receiptId: schema.fileParseAudit105.id, fileId: schema.fileParseAudit105.fileId,
    operation: schema.fileParseAudit105.operation, actor: schema.fileParseAudit105.actor, reason: schema.fileParseAudit105.reason,
    idempotencyKey: schema.fileParseAudit105.idempotencyKey, createdAt: schema.fileParseAudit105.createdAt,
  }).from(schema.fileParseAudit105).where(and(eq(schema.fileParseAudit105.fileId, fileId), gt(schema.fileParseAudit105.id, afterId)))
    .orderBy(schema.fileParseAudit105.id).limit(limit + 1).all()
  return { fileId, rows: rows.slice(0, limit), nextAfterId: rows.length > limit ? rows[limit - 1]!.receiptId : null }
}

/** Preserve the existing MCP exact-path alias; all writes/receipts bind to the resolved ID. */
export function saveParseMcp105(db: Db, raw: unknown, context: LogContext = {}, filesDir?: string) {
  const parsed = parseSave105.safeParse(raw)
  if (!parsed.success) return fail(400, parsed.error.message)
  const { fileId, relPath, ...input } = parsed.data
  const id = fileId ?? db.select({ id: schema.storedFile.id }).from(schema.storedFile)
    .where(eq(schema.storedFile.relPath, relPath!)).get()?.id
  if (id === undefined) return fail(404, '文件不存在')
  if (modernEnvelope105.some(key => input[key] !== undefined)) return saveParse105(db, id, input, undefined, context, filesDir)
  return saveLegacyParseMcp105(db, id, input, context)
}

/** Explicit baseline adapter: a serialized blind write, with adapter-attributed audit.
 * The generated envelope is internal bookkeeping, never caller confirmation or caller CAS.
 */
function saveLegacyParseMcp105(db: Db, fileId: number, input: { parts?: z.infer<typeof parsePart105>[]; parseState?: string }, context: LogContext) {
  const normalized = input.parts === undefined ? undefined : normalizeParseParts(input.parts)
  if (normalized && !normalized.ok) return fail(400, normalized.message)
  let receiptId: number | undefined
  const result = db.transaction(tx => {
    const scoped = tx as Db
    const current = readParse105(scoped, fileId)
    const receipt = saveParse105Unlogged(scoped, fileId, {
      parts: input.parts, parseState: input.parseState,
      expectedVersion: current.version,
      idempotencyKey: `legacy-save-parse:${randomUUID()}`,
      actor: { type: 'agent', id: 'legacy-adapter:save_parse_result' },
      reason: '兼容旧 save_parse_result 盲写；客户端未提供版本、幂等键、操作者或确认依据',
    })
    receiptId = receipt.receiptId
    // Preserve baseline semantics: top-level parts is the submitted normalized agent
    // collection (or [] for status-only); file.parts is the effective stored collection.
    return { file: getStoredFile(scoped, fileId)!, parts: normalized?.ok ? normalized.parts : [], parseState: input.parseState ?? 'parsed' }
  }, { behavior: 'immediate' })
  appLog({ source: 'file', operation: 'file.parse.revise', outcome: 'success', fileId, receiptId }, context)
  return result
}

/** Emit only after the receipt transaction returns; runtime retention never owns the receipt. */
export function saveParse105(db: Db, fileId: number, raw: unknown, mode?: 'replace' | 'status', context: LogContext = {}, filesDir?: string) {
  const startedAt = Date.now()
  try {
    const result = saveParse105Unlogged(db, fileId, raw, mode, filesDir)
    appLog({ source: 'file', operation: result.replayed ? 'file.parse.replay' : 'file.parse.revise', outcome: 'success', fileId, receiptId: result.receiptId, durationMs: Date.now() - startedAt }, context)
    return result
  } catch (error) {
    appLog({ source: 'file', operation: 'file.parse.revise', outcome: error instanceof ParseMaintenanceError ? 'denied' : 'failure', level: 'error', ...(error instanceof ParseMaintenanceError && error.statusCode === 409 ? { fileId } : {}), errorCode: error instanceof ParseMaintenanceError && error.statusCode === 409 ? 'file_parse_conflict' : 'file_parse_failed', durationMs: Date.now() - startedAt }, context)
    throw error
  }
}
