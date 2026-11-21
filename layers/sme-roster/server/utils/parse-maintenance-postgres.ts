import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type { z } from 'zod'
import type { fileParseAudit105 } from '../../../../db/schema'
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
  const { rows: [row] } = await db.execute<{
    id: string; relPath: string; sha256: string; removedAt: string | null; ext: string;
  }>(sql`
    SELECT id, rel_path AS "relPath", sha256, removed_at AS "removedAt", ext
    FROM stored_file WHERE id = ${fileId}`)
  if (!row) return fail(404, '文件不存在')
  return { ...row, id: Number(row.id) }
}

async function lockFile(db: NodePgDatabase, fileId: number) {
  const { rows } = await db.execute(sql`SELECT id FROM stored_file WHERE id = ${fileId} FOR UPDATE`)
  if (!rows.length) return fail(404, '文件不存在')
}

async function loadState(
  db: NodePgDatabase, file: Awaited<ReturnType<typeof loadFile>>, revision?: { id: number; after: Receipt['after'] },
) {
  const fields = (await readPostgresRosterFileFields(db, [file.id])).get(file.id)
  if (!fields) return fail(404, '文件不存在')
  if (!revision) {
    const { rows: [last] } = await db.execute<{ id: string }>(sql`
      SELECT id FROM file_parse_audit_105 WHERE file_id = ${file.id} ORDER BY id DESC LIMIT 1`)
    if (last) revision = { id: Number(last.id), after: { inputLineage: fields.partsBinding.inputLineage } }
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
    const { rows } = await db.execute<{ page: string; version: string }>(sql`
      SELECT page_no AS page, id || ':' || revision AS version FROM ocr_result
      WHERE file_id = ${file.id} AND page_no = ANY(${sql.param(input.pages.map(page => page.page))}::bigint[])`)
    const versions = new Map(rows.map(row => [Number(row.page), row.version]))
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
  const { rows: [receipt] } = await db.execute<{ receiptId: string; requestHash: string; state: Receipt['after'] }>(sql`
    SELECT id AS "receiptId", request_hash AS "requestHash", after::json AS state FROM file_parse_audit_105
    WHERE file_id = ${fileId} AND idempotency_key = ${input.idempotencyKey}`)
  if (receipt) {
    if (receipt.requestHash !== requestHash) return fail(409, '幂等键已用于不同解析请求')
    return { receiptId: Number(receipt.receiptId), replayed: true, state: receipt.state }
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
    const { rows: [counter] } = await db.execute<{ maximum: string }>(sql`
      SELECT coalesce(max(display_sequence),0) AS maximum FROM file_declaration_669 WHERE file_id = ${fileId}`)
    const { next, withdrawn } = planDeclarations669(fileId, file.sha256, input.parts!, before.declarations, Number(counter!.maximum), inputRef)
    if (withdrawn.length) await db.execute(sql`
      UPDATE file_declaration_669 SET active = 0, revision = revision + 1
      WHERE declaration_id = ANY(${sql.param(withdrawn.map(value => value.declarationId))}::text[])`)
    if (next.length) await db.execute(sql`
      INSERT INTO file_declaration_669 (file_id,declaration_id,display_sequence,revision,active,sha256,content_version,part,page_ranges)
      VALUES ${sql.join(next.map(d => sql`(${fileId},${d.declarationId},${d.displaySequence},${d.revision},1,${d.sha256},
        ${d.contentVersion},${JSON.stringify(d.part)},${d.pageRanges == null ? null : JSON.stringify(d.pageRanges)})`), sql`,`)}
      ON CONFLICT (declaration_id) DO UPDATE SET
        display_sequence = excluded.display_sequence, revision = excluded.revision, active = 1,
        sha256 = excluded.sha256, content_version = excluded.content_version, part = excluded.part, page_ranges = excluded.page_ranges`)
    const stored = mergeParseParts(parts, before.ingestionStatistics.parts)
    await db.execute(sql`DELETE FROM stored_file_part WHERE file_id = ${fileId}`)
    if (stored.length) {
      await db.execute(sql`
        INSERT INTO stored_file_part (file_id,title_code,event_kind,year,batch,attachment,row_count,origin,has_conflict)
        SELECT ${fileId}, p."titleCode", p."eventKind", p.year, p.batch, p.attachment, p."rowCount", p.origin,
          CASE WHEN p."hasConflict" THEN 1 ELSE 0 END
        FROM json_to_recordset(${JSON.stringify(stored)}::json) AS p(
          "titleCode" text, "eventKind" text, year bigint, batch bigint, attachment text, "rowCount" bigint, origin text, "hasConflict" boolean)`)
    }
  }
  await db.execute(sql`UPDATE roster_file_classification SET parse_state = ${parseState} WHERE file_id = ${fileId}`)
  const { rows: [audit] } = await db.execute<{ id: string }>(sql`
    SELECT nextval(pg_get_serial_sequence('business.file_parse_audit_105', 'id')) AS id`)
  const receiptId = Number(audit!.id)
  const inputLineage = parts === undefined ? before.inputLineage
    : inputRef ? { status: 'bound' as const, inputRef } : { status: 'unknown' as const }
  const state = await loadState(db, file, { id: receiptId, after: { inputLineage } })
  await db.execute(sql`
    INSERT INTO file_parse_audit_105 (id,file_id,idempotency_key,request_hash,operation,actor,reason,before,after,created_at)
    OVERRIDING SYSTEM VALUE
    VALUES (${receiptId},${fileId},${input.idempotencyKey},${requestHash},${parts === undefined ? 'status' : 'replace'},
      ${JSON.stringify(input.actor)},${input.reason},${JSON.stringify(before)},${JSON.stringify(state)},${new Date().toISOString()})`)
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
    const scope = sql`FROM file_parse_audit_105 WHERE file_id = ${fileId}`
    const columns = sql`'fileId',file_id,'operation',operation,'actor',actor::json,'reason',reason,
      'idempotencyKey',idempotency_key,'createdAt',created_at`
    if (receiptId !== undefined) {
      const { rows: [row] } = await tx.execute<{ receipt: Omit<Receipt, 'requestHash'> }>(sql`
        SELECT json_build_object('id',id,${columns},'before',before::json,'after',after::json) AS receipt
        ${scope} AND id = ${receiptId}`)
      if (!row) return fail(404, '解析回执不存在')
      return { ...row.receipt, inputLineage: lineage310(row.receipt.after) }
    }
    const { rows } = await tx.execute<{ item: Pick<Receipt, 'fileId' | 'operation' | 'actor' | 'reason' | 'idempotencyKey' | 'createdAt'> & { receiptId: number } }>(sql`
      SELECT json_build_object('receiptId',id,${columns}) AS item
      ${scope} AND id > ${afterId} ORDER BY id LIMIT ${limit + 1}`)
    return { fileId, rows: rows.slice(0, limit).map(row => row.item), nextAfterId: rows.length > limit ? rows[limit - 1]!.item.receiptId : null }
  }, readOnlySnapshot)
}

export async function savePostgresParseMcp(db: NodePgDatabase, raw: unknown, root: string, context: LogContext = {}) {
  const { fileId, relPath, ...input } = parse(parseSave105, raw)
  let id = fileId
  if (id === undefined && !relPath!.includes('\0')) {
    const { rows: [row] } = await db.execute<{ id: string }>(sql`SELECT id FROM stored_file WHERE rel_path = ${relPath!}`)
    if (row) id = Number(row.id)
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
