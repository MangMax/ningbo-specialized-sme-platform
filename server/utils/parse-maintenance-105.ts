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
import { partKey } from '../../lib/file-parts'
import { readPdfPageCount } from './pdf-pages'
import { getStoredFile } from './stored-files'

type Db = BetterSQLite3Database<typeof schema>
const ocrPage310 = z.strictObject({ page: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), version: z.string().regex(/^[1-9]\d*:[1-9]\d*$/) })
const pages310 = z.array(ocrPage310).max(10000).refine(pages => new Set(pages.map(p => p.page)).size === pages.length, 'OCR 页不得重复')
export const parsePreflight310 = z.strictObject({
  kind: z.enum(['file', 'ocr']), pages: pages310.default([]), verifyPhysicalPages: z.boolean().optional(),
}).refine(v => v.kind === 'ocr' ? v.pages.length > 0 : v.pages.length === 0, 'OCR 必须指定实际采用页及读取版本;文件输入不得带 OCR 页')
export const parseInputRef310 = z.strictObject({
  format: z.literal(1), fileId: z.number().int().positive(), relPath: z.string().min(1),
  physicalSource: z.strictObject({ pageCount: z.number().int().positive(), contentVersion: z.string().min(1) }).optional(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/), kind: z.enum(['file', 'ocr']), pages: pages310,
}).refine(v => v.kind === 'ocr' ? v.pages.length > 0 : v.pages.length === 0, '输入类型与 OCR 页不一致')
type InputRef310 = z.infer<typeof parseInputRef310>
type InputLineage310 = { status: 'unknown' } | { status: 'bound'; inputRef: InputRef310 }
const pageRange669 = z.strictObject({ start: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), end: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).refine(r => r.start <= r.end, '页码范围逆序')
export const parsePart105 = z.strictObject({
  titleCode: z.enum(TITLE_ORDER as [string, ...string[]]),
  eventKind: z.enum(EVENT_ORDER as [string, ...string[]]),
  year: z.number().int().min(1900).max(2100).nullish(),
  batch: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullish(),
  attachment: z.string().max(500).nullish(),
  declarationId: z.string().uuid().optional(),
  pageRanges: z.array(pageRange669).max(1000).optional(),
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
function currentInput310(db: Db, fileId: number, selection: z.infer<typeof parsePreflight310>, filesDir: string, physicalSource?: InputRef310['physicalSource']): InputRef310 {
  const file = db.select({ id: schema.storedFile.id, relPath: schema.storedFile.relPath, sha256: schema.storedFile.sha256, removedAt: schema.storedFile.removedAt })
    .from(schema.storedFile).where(eq(schema.storedFile.id, fileId)).get()
  if (!file) return fail(404, '文件不存在')
  if (file.removedAt) return fail(409, '已移出文件不允许解析预检')
  let sha256: string
  let contentVersion: string
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
      contentVersion = inputFileStamp310(opened)
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
  return { format: 1, fileId, relPath: file.relPath, sha256, kind: selection.kind, pages, ...(physicalSource ? { physicalSource: { pageCount: physicalSource.pageCount, contentVersion } } : {}) }
}

/** The caller supplies versions from the OCR it actually read; never choose newer pages. */
export function preflightParse310(db: Db, fileId: number, raw: unknown, filesDir: string) {
  const parsed = parsePreflight310.safeParse(raw)
  if (!parsed.success) return fail(400, parsed.error.message)
  return { expectedVersion: readParse105(db, fileId).version, inputRef: currentInput310(db, fileId, parsed.data, filesDir) }
}
export async function preflightRanges669(db: Db, fileId: number, raw: unknown, filesDir: string) {
  const parsed = parsePreflight310.safeParse(raw)
  if (!parsed.success) return fail(400, parsed.error.message)
  const plan = preflightParse310(db, fileId, raw, filesDir)
  if (!parsed.data.verifyPhysicalPages) return plan
  const inputRef = await physicalInput669(db, fileId, plan.inputRef, filesDir)
  if (plan.expectedVersion !== readParse105(db, fileId).version) return fail(409, '解析版本已变化,请重新预检')
  return { expectedVersion: plan.expectedVersion, inputRef }
}

async function physicalInput669(db: Db, fileId: number, ref: InputRef310, filesDir: string) {
  const file = db.select().from(schema.storedFile).where(eq(schema.storedFile.id, fileId)).get()!
  if (file.ext.toLowerCase() !== 'pdf') return fail(409, '不支持页码定位: Office等文件无可靠物理页数')
  const before = currentInput310(db, fileId, ref, filesDir, { pageCount: 1, contentVersion: '' })
  const pageCount = await readPdfPageCount(filesDir, ref.relPath)
  if (!pageCount) return fail(409, '无法核实实际PDF物理页数,不支持页码定位')
  const after = currentInput310(db, fileId, ref, filesDir, { pageCount, contentVersion: '' })
  if (before.physicalSource!.contentVersion !== after.physicalSource!.contentVersion) return fail(409, '文件内容版本已变化,请重新预检')
  return after
}

/** Replay precedes disk verification, including immutable receipts after content drift. */
export async function commitRanges669(db: Db, fileId: number, raw: unknown, filesDir: string, context: LogContext = {}) {
  const parsed = parseFrozenCommit310.safeParse(raw)
  if (!parsed.success) return fail(400, parsed.error.message)
  const input = parsed.data
  const replay = db.select().from(schema.fileParseAudit105).where(and(eq(schema.fileParseAudit105.fileId, fileId), eq(schema.fileParseAudit105.idempotencyKey, input.idempotencyKey))).get()
  if (!replay && input.inputRef.physicalSource) {
    const verified = await physicalInput669(db, fileId, input.inputRef, filesDir)
    if (hash(verified) !== hash({ format: input.inputRef.format, fileId: input.inputRef.fileId, relPath: input.inputRef.relPath, sha256: input.inputRef.sha256, kind: input.inputRef.kind, pages: input.inputRef.pages, physicalSource: input.inputRef.physicalSource })) return fail(409, '文件内容版本已变化,请重新预检')
  }
  return saveParse105(db, fileId, input, undefined, context, filesDir, true)
}
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
  const file = db.select({ id: schema.storedFile.id, parseState: schema.storedFile.parseState, sha256: schema.storedFile.sha256, removedAt: schema.storedFile.removedAt })
    .from(schema.storedFile).where(eq(schema.storedFile.id, fileId)).get()
  if (!file) return fail(404, '文件不存在')
  const parts = listFileParts(db, [fileId]).get(fileId) ?? []
  const last = db.select({ id: schema.fileParseAudit105.id, after: schema.fileParseAudit105.after }).from(schema.fileParseAudit105)
    .where(eq(schema.fileParseAudit105.fileId, fileId)).orderBy(desc(schema.fileParseAudit105.id)).limit(1).get()
  const declarations = db.select().from(schema.fileDeclaration669).where(and(eq(schema.fileDeclaration669.fileId, fileId), eq(schema.fileDeclaration669.active, true))).all()
  const version = hash({ sha256: file.sha256, declarations, fileId, parseState: file.parseState, removedAt: file.removedAt, parts, derived: derivedPartsForFile(db, fileId), revision: last?.id ?? 0 })
  return { fileId, parseState: file.parseState, parts, declarations, version, removedAt: file.removedAt, inputLineage: lineage310(last?.after) }
}
export function getParse105(db: Db, fileId: number) {
  return db.transaction(tx => readParse105(tx as Db, fileId))
}

/** One atomic parse resource write, shared by REST and MCP. Replay precedes version checks. */
function saveParse105Unlogged(db: Db, fileId: number, raw: unknown, mode?: 'replace' | 'status', filesDir?: string, verifiedPhysical = false) {
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
  const requestHash = hash({ expectedVersion: input.expectedVersion, parts, parseState, actor: input.actor, reason: input.reason, ...(inputRef ? { inputRef } : {}), ...(input.parts?.some(p => p.declarationId !== undefined || p.pageRanges !== undefined) ? { rangeEdits: input.parts.map(p => ({ declarationId: p.declarationId, pageRanges: p.pageRanges })) } : {}) })
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
    if (inputRef?.physicalSource && !verifiedPhysical) return fail(409, '物理页码输入必须经冻结commit提交')
    if (input.parts?.some(p => p.pageRanges?.length) && !inputRef?.physicalSource) return fail(409, '页码范围必须先verifyPhysicalPages预检')
    if (inputRef) {
      if (!filesDir) return fail(409, '无法核实解析输入,请重新读取并预检')
      try {
        if (hash(currentInput310(scoped, fileId, inputRef, filesDir, inputRef.physicalSource)) !== hash({ format: inputRef.format, fileId: inputRef.fileId, relPath: inputRef.relPath, sha256: inputRef.sha256, kind: inputRef.kind, pages: inputRef.pages, ...(inputRef.physicalSource ? { physicalSource: inputRef.physicalSource } : {}) })) return fail(409, '解析输入已变化,请重新读取并预检后提交')
      } catch (error) {
        if (error instanceof ParseMaintenanceError) return fail(409, '解析输入已变化,请重新读取并预检后提交')
        throw error
      }
    }
    if (parts !== undefined) writeDeclarations669(scoped, fileId, input.parts!, before.declarations, inputRef)
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
    const { contentIdentity: _identity, partsBinding: _binding, ...file } = getStoredFile(scoped, fileId)!
    return { file, parts: normalized?.ok ? normalized.parts : [], parseState: input.parseState ?? 'parsed' }
  }, { behavior: 'immediate' })
  appLog({ source: 'file', operation: 'file.parse.revise', outcome: 'success', fileId, receiptId }, context)
  return result
}

