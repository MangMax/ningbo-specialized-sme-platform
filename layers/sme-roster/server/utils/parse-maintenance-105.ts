import { appLog, type LogContext } from '../../../core/lib/logging'
import { and, desc, eq, gt, sql } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import type { z } from 'zod'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../../../../db/schema'
import { derivedPartsForFile, listFileParts } from './file-parts'
import { applyParseResult, normalizeParseParts } from './parse-result'
import { readPdfPageCount } from '../../../core/server/utils/pdf-pages'
import { listRegisteredDeclarations681 } from './registered-declarations'
import { getStoredFile } from '../../../core/server/utils/stored-files'

import {
  equalParseInput, failParseMaintenance as fail, lineage310, modernEnvelope105, parseFrozenCommit310,
  parseHistory105, parsePart105, parsePreflight310, parseSave105, ParseMaintenanceError, planDeclarations669, prepareParseWrite105,
  projectParseState, readParseInput310, validateParseRevision, type InputRef310,
} from './parse-maintenance-contract'

export * from './parse-maintenance-contract'

type Db = BetterSQLite3Database<typeof schema>
/** Local to parse maintenance: inspect one real source, never scan/backfill the store. */
function currentInput310(db: Db, fileId: number, selection: z.infer<typeof parsePreflight310>, filesDir: string, physicalSource?: InputRef310['physicalSource']): InputRef310 {
  const file = db.select({ id: schema.storedFile.id, relPath: schema.storedFile.relPath, sha256: schema.storedFile.sha256, removedAt: schema.storedFile.removedAt })
    .from(schema.storedFile).where(eq(schema.storedFile.id, fileId)).get()
  if (!file) return fail(404, '文件不存在')
  const input = readParseInput310(file, selection, filesDir, physicalSource)
  for (const page of input.pages) {
    const current = db.select({ id: schema.ocrResult.id, revision: schema.ocrResult.revision }).from(schema.ocrResult)
      .where(and(eq(schema.ocrResult.fileId, fileId), eq(schema.ocrResult.pageNo, page.page))).get()
    if (!current || `${current.id}:${current.revision}` !== page.version) return fail(409, '解析 OCR 输入已变化,请重新读取实际采用页后预检')
  }
  return input
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
  const plan = { expectedVersion: readParse105(db, fileId).version, inputRef: currentInput310(db, fileId, parsed.data, filesDir) }
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
    if (!equalParseInput(verified, input.inputRef)) return fail(409, '文件内容版本已变化,请重新预检')
  }
  return saveParse105(db, fileId, input, undefined, context, filesDir, true)
}

/** Exact-ID projection. Source-derived coordinates participate in the edit version too. */
export function readParse105(db: Db, fileId: number) {
  const file = db.select({ id: schema.storedFile.id, parseState: schema.rosterFileClassification.parseState, sha256: schema.storedFile.sha256, removedAt: schema.storedFile.removedAt })
    .from(schema.storedFile)
    .innerJoin(schema.rosterFileClassification, eq(schema.storedFile.id, schema.rosterFileClassification.fileId)).where(eq(schema.storedFile.id, fileId)).get()
  if (!file) return fail(404, '文件不存在')
  const parts = listFileParts(db, [fileId]).get(fileId) ?? []
  const last = db.select({ id: schema.fileParseAudit105.id, after: schema.fileParseAudit105.after }).from(schema.fileParseAudit105)
    .where(eq(schema.fileParseAudit105.fileId, fileId)).orderBy(desc(schema.fileParseAudit105.id)).limit(1).get()
  const declarations = listRegisteredDeclarations681(db, [fileId]).get(fileId) ?? []
  const derived = derivedPartsForFile(db, fileId)
  return projectParseState(file, parts, declarations, derived, last)
}

export function getParse105(db: Db, fileId: number) {
  return db.transaction(tx => readParse105(tx as Db, fileId))
}

