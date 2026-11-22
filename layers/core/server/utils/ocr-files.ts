import { requirePostgresFileRef, type FileRefInput } from './file-agent-reference'
import { readPostgresFileIdentity, usePostgresFileDb, type PostgresFileDb } from './file-store-postgres'
import { describeFileReadAtLocator } from './file-read'
import type { OcrWriteInput } from './ocr-result-contract'
import { deletePostgresOcrPage, listPostgresOcrResults, writePostgresOcrResult } from './ocr-result-postgres'
import { createError } from 'h3'
import type { LogContext } from '../../lib/logging'

export type OcrFileTarget = {
  ok: true
  db: PostgresFileDb
  root: string
  row: Awaited<ReturnType<typeof requirePostgresFileRef>>
}
export type OcrFileTargetResult =
  | OcrFileTarget
  | { ok: false; statusCode: number; message: string }

/**
 * 解析目标文件。
 *
 * `allowRemoved` 默认 **false**(写口用):往一个已移出库的文件上写 OCR 结果,
 * 会让它带着新数据继续缺席在列表外,是个说不清的状态 —— 与票 18 的写 tool 同一条口径。
 * 读口(`GET`)传 `true`:「这文件还在不在库里」本身就是要查的信息。
 */
export async function resolveOcrFileTarget(
  input: FileRefInput,
  options: { allowRemoved?: boolean } = {},
  root: string = useRuntimeConfig().filesDir,
): Promise<OcrFileTargetResult> {
  const hasId = input.fileId !== undefined && input.fileId !== null
  const hasPath = typeof input.relPath === 'string' && input.relPath.trim() !== ''
  if (hasId === hasPath || (hasId && (!Number.isSafeInteger(input.fileId) || input.fileId! <= 0))) {
    return { ok: false, statusCode: 400, message: '文件引用非法:fileId 与路径恰给其一,ID 必须是正整数' }
  }
  const db = usePostgresFileDb()
  try {
    const row = await requirePostgresFileRef(db, input, options)
    return { ok: true, db, root, row }
  } catch (error) {
    if ((error as { statusCode?: number }).statusCode !== 404) throw error
    return { ok: false, statusCode: 404, message: (error as Error).message }
  }
}

export async function requireOcrFileTarget(input: FileRefInput, options: { allowRemoved?: boolean } = {}, root?: string) {
  const target = await resolveOcrFileTarget(input, options, root)
  if (!target.ok) throw createError({ statusCode: target.statusCode, message: target.message })
  return target
}

export function readOcrFileResults(target: OcrFileTarget, page?: number | null) {
  return listPostgresOcrResults(target.db, target.row.id, page)
}

export function describeOcrFile(target: OcrFileTarget) {
  return describeFileReadAtLocator(target.root, target.row.relPath, path => readPostgresFileIdentity(target.db, path))
}

export function writeOcrFileResults(target: OcrFileTarget, input: OcrWriteInput) {
  return writePostgresOcrResult(target.db, input)
}

export function deleteOcrFilePage(target: OcrFileTarget, page: number, expectedVersion?: string | null, context?: LogContext) {
  return deletePostgresOcrPage(target.db, target.row.id, page, expectedVersion, context)
}

/**
 * 查询参数里的文件引用(`file` 是 relPath 的简写,与 `/api/pdf-pages` 同一口径)。
 *
 * `fileId` 写成了非数字 ⇒ **400**,不是 404:那是**参数写错**,不是「文件不存在」。
 * 两种情形给同一个码会让「我把 id 填成了路径」要多试一轮。
 */
export function fileRefFromQuery(
  q: Record<string, unknown>,
):
  | { ok: true; ref: FileRefInput }
  | { ok: false; statusCode: 400; message: string } {
  const rawId = q.fileId
  if ((rawId !== undefined && typeof rawId !== 'string' && typeof rawId !== 'number') || (q.file !== undefined && typeof q.file !== 'string')) {
    return { ok: false, statusCode: 400, message: '文件引用必须是单值' }
  }
  const relPath = typeof q.file === 'string' && q.file.trim() ? q.file.trim() : null

  if (rawId === undefined || rawId === null || rawId === '') {
    if (!relPath) {
      return {
        ok: false,
        statusCode: 400,
        message: '缺少文件引用:给 `file`(相对文件库根的路径)或 `fileId` 之一',
      }
    }
    return { ok: true, ref: { relPath } }
  }
  const fileId = Number(rawId)
  if (!Number.isSafeInteger(fileId) || fileId <= 0) {
    return { ok: false, statusCode: 400, message: `fileId 必须是正整数:${String(rawId)}` }
  }
  return { ok: true, ref: { fileId, relPath } }
}
