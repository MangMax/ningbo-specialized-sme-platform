import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { z } from 'zod'
import * as schema from '../../../../db/schema'
import { getStoredFile, type StoredFileRow } from '../../../../server/utils/stored-files'
import { DEFAULT_DPI, isPdfPath, normalizeDpi } from '../../lib/pdf-page'
import { verifyFileRead, verifyPageRead, type FileReadIdentity } from './file-read-identity'
import { listPdfPages, resolveWithinRoot, type PdfPagesState } from './pdf-pages'

type Db = BetterSQLite3Database<typeof schema>

/**
 * 指向文件库某个文件的两种写法,**恰给其一**。
 *
 * 为什么两种都要:`list_files` 给的是 `id`(agent 拿它最顺手);而 `record_evidence.source_file`
 * 那一侧的口径是 `rel_path`(`jxj/announcement/2024/2/…pdf`),代理从别处拿到路径时
 * 不必先反查一遍 id。两种混着给是**歧义**,不是「都要满足」,所以报错而不是取交集。
 */
export const fileRefShape = {
  fileId: z.number().int().positive().optional().describe('文件 id(从 list_files / get_file 拿)'),
  relPath: z.string().min(1).optional().describe('文件库内相对路径(与 record_evidence.source_file 同口径)'),
}

export interface FileRefInput {
  fileId?: number | null
  relPath?: string | null
}

/** 解析结果:成功给整行(含引用数与段),失败给**给人看的中文原因**(tool 转成 MCP 错误)。 */
export type FileRefResult =
  | { ok: true; row: StoredFileRow }
  | { ok: false; message: string }

export interface FileRefOptions {
  /**
   * 是否接受**已移出库**的文件(`removed_at` 非空)。
   *
   * 读 tool 传 `true` —— 「这文件还在不在库里」本身就是要查的信息;
   * 写 tool 传 `false`(默认)—— 往一个已移出的文件上回写会让它带着新元数据
   * 继续缺席在列表外,是个说不清的状态。
   */
  allowRemoved?: boolean
}

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

/**
 * 把 `{ fileId?, relPath? }` 解析成库里的整行。
 *
 * 返回结果对象而不是抛错:这一层的职责是「翻译用户输入」,抛什么 HTTP/MCP 错误
 * 是调用方(tool)的事 —— 顺带也让它不必起服务就能单测。
 */
export function resolveFileRef(
  db: Db,
  ref: FileRefInput,
  options: FileRefOptions = {},
): FileRefResult {
  const id = ref.fileId ?? null
  const relPath = typeof ref.relPath === 'string' ? ref.relPath.trim() : ''

  if (id !== null && relPath) {
    return { ok: false, message: '`fileId` 与 `relPath` 只能给一个,不要混用' }
  }
  if (id === null && !relPath) {
    return { ok: false, message: '必须给 `fileId` 或 `relPath` 之一' }
  }

  let row: StoredFileRow | null
  if (id !== null) {
    if (!Number.isInteger(id) || id <= 0) {
      return { ok: false, message: `文件 id 必须是正整数:${id}` }
    }
    row = getStoredFile(db, id)
    if (!row) return { ok: false, message: `文件不存在:id=${id}` }
  } else {
    const found = findFileIdByRelPath(db, relPath)
    if (found === null) return { ok: false, message: `文件不存在:relPath=${relPath}` }
    row = getStoredFile(db, found)
    if (!row) return { ok: false, message: `文件不存在:relPath=${relPath}` }
  }

  if (row.removedAt && !options.allowRemoved) {
    return {
      ok: false,
      message: `文件已移出库(removed_at=${row.removedAt}),不再接受写入:id=${row.id}`,
    }
  }
  return { ok: true, row }
}

/**
 * 操作失败时的**给人看的原因 + HTTP 状态码**。
 *
 * 为什么带状态码:`defineMcpTool` 会把 handler 抛出的 H3 错误(`createError({statusCode})`)
 * 翻成 MCP 的 `isError` 结果,状态码留在文案里。所以这一层给出「几分之几」,
 * tool 只管把它转成 `createError`,不自己再判一遍。
 */
export interface AgentFailure {
  ok: false
  statusCode: number
  message: string
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

  const { id, relPath, filename } = found.row
  if (!isPdfPath(relPath)) {
    return { ok: false, statusCode: 415, message: `不是 PDF,没有页图:${relPath}` }
  }
  let dpi: number
  try {
    dpi = normalizeDpi(input.dpi)
  } catch (error) {
    return { ok: false, statusCode: 400, message: (error as Error).message }
  }
  try {
    resolveWithinRoot(root, relPath)
  } catch {
    return { ok: false, statusCode: 403, message: '路径越界' }
  }

  const contentIdentity = await verifyFileRead(db, root, relPath)
  const state = await listPdfPages(root, relPath, dpi)
  if (state.pages.length) await verifyPageRead(db, root, relPath, undefined, contentIdentity)
  // `state.file` 本来是个字符串(相对路径);这里换成带 id 的对象,代理解析结果时
  // 不必再去 `list_files` 反查一次。
  return { ok: true, value: { ...state, file: { id, relPath, filename, contentIdentity } } }
}

/** 文件引用(tool 返回值里的那个小对象)。 */
export interface FileRef {
  id: number
  relPath: string
  filename: string
  contentIdentity?: FileReadIdentity
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
): StoredFileRow {
  const found = resolveFileRef(db, ref, options)
  if (!found.ok) throw createError({ statusCode: 404, message: found.message })
  return found.row
}