function saveParse105Unlogged(db: Db, fileId: number, raw: unknown, mode?: 'replace' | 'status', filesDir?: string, verifiedPhysical = false) {
  const command = prepareParseWrite105(raw, mode)
  const { input, parts, parseState, inputRef, requestHash } = command
  return db.transaction(tx => {
    const scoped = tx as Db
    const receipt = tx.select({ id: schema.fileParseAudit105.id, requestHash: schema.fileParseAudit105.requestHash, after: schema.fileParseAudit105.after }).from(schema.fileParseAudit105)
      .where(and(eq(schema.fileParseAudit105.fileId, fileId), eq(schema.fileParseAudit105.idempotencyKey, input.idempotencyKey))).get()
    if (receipt) {
      if (receipt.requestHash !== requestHash) return fail(409, '幂等键已用于不同解析请求')
      return { receiptId: receipt.id, replayed: true, state: receipt.after }
    }
    const before = readParse105(scoped, fileId)
    validateParseRevision(before, command, verifiedPhysical)
    if (inputRef) {
      if (!filesDir) return fail(409, '无法核实解析输入,请重新读取并预检')
      try {
        if (!equalParseInput(currentInput310(scoped, fileId, inputRef, filesDir, inputRef.physicalSource), inputRef)) return fail(409, '解析输入已变化,请重新读取并预检后提交')
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
    const { contentIdentity: _identity, partsBinding: _binding, registeredSummary: _summary, ...file } = getStoredFile(scoped, fileId)!
    return { file, parts: normalized?.ok ? normalized.parts : [], parseState: input.parseState ?? 'parsed' }
  }, { behavior: 'immediate' })
  appLog({ module: 'sme-roster', source: 'file', operation: 'file.parse.revise', outcome: 'success', fileId, receiptId }, context)
  return result
}

/** Emit only after the receipt transaction returns; runtime retention never owns the receipt. */
export function saveParse105(db: Db, fileId: number, raw: unknown, mode?: 'replace' | 'status', context: LogContext = {}, filesDir?: string, verifiedPhysical = false) {
  const startedAt = Date.now()
  try {
    const result = saveParse105Unlogged(db, fileId, raw, mode, filesDir, verifiedPhysical)
    appLog({ module: 'sme-roster', source: 'file', operation: result.replayed ? 'file.parse.replay' : 'file.parse.revise', outcome: 'success', fileId, receiptId: result.receiptId, durationMs: Date.now() - startedAt }, context)
    return result
  } catch (error) {
    appLog({ module: 'sme-roster', source: 'file', operation: 'file.parse.revise', outcome: error instanceof ParseMaintenanceError ? 'denied' : 'failure', level: 'error', ...(error instanceof ParseMaintenanceError && error.statusCode === 409 ? { fileId } : {}), errorCode: error instanceof ParseMaintenanceError && error.statusCode === 409 ? 'file_parse_conflict' : 'file_parse_failed', durationMs: Date.now() - startedAt }, context)
    throw error
  }
}

function writeDeclarations669(db: Db, fileId: number, raw: z.infer<typeof parsePart105>[], previous: (typeof schema.fileDeclaration669.$inferSelect)[], inputRef?: InputRef310) {
  const sha256 = db.select().from(schema.storedFile).where(eq(schema.storedFile.id, fileId)).get()!.sha256
  const sequence = db.select({ maximum: sql<number>`coalesce(max(${schema.fileDeclaration669.displaySequence}), 0)` }).from(schema.fileDeclaration669).where(eq(schema.fileDeclaration669.fileId, fileId)).get()!.maximum
  const { next, withdrawn } = planDeclarations669(fileId, sha256, raw, previous, sequence, inputRef)
  for (const old of withdrawn) db.update(schema.fileDeclaration669).set({ active: false, revision: old.revision + 1 }).where(eq(schema.fileDeclaration669.declarationId, old.declarationId)).run()
  for (const declaration of next) db.insert(schema.fileDeclaration669).values(declaration).onConflictDoUpdate({ target: schema.fileDeclaration669.declarationId, set: declaration }).run()
}