/** Emit only after the receipt transaction returns; runtime retention never owns the receipt. */
export function saveParse105(db: Db, fileId: number, raw: unknown, mode?: 'replace' | 'status', context: LogContext = {}, filesDir?: string, verifiedPhysical = false) {
  const startedAt = Date.now()
  try {
    const result = saveParse105Unlogged(db, fileId, raw, mode, filesDir, verifiedPhysical)
    appLog({ source: 'file', operation: result.replayed ? 'file.parse.replay' : 'file.parse.revise', outcome: 'success', fileId, receiptId: result.receiptId, durationMs: Date.now() - startedAt }, context)
    return result
  } catch (error) {
    appLog({ source: 'file', operation: 'file.parse.revise', outcome: error instanceof ParseMaintenanceError ? 'denied' : 'failure', level: 'error', ...(error instanceof ParseMaintenanceError && error.statusCode === 409 ? { fileId } : {}), errorCode: error instanceof ParseMaintenanceError && error.statusCode === 409 ? 'file_parse_conflict' : 'file_parse_failed', durationMs: Date.now() - startedAt }, context)
    throw error
  }
}

function writeDeclarations669(db: Db, fileId: number, raw: z.infer<typeof parsePart105>[], previous: (typeof schema.fileDeclaration669.$inferSelect)[], inputRef?: InputRef310) {
  const sha256 = db.select().from(schema.storedFile).where(eq(schema.storedFile.id, fileId)).get()!.sha256
  const used = new Set<string>()
  const next = raw.map(item => {
    const normalized = normalizeParseParts([item])
    if (!normalized.ok) return fail(400, normalized.message)
    const part = normalized.parts[0]!
    const old = item.declarationId ? previous.find(p => p.declarationId === item.declarationId) : previous.find(p => partKey(p.part) === partKey(part))
    if (item.declarationId && !old) return fail(409, '声明不属于当前文件或已撤回')
    const declarationId = old?.declarationId ?? randomUUID()
    if (used.has(declarationId)) return fail(400, '声明身份重复')
    used.add(declarationId)
    let pageRanges = old?.pageRanges ?? null
    if (item.pageRanges !== undefined) {
      pageRanges = []
      for (const range of [...item.pageRanges].sort((a, b) => a.start - b.start || a.end - b.end)) {
        if (range.end > (inputRef?.physicalSource?.pageCount ?? 0)) return fail(400, '页码范围超出实际物理页数')
        const last = pageRanges.at(-1)
        if (last && range.start <= last.end) last.end = Math.max(last.end, range.end)
        else pageRanges.push({ ...range })
      }
    }
    if (old && old.sha256 !== sha256 && pageRanges?.length && item.pageRanges === undefined) return fail(409, '文件内容已变化,必须重新核实范围或显式清空')
    if (old?.pageRanges?.length && item.pageRanges === undefined && inputRef?.physicalSource && old.contentVersion !== inputRef.physicalSource.contentVersion) return fail(409, '范围依据内容版本已变化,必须重新核实范围或显式清空')
    const contentVersion = item.pageRanges !== undefined ? inputRef?.physicalSource?.contentVersion ?? null : old?.contentVersion ?? null
    return { contentVersion, declarationId, fileId, revision: (old?.revision ?? 0) + 1, active: true, sha256, part, pageRanges }
  })
  for (const old of previous) if (!used.has(old.declarationId)) db.update(schema.fileDeclaration669).set({ active: false, revision: old.revision + 1 }).where(eq(schema.fileDeclaration669.declarationId, old.declarationId)).run()
  for (const declaration of next) db.insert(schema.fileDeclaration669).values(declaration).onConflictDoUpdate({ target: schema.fileDeclaration669.declarationId, set: declaration }).run()
}
