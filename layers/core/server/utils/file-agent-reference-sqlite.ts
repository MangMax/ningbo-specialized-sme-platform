import { createError } from 'h3'
import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../../../../db/schema'
import { getStoredFile } from './stored-files'
import { verifyFileRead } from './file-read-identity'
import type { PdfPagesState } from './pdf-pages'
import { fileLocator, missingFileRef, readPageImagesForAgent, visibleFileRef, type AgentFailure, type FileRef, type FileRefInput, type FileRefOptions, type FileRefResult } from './file-agent-reference'

type Db = BetterSQLite3Database<typeof schema>

/** 按相对路径找 id(`stored_file.rel_path` 上有 unique 索引)。 */
export function findFileIdByRelPath(db: Db, relPath: string): number | null {
  return (
    db
      .select({ id: schema.storedFile.id })
      .from(schema.storedFile)
      .where(eq(schema.storedFile.relPath, relPath))
      .get()?.id ?? null
  )
}

export function resolveFileRef(db: Db, ref: FileRefInput, options: FileRefOptions = {}): FileRefResult {
  const result = fileLocator(ref)
  if (!result.ok) return result
  const { locator } = result
  const id = typeof locator === 'number' ? locator : findFileIdByRelPath(db, locator)
  const row = id === null ? null : getStoredFile(db, id)
  return row ? visibleFileRef(row, options) : { ok: false, message: missingFileRef(locator) }
}

/**
 * `list_page_images` 的取值逻辑(页图现状)。**不触发渲染** —— 渲染要写盘,
 * 而 MCP 侧刻意不给它开写入口(见 `server/mcp/tools/list_page_images.ts`)。
 *
 * 状态码的取值与 `GET /api/pdf-pages` **同一套**(415 非 PDF / 400 分辨率 / 403 路径越界),
 * 但**判定顺序不同**:那条路由先判扩展名再看别的(它拿到的就是路径,没有 id 可查);
 * 这里要先按 id/relPath 找到文件行才能知道它是什么,**所以「文件不存在」这条 404 排在最前**。
 * 于是「一个不存在的 `.xlsx` 路径」两边给的码不同(这里 404、那里 415)—— 都不是错的,
 * 只是「先答哪一个问题」不同。真要两边逐字一致,得让那条路由也先查一次 `stored_file`,
 * 那是它那张票(13)的事,不在本票改动范围。
 */
export async function pageImagesForAgent(
  db: Db,
  root: string,
  input: FileRefInput & { dpi?: number | null },
  options: FileRefOptions = { allowRemoved: true },
): Promise<{ ok: true; value: Omit<PdfPagesState, 'file'> & { file: FileRef } } | AgentFailure> {
  const found = resolveFileRef(db, input, options)
  if (!found.ok) return { ok: false, statusCode: 404, message: found.message }
  return readPageImagesForAgent(found.row, root, input.dpi, () => verifyFileRead(db, root, found.row.relPath))
}

/**
 * 同 `resolveFileRef`,但**失败即抛 H3 错误** —— 给「拿不到文件就没法继续」的 tool 用。
 *
 * 抛出的 `statusCode` 会由 `defineMcpTool` 留在 MCP 的 `isError` 文案里,所以 404
 * 是「文件不存在 / 已移出库」这一类原因的统一出口。
 */
export function requireFileRef(
  db: Db,
  ref: FileRefInput,
  options: FileRefOptions = {},
): Extract<FileRefResult, { ok: true }>['row'] {
  const found = resolveFileRef(db, ref, options)
  if (!found.ok) throw createError({ statusCode: 404, message: found.message })
  return found.row
}
