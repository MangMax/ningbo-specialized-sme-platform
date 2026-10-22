import { appLog, type LogContext } from '../../lib/logging'
import { createHash, randomUUID } from 'node:crypto'
import { and, desc, eq, gt } from 'drizzle-orm'
import { z } from 'zod'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../../db/schema'
import { EVENT_ORDER, TITLE_ORDER } from '../../lib/labels'
import { derivedPartsForFile, listFileParts } from './file-parts'
import { applyParseResult, normalizeParseParts } from './parse-result'
import { getStoredFile } from './stored-files'

type Db = BetterSQLite3Database<typeof schema>
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
  idempotencyKey: z.string().trim().min(1).max(200),
  actor: z.strictObject({ type: z.enum(['user', 'agent']), id: z.string().trim().min(1).max(200) }),
  reason: z.string().trim().min(1).max(2000),
}).refine(v => v.parts !== undefined || v.parseState !== undefined, '至少给 parts 或 parseState')
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
export const parseRead105 = z.strictObject({ fileId: z.number().int().positive() })
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

/** Exact-ID projection. Source-derived coordinates participate in the edit version too. */
export function readParse105(db: Db, fileId: number) {
  const file = db.select({ id: schema.storedFile.id, parseState: schema.storedFile.parseState, removedAt: schema.storedFile.removedAt })
    .from(schema.storedFile).where(eq(schema.storedFile.id, fileId)).get()
  if (!file) return fail(404, '文件不存在')
  const parts = listFileParts(db, [fileId]).get(fileId) ?? []
  const last = db.select({ id: schema.fileParseAudit105.id }).from(schema.fileParseAudit105)
    .where(eq(schema.fileParseAudit105.fileId, fileId)).orderBy(desc(schema.fileParseAudit105.id)).limit(1).get()
  const version = hash({ fileId, parseState: file.parseState, removedAt: file.removedAt, parts, derived: derivedPartsForFile(db, fileId), revision: last?.id ?? 0 })
  return { fileId, parseState: file.parseState, parts, version, removedAt: file.removedAt }
}
export function getParse105(db: Db, fileId: number) {
  return db.transaction(tx => readParse105(tx as Db, fileId))
}

/** One atomic parse resource write, shared by REST and MCP. Replay precedes version checks. */
function saveParse105Unlogged(db: Db, fileId: number, raw: unknown, mode?: 'replace' | 'status') {
  const parsed = parseWrite105.safeParse(raw)
  if (!parsed.success) return fail(400, parsed.error.message)
  const input = parsed.data
  if (mode === 'replace' && input.parts === undefined) return fail(400, 'PUT 必须提供全部代理段 parts')
  if (mode === 'status' && (input.parts !== undefined || input.parseState === undefined)) return fail(400, 'PATCH 只允许 parseState,不得提供 parts')
  const normalized = input.parts === undefined ? undefined : normalizeParseParts(input.parts)
  if (normalized && !normalized.ok) return fail(400, normalized.message)
  const parts = normalized?.ok ? normalized.parts : undefined
  const parseState = input.parseState ?? 'parsed'
  const requestHash = hash({ expectedVersion: input.expectedVersion, parts, parseState, actor: input.actor, reason: input.reason })
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
    const written = applyParseResult(scoped, fileId, { parts, parseState })
    if (!written.ok) return fail(400, written.message)
    const audit = tx.insert(schema.fileParseAudit105).values({
      fileId, idempotencyKey: input.idempotencyKey, requestHash,
      operation: parts === undefined ? 'status' : 'replace', actor: input.actor, reason: input.reason,
      before, after: {}, createdAt: new Date().toISOString(),
    }).returning({ id: schema.fileParseAudit105.id }).get()
    const after = readParse105(scoped, fileId)
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
    return publicReceipt
  }
  const rows = db.select({ receiptId: schema.fileParseAudit105.id, fileId: schema.fileParseAudit105.fileId,
    operation: schema.fileParseAudit105.operation, actor: schema.fileParseAudit105.actor, reason: schema.fileParseAudit105.reason,
    idempotencyKey: schema.fileParseAudit105.idempotencyKey, createdAt: schema.fileParseAudit105.createdAt,
  }).from(schema.fileParseAudit105).where(and(eq(schema.fileParseAudit105.fileId, fileId), gt(schema.fileParseAudit105.id, afterId)))
    .orderBy(schema.fileParseAudit105.id).limit(limit + 1).all()
  return { fileId, rows: rows.slice(0, limit), nextAfterId: rows.length > limit ? rows[limit - 1]!.receiptId : null }
}

/** Preserve the existing MCP exact-path alias; all writes/receipts bind to the resolved ID. */
export function saveParseMcp105(db: Db, raw: unknown, context: LogContext = {}) {
  const parsed = parseSave105.safeParse(raw)
  if (!parsed.success) return fail(400, parsed.error.message)
  const { fileId, relPath, ...input } = parsed.data
  const id = fileId ?? db.select({ id: schema.storedFile.id }).from(schema.storedFile)
    .where(eq(schema.storedFile.relPath, relPath!)).get()?.id
  if (id === undefined) return fail(404, '文件不存在')
  if (modernEnvelope105.some(key => input[key] !== undefined)) return saveParse105(db, id, input, undefined, context)
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
export function saveParse105(db: Db, fileId: number, raw: unknown, mode?: 'replace' | 'status', context: LogContext = {}) {
  const startedAt = Date.now()
  try {
    const result = saveParse105Unlogged(db, fileId, raw, mode)
    appLog({ source: 'file', operation: result.replayed ? 'file.parse.replay' : 'file.parse.revise', outcome: 'success', fileId, receiptId: result.receiptId, durationMs: Date.now() - startedAt }, context)
    return result
  } catch (error) {
    appLog({ source: 'file', operation: 'file.parse.revise', outcome: error instanceof ParseMaintenanceError ? 'denied' : 'failure', level: 'error', ...(error instanceof ParseMaintenanceError && error.statusCode === 409 ? { fileId } : {}), errorCode: error instanceof ParseMaintenanceError && error.statusCode === 409 ? 'file_parse_conflict' : 'file_parse_failed', durationMs: Date.now() - startedAt }, context)
    throw error
  }
}
