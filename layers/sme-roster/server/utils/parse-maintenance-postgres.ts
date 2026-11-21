import { randomUUID } from 'node:crypto'
import { and, desc, eq, gt, inArray, max, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type { z } from 'zod'
import type { fileParseAudit105 } from '../../../../db/schema'
import { ocrResult, storedFile } from '../../../../db/postgresql/file-tables'
import { fileDeclaration669 as declaration, fileParseAudit105 as audit, rosterFileClassification, storedFilePart } from '../../../../db/postgresql/roster-file-tables'
import { appLog, type LogContext } from '../../../core/lib/logging'
import { activePostgresPhysicalIntent, readPostgresFile, requirePostgresFileWrite } from '../../../core/server/utils/file-store-postgres'
import { readPdfPageCount } from '../../../core/server/utils/pdf-pages'
import { mergeParseParts } from './parse-result'
import { derivedPostgresFileParts, readPostgresRosterFileFields } from './roster-file-postgres'
import {
  equalParseInput, lineage310, modernEnvelope105, parseFrozenCommit310, parseHistory105, parsePreflight310,
  parseSave105, ParseMaintenanceError, planDeclarations669, prepareParseWrite105, projectParseState,
  readParseInput310, validateParseRevision, type InputRef310,
} from './parse-maintenance-105'

type Receipt = typeof fileParseAudit105.$inferSelect
type Mode = 'replace' | 'status' | 'commit'
const readOnlySnapshot = { isolationLevel: 'repeatable read', accessMode: 'read only' } as const
function fail(status: number, message: string): never { throw new ParseMaintenanceError(status, message) }
function parse<T extends z.ZodType>(schema: T, raw: unknown) {
  const parsed = schema.safeParse(raw)
  if (!parsed.success) return fail(400, parsed.error.message)
  return parsed.data as z.output<T>
}

async function loadFile(db: NodePgDatabase, fileId: number) {
  const [row] = await db.select({
    id: storedFile.id, relPath: storedFile.relPath, sha256: storedFile.sha256,
    removedAt: storedFile.removedAt, ext: storedFile.ext,
  }).from(storedFile).where(eq(storedFile.id, fileId))
  if (!row) return fail(404, '文件不存在')
  return row
}

async function lockFile(db: NodePgDatabase, fileId: number) {
  const rows = await db.select({ id: storedFile.id }).from(storedFile).where(eq(storedFile.id, fileId)).for('update')
  if (!rows.length) return fail(404, '文件不存在')
}

async function loadState(
  db: NodePgDatabase, file: Awaited<ReturnType<typeof loadFile>>, revision?: { id: number; after: Receipt['after'] },
) {
  const fields = (await readPostgresRosterFileFields(db, [file.id])).get(file.id)
  if (!fields) return fail(404, '文件不存在')
  if (!revision) {
    const [last] = await db.select({ id: audit.id }).from(audit)
      .where(eq(audit.fileId, file.id)).orderBy(desc(audit.id)).limit(1)
    if (last) revision = { id: last.id, after: { inputLineage: fields.partsBinding.inputLineage } }
  }
  const derived = await derivedPostgresFileParts(db, file.relPath)
  return projectParseState({ ...file, parseState: fields.parseState }, fields.parts, fields.registeredSummary.declarations, derived, revision)
}

export function getPostgresParseState(db: NodePgDatabase, fileId: number) {
  return db.transaction(async tx => loadState(tx, await loadFile(tx, fileId)), readOnlySnapshot)
}

async function currentInput(
  db: NodePgDatabase, file: Awaited<ReturnType<typeof loadFile>>, selection: Pick<InputRef310,'kind' | 'pages'>,
  root: string, physicalSource?: InputRef310['physicalSource'],
) {
  const input = readParseInput310(file, selection, root, physicalSource)
  if (input.pages.length) {
    const rows = await db.select({
      page: ocrResult.page, version: sql<string>`${ocrResult.id} || ':' || ${ocrResult.revision}`,
    }).from(ocrResult).where(and(eq(ocrResult.fileId, file.id), inArray(ocrResult.page, input.pages.map(page => page.page))))
    const versions = new Map(rows.map(row => [row.page, row.version]))
    if (input.pages.some(page => versions.get(page.page) !== page.version)) return fail(409, '解析 OCR 输入已变化,请重新读取实际采用页后预检')
  }
  return input
}

async function physicalInput(db: NodePgDatabase, file: Awaited<ReturnType<typeof loadFile>>, input: InputRef310, root: string) {
  if (file.ext.toLowerCase() !== 'pdf') return fail(409, '不支持页码定位: Office等文件无可靠物理页数')
  const before = await currentInput(db, file, input, root, { pageCount: 1, contentVersion: '' })
  const pageCount = await readPdfPageCount(root, file.relPath)
  if (!pageCount) return fail(409, '无法核实实际PDF物理页数,不支持页码定位')
  const after = await currentInput(db, file, input, root, { pageCount, contentVersion: '' })
  if (before.physicalSource!.contentVersion !== after.physicalSource!.contentVersion) return fail(409, '文件内容版本已变化,请重新预检')
  return after
}

export function preflightPostgresParse(db: NodePgDatabase, fileId: number, raw: unknown, root: string) {
  const input = parse(parsePreflight310, raw)
  return db.transaction(async tx => {
    const file = await loadFile(tx, fileId)
    const { version: expectedVersion } = await loadState(tx, file)
    const ref = await currentInput(tx, file, input, root)
    return { expectedVersion, inputRef: input.verifyPhysicalPages ? await physicalInput(tx, file, ref, root) : ref }
  }, readOnlySnapshot)
}

async function writeParse(
  db: NodePgDatabase, fileId: number, command: ReturnType<typeof prepareParseWrite105>, root: string, mode?: Mode,
) {
  const { input, parts, parseState, inputRef, requestHash } = command
  const [receipt] = await db.select({
    receiptId: audit.id, requestHash: audit.requestHash, state: sql<Receipt['after']>`${audit.after}::json`,
  }).from(audit).where(and(eq(audit.fileId, fileId), eq(audit.idempotencyKey, input.idempotencyKey)))
  if (receipt) {
    if (receipt.requestHash !== requestHash) return fail(409, '幂等键已用于不同解析请求')
    return { receiptId: receipt.receiptId, replayed: true, state: receipt.state }
  }
  if (await activePostgresPhysicalIntent(db, fileId)) return fail(409, '文件正在隔离或恢复')
  const file = await loadFile(db, fileId)
  if (mode === 'commit' && inputRef?.physicalSource) {
    const verified = await physicalInput(db, file, inputRef, root)
    if (!equalParseInput(verified, inputRef)) return fail(409, '文件内容版本已变化,请重新预检')
  }
  const before = await loadState(db, file)
  validateParseRevision(before, command, mode === 'commit')
  if (inputRef) {
    try {
      const verified = await currentInput(db, file, inputRef, root, inputRef.physicalSource)
      if (!equalParseInput(verified, inputRef)) return fail(409, '解析输入已变化,请重新读取并预检后提交')
    } catch (error) {
      if (error instanceof ParseMaintenanceError) return fail(409, '解析输入已变化,请重新读取并预检后提交')
      throw error
    }
  }
  if (parts !== undefined) {
    const [counter] = await db.select({ maximum: max(declaration.displaySequence) }).from(declaration)
      .where(eq(declaration.fileId, fileId))
    const { next, withdrawn } = planDeclarations669(fileId, file.sha256, input.parts!, before.declarations, counter?.maximum ?? 0, inputRef)
    if (withdrawn.length) {
      await db.update(declaration).set({ active: 0, revision: sql`${declaration.revision} + 1` })
        .where(inArray(declaration.declarationId, withdrawn.map(row => row.declarationId)))
    }
    if (next.length) {
      await db.insert(declaration).values(next.map(row => ({
        ...row, fileId, active: 1, part: JSON.stringify(row.part),
        pageRanges: row.pageRanges == null ? null : JSON.stringify(row.pageRanges),
      }))).onConflictDoUpdate({ target: declaration.declarationId, set: {
        displaySequence: sql`excluded.display_sequence`, revision: sql`excluded.revision`, active: 1,
        sha256: sql`excluded.sha256`, contentVersion: sql`excluded.content_version`,
        part: sql`excluded.part`, pageRanges: sql`excluded.page_ranges`,
      } })
    }
    const stored = mergeParseParts(parts, before.ingestionStatistics.parts)
    await db.delete(storedFilePart).where(eq(storedFilePart.fileId, fileId))
    if (stored.length) {
      // A single bind covers every derived part, even when the merged set exceeds bind limits.
      const rows = db.select({
        fileId: sql<number>`${fileId}`, titleCode: sql<string>`p."titleCode"`,
        eventKind: sql<typeof storedFilePart.$inferSelect.eventKind>`p."eventKind"`,
        year: sql<number | null>`p.year`, batch: sql<number | null>`p.batch`, attachment: sql<string | null>`p.attachment`,
        rowCount: sql<number>`p."rowCount"`, origin: sql<typeof storedFilePart.$inferSelect.origin>`p.origin`,
        hasConflict: sql<number>`CASE WHEN p."hasConflict" THEN 1 ELSE 0 END`,
      }).from(sql`json_to_recordset(${JSON.stringify(stored)}::json) AS p(
        "titleCode" text, "eventKind" text, year bigint, batch bigint, attachment text, "rowCount" bigint, origin text, "hasConflict" boolean)`)
      // Drizzle insert-select includes the identity column. Omit it so PostgreSQL allocates IDs.
      await db.execute(sql`
        INSERT INTO ${storedFilePart} (file_id,title_code,event_kind,year,batch,attachment,row_count,origin,has_conflict)
        ${rows}`)
    }
  }
  await db.update(rosterFileClassification).set({ parseState }).where(eq(rosterFileClassification.fileId, fileId))
  // The receipt ID participates in the returned state version before its append-only row is inserted.
  const { rows: [sequence] } = await db.execute<{ id: string }>(sql`
    SELECT nextval(pg_get_serial_sequence('business.file_parse_audit_105', 'id')) AS id`)
  const receiptId = Number(sequence!.id)
  const inputLineage = parts === undefined ? before.inputLineage
    : inputRef ? { status: 'bound' as const, inputRef } : { status: 'unknown' as const }
  const state = await loadState(db, file, { id: receiptId, after: { inputLineage } })
  await db.insert(audit).overridingSystemValue().values({
    id: receiptId, fileId, idempotencyKey: input.idempotencyKey, requestHash,
    operation: parts === undefined ? 'status' : 'replace', actor: JSON.stringify(input.actor),
    reason: input.reason, before: JSON.stringify(before), after: JSON.stringify(state), createdAt: new Date().toISOString(),
  })
  return { receiptId, replayed: false, state }
}

export async function savePostgresParse(db: NodePgDatabase, fileId: number, raw: unknown, root: string, mode?: Mode, context: LogContext = {}) {
  requirePostgresFileWrite()
  const startedAt = Date.now()
  try {
    const command = prepareParseWrite105(mode === 'commit' ? parse(parseFrozenCommit310, raw) : raw, mode === 'commit' ? undefined : mode)
    const result = await db.transaction(async tx => {
      await lockFile(tx, fileId)
      return writeParse(tx, fileId, command, root, mode)
    })
    appLog({ module: 'sme-roster', source: 'file', operation: result.replayed ? 'file.parse.replay' : 'file.parse.revise',
      outcome: 'success', fileId, receiptId: result.receiptId, durationMs: Date.now() - startedAt }, context)
    return result
  } catch (error) {
    const conflict = error instanceof ParseMaintenanceError && error.statusCode === 409
    appLog({ module: 'sme-roster', source: 'file', operation: 'file.parse.revise',
      outcome: error instanceof ParseMaintenanceError ? 'denied' : 'failure', level: 'error',
      ...(conflict ? { fileId } : {}), errorCode: conflict ? 'file_parse_conflict' : 'file_parse_failed', durationMs: Date.now() - startedAt }, context)
    throw error
  }
}

export function historyPostgresParse(db: NodePgDatabase, raw: unknown) {
  const { fileId, receiptId, afterId = 0, limit = 20 } = parse(parseHistory105, raw)
  return db.transaction(async tx => {
    await loadFile(tx, fileId)
    const scope = eq(audit.fileId, fileId)
    const columns = {
      fileId: audit.fileId, operation: audit.operation, actor: sql<Receipt['actor']>`${audit.actor}::json`,
      reason: audit.reason, idempotencyKey: audit.idempotencyKey, createdAt: audit.createdAt,
    }
    if (receiptId !== undefined) {
      const [receipt] = await tx.select({
        id: audit.id, ...columns, before: sql<Receipt['before']>`${audit.before}::json`, after: sql<Receipt['after']>`${audit.after}::json`,
      }).from(audit).where(and(scope, eq(audit.id, receiptId)))
      if (!receipt) return fail(404, '解析回执不存在')
      return { ...receipt, inputLineage: lineage310(receipt.after) }
    }
    const rows = await tx.select({ receiptId: audit.id, ...columns }).from(audit)
      .where(and(scope, gt(audit.id, afterId))).orderBy(audit.id).limit(limit + 1)
    return { fileId, rows: rows.slice(0, limit), nextAfterId: rows.length > limit ? rows[limit - 1]!.receiptId : null }
  }, readOnlySnapshot)
}

export async function savePostgresParseMcp(db: NodePgDatabase, raw: unknown, root: string, context: LogContext = {}) {
  const { fileId, relPath, ...input } = parse(parseSave105, raw)
  let id = fileId
  if (id === undefined && !relPath!.includes('\0')) {
    const [row] = await db.select({ id: storedFile.id }).from(storedFile).where(eq(storedFile.relPath, relPath!))
    if (row) id = row.id
  }
  if (id === undefined) return fail(404, '文件不存在')
  if (modernEnvelope105.some(key => input[key] !== undefined)) return savePostgresParse(db, id, input, root, undefined, context)
  requirePostgresFileWrite()
  const result = await db.transaction(async tx => {
    await lockFile(tx, id)
    const current = await loadState(tx, await loadFile(tx, id))
    const command = prepareParseWrite105({ parts: input.parts, parseState: input.parseState, expectedVersion: current.version,
      idempotencyKey: `legacy-save-parse:${randomUUID()}`, actor: { type: 'agent', id: 'legacy-adapter:save_parse_result' },
      reason: '兼容旧 save_parse_result 盲写；客户端未提供版本、幂等键、操作者或确认依据' })
    const receipt = await writeParse(tx, id, command, root)
    const { contentIdentity: _identity, partsBinding: _binding, registeredSummary: _summary, ...file } = await readPostgresFile(tx, id)
    return { receiptId: receipt.receiptId, value: { file, parts: command.parts ?? [], parseState: command.parseState } }
  })
  appLog({ module: 'sme-roster', source: 'file', operation: 'file.parse.revise', outcome: 'success', fileId: id, receiptId: result.receiptId }, context)
  return result.value
}
