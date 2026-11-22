import { createHash, randomUUID } from 'node:crypto'
import { closeSync, fstatSync, openSync, readSync, realpathSync, statSync, type BigIntStats } from 'node:fs'
import { resolve, sep } from 'node:path'
import { z } from 'zod'
import type { storedFile } from '../../../../db/postgresql/file-tables'
import type { RegisteredDeclaration } from './registered-declaration-summary'
import { EVENT_ORDER, TITLE_ORDER } from '../../lib/labels'
import { partKey, type StoredFilePart } from '../../lib/file-parts'
import type { FilePart } from '../../../../db/file-part'
import { normalizeParseParts } from './parse-result-model'
import { registeredSummary681 } from './registered-declaration-summary'

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
export type InputRef310 = z.infer<typeof parseInputRef310>
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
export const modernEnvelope105 = ['expectedVersion', 'idempotencyKey', 'actor', 'reason'] as const
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
export function failParseMaintenance(status: number, message: string): never { throw new ParseMaintenanceError(status, message) }
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
// Reading may update atime. It must not change source identity, contents or metadata.
const inputFileStamp310 = (stat: BigIntStats) => [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].join(':')

export function readParseInput310(
  file: Pick<typeof storedFile.$inferSelect, 'id' | 'relPath' | 'sha256' | 'removedAt'>,
  selection: Pick<InputRef310, 'kind' | 'pages'>,
  filesDir: string, physicalSource?: InputRef310['physicalSource'],
): InputRef310 {
  if (file.removedAt) return failParseMaintenance(409, '已移出文件不允许解析预检')
  let sha256: string
  let contentVersion: string
  try {
    const root = realpathSync(filesDir), path = realpathSync(resolve(root, file.relPath))
    if (!path.startsWith(root + sep)) return failParseMaintenance(409, '文件路径越界')
    const before = statSync(path, { bigint: true })
    if (!before.isFile()) return failParseMaintenance(409, '解析输入必须是普通文件')
    const fd = openSync(path, 'r')
    try {
      const opened = fstatSync(fd, { bigint: true })
      if (inputFileStamp310(opened) !== inputFileStamp310(before)) return failParseMaintenance(409, '解析输入在打开时已变化')
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
        || inputFileStamp310(current) !== inputFileStamp310(opened)) return failParseMaintenance(409, '解析输入在读取期间已变化')
      // This is a read-consistency check, not a filesystem lock. External
      // replacements after this final verification remain the #311 boundary.
    } finally { closeSync(fd) }
  } catch { return failParseMaintenance(409, '无法核实解析文件内容身份,请重新读取并核实文件') }
  if (sha256 !== file.sha256) return failParseMaintenance(409, '解析文件内容身份与登记不符,请重新读取并核实文件')
  const pages = [...selection.pages].sort((a, b) => a.page - b.page)
  return { format: 1, fileId: file.id, relPath: file.relPath, sha256, kind: selection.kind, pages, ...(physicalSource ? { physicalSource: { pageCount: physicalSource.pageCount, contentVersion } } : {}) }
}

export function equalParseInput(actual: InputRef310, expected: InputRef310) {
  const { format, fileId, relPath, sha256, kind, pages, physicalSource } = expected
  return hash(actual) === hash({ format, fileId, relPath, sha256, kind, pages, ...(physicalSource ? { physicalSource } : {}) })
}

export function lineage310(snapshot: Record<string, unknown> | undefined): InputLineage310 {
  const lineage = snapshot?.inputLineage as InputLineage310 | undefined
  return lineage?.status === 'bound' ? lineage : { status: 'unknown' }
}

export function projectParseState(
  file: { id: number; sha256: string; parseState: string; removedAt: string | null }, parts: StoredFilePart[],
  declarations: Parameters<typeof registeredSummary681>[0], derived: FilePart[],
  last?: { id: number; after: Record<string, unknown> },
) {
  const { id: fileId, sha256, parseState, removedAt } = file
  const version = hash({ sha256, declarations, fileId, parseState, removedAt, parts, derived, revision: last?.id ?? 0 })
  return { fileId, parseState, parts, declarations, registeredSummary: registeredSummary681(declarations), ingestionStatistics: { parts: derived, rowCount: derived.reduce((sum, part) => sum + part.rowCount, 0) }, version, removedAt, inputLineage: lineage310(last?.after) }
}

