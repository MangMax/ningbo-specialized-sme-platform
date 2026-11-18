import { useDb } from '@db'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../../../../db/schema'
import { resolveFileRef, type FileRefInput, type FileRefResult } from './file-agent-reference'
import { ensureFileRowsReady } from '../../../../server/file-store'

type Db = BetterSQLite3Database<typeof schema>

/** Cold OCR access registers admitted file rows before resolving an ID or path. */
export async function openOcrFileStore(root = useRuntimeConfig().filesDir) {
  const db = useDb()
  await ensureFileRowsReady(db, root)
  return { db, root }
}

export type OcrFileTargetResult =
  | { ok: true; db: Db; root: string; row: Extract<FileRefResult, { ok: true }>['row'] }
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
): Promise<OcrFileTargetResult> {
  const hasId = input.fileId !== undefined && input.fileId !== null
  const hasPath = typeof input.relPath === 'string' && input.relPath.trim() !== ''
  if (hasId === hasPath || (hasId && (!Number.isSafeInteger(input.fileId) || input.fileId! <= 0))) {
    return { ok: false, statusCode: 400, message: '文件引用非法:fileId 与路径恰给其一,ID 必须是正整数' }
  }
  const { db, root } = await openOcrFileStore()

  const found = resolveFileRef(db, input, { allowRemoved: options.allowRemoved ?? false })
  if (!found.ok) {
    // 404 是「文件不存在 / 已移出库」的统一出口(与 MCP 的 `requireFileRef` 同一码)。
    return { ok: false, statusCode: 404, message: found.message }
  }
  return { ok: true, db, root, row: found.row }
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