/** One atomic parse resource write, shared by REST and MCP. Replay precedes version checks. */
export function prepareParseWrite105(raw: unknown, mode?: 'replace' | 'status') {
  const parsed = parseWrite105.safeParse(raw)
  if (!parsed.success) return failParseMaintenance(400, parsed.error.message)
  const input = parsed.data
  if (mode === 'replace' && input.parts === undefined) return failParseMaintenance(400, 'PUT 必须提供全部代理段 parts')
  if (mode === 'status' && (input.parts !== undefined || input.parseState === undefined)) return failParseMaintenance(400, 'PATCH 只允许 parseState,不得提供 parts')
  const normalized = input.parts === undefined ? undefined : normalizeParseParts(input.parts)
  if (normalized && !normalized.ok) return failParseMaintenance(400, normalized.message)
  const parts = normalized?.ok ? normalized.parts : undefined
  const parseState = input.parseState ?? 'parsed'
  const inputRef = input.inputRef && { ...input.inputRef, pages: [...input.inputRef.pages].sort((a, b) => a.page - b.page) }
  // Omit absent lineage to preserve old request hashes and immutable receipt replay.
  const requestHash = hash({ expectedVersion: input.expectedVersion, parts, parseState, actor: input.actor, reason: input.reason, ...(inputRef ? { inputRef } : {}), ...(input.parts?.some(p => p.declarationId !== undefined || p.pageRanges !== undefined) ? { rangeEdits: input.parts.map(p => ({ declarationId: p.declarationId, pageRanges: p.pageRanges })) } : {}) })
  return { input, parts, parseState, inputRef, requestHash }
}

export function validateParseRevision(before: ReturnType<typeof projectParseState>, command: ReturnType<typeof prepareParseWrite105>, verifiedPhysical: boolean) {
  const { input, inputRef, parts } = command
  if (before.removedAt) return failParseMaintenance(409, '已移出文件不允许修改解析结果')
  if (before.version !== input.expectedVersion) return failParseMaintenance(409, '解析版本冲突,请重新读取后提交')
  if (parts !== undefined && !inputRef && before.inputLineage.status === 'bound') {
    return failParseMaintenance(409, '解析已绑定输入依据,请重新读取并预检后携完整 inputRef 提交;不得降级覆盖')
  }
  if (inputRef?.physicalSource && !verifiedPhysical) return failParseMaintenance(409, '物理页码输入必须经冻结commit提交')
  if (input.parts?.some(p => p.pageRanges?.length) && !inputRef?.physicalSource) return failParseMaintenance(409, '页码范围必须先verifyPhysicalPages预检')
}

export function planDeclarations669(
  fileId: number, sha256: string, raw: z.infer<typeof parsePart105>[],
  previous: RegisteredDeclaration[], sequence: number, inputRef?: InputRef310,
) {
  const used = new Set<string>()
  const next = raw.map(item => {
    const normalized = normalizeParseParts([item])
    if (!normalized.ok) return failParseMaintenance(400, normalized.message)
    const part = normalized.parts[0]!
    const old = item.declarationId ? previous.find(p => p.declarationId === item.declarationId) : previous.find(p => partKey(p.part) === partKey(part))
    if (item.declarationId && !old) return failParseMaintenance(409, '声明不属于当前文件或已撤回')
    const declarationId = old?.declarationId ?? randomUUID()
    if (used.has(declarationId)) return failParseMaintenance(400, '声明身份重复')
    used.add(declarationId)
    let pageRanges = old?.pageRanges ?? null
    if (item.pageRanges !== undefined) {
      pageRanges = []
      for (const range of [...item.pageRanges].sort((a, b) => a.start - b.start || a.end - b.end)) {
        if (range.end > (inputRef?.physicalSource?.pageCount ?? 0)) return failParseMaintenance(400, '页码范围超出实际物理页数')
        const last = pageRanges.at(-1)
        if (last && range.start <= last.end) last.end = Math.max(last.end, range.end)
        else pageRanges.push({ ...range })
      }
    }
    if (old && old.sha256 !== sha256 && pageRanges?.length && item.pageRanges === undefined) return failParseMaintenance(409, '文件内容已变化,必须重新核实范围或显式清空')
    if (old?.pageRanges?.length && item.pageRanges === undefined && inputRef?.physicalSource && old.contentVersion !== inputRef.physicalSource.contentVersion) return failParseMaintenance(409, '范围依据内容版本已变化,必须重新核实范围或显式清空')
    const contentVersion = item.pageRanges !== undefined ? inputRef?.physicalSource?.contentVersion ?? null : old?.contentVersion ?? null
    return { displaySequence: old?.displaySequence ?? ++sequence, contentVersion, declarationId, fileId, revision: (old?.revision ?? 0) + 1, active: true, sha256, part, pageRanges }
  })
  return { next, withdrawn: previous.filter(old => !used.has(old.declarationId)) }
}
