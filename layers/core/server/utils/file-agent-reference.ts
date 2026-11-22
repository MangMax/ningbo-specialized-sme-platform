import { z } from 'zod'
import { createError } from 'h3'
import type { FileRow } from './file-store-contract'
import { isPdfPath, normalizeDpi } from '../../lib/pdf-page'
import { verifyRegisteredFileRead, verifyRenderedPageRead, type FileReadIdentity } from './file-read'
import { listPdfPages, resolveWithinRoot, type PdfPagesState } from './pdf-pages'
import { FileMaintenanceError } from './file-store-contract'
import { postgresFileIdentity, readPostgresFile, type PostgresFileDb } from './file-store-postgres'

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
  | { ok: true; row: FileRow }
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

export function fileLocator(ref: FileRefInput): { ok: true; locator: number | string } | { ok: false; message: string } {
  const id = ref.fileId ?? null
  const relPath = typeof ref.relPath === 'string' ? ref.relPath.trim() : ''

  if (id !== null && relPath) {
    return { ok: false, message: '`fileId` 与 `relPath` 只能给一个,不要混用' }
  }
  if (id === null && !relPath) {
    return { ok: false, message: '必须给 `fileId` 或 `relPath` 之一' }
  }

  if (id !== null && (!Number.isInteger(id) || id <= 0)) {
    return { ok: false, message: `文件 id 必须是正整数:${id}` }
  }
  return { ok: true, locator: id ?? relPath }
}

export function missingFileRef(locator: number | string) {
  return `文件不存在:${typeof locator === 'number' ? 'id' : 'relPath'}=${locator}`
}

export function visibleFileRef<Row extends FileRow>(row: Row, options: FileRefOptions): { ok: true; row: Row } | { ok: false; message: string } {
  if (row.removedAt && !options.allowRemoved) {
    return {
      ok: false,
      message: `文件已移出库(removed_at=${row.removedAt}),不再接受写入:id=${row.id}`,
    }
  }
  return { ok: true, row }
}

export async function requirePostgresFileRef(db: PostgresFileDb, ref: FileRefInput, options: FileRefOptions = {}) {
  const result = fileLocator(ref)
  if (!result.ok) throw createError({ statusCode: 404, message: result.message })
  const { locator } = result
  if (typeof locator === 'string' && locator.includes('\0')) throw createError({ statusCode: 404, message: missingFileRef(locator) })
  const row = await readPostgresFile(db, locator).catch(error => {
    if (!(error instanceof FileMaintenanceError) || error.statusCode !== 404) throw error
    throw createError({ statusCode: 404, message: missingFileRef(locator) })
  })
  const visible = visibleFileRef(row, options)
  if (!visible.ok) throw createError({ statusCode: 404, message: visible.message })
  return visible.row
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

export async function postgresPageImagesForAgent(db: PostgresFileDb, root: string, input: FileRefInput & { dpi?: number | null }) {
  const file = await requirePostgresFileRef(db, input, { allowRemoved: true })
  return readPageImagesForAgent(file, root, input.dpi, () => verifyRegisteredFileRead(root, postgresFileIdentity(file)))
}

export async function readPageImagesForAgent(
  { id, relPath, filename }: Pick<FileRow, 'id' | 'relPath' | 'filename'>,
  root: string,
  requestedDpi: number | null | undefined,
  verify: () => Promise<FileReadIdentity>,
): Promise<{ ok: true; value: Omit<PdfPagesState, 'file'> & { file: FileRef } } | AgentFailure> {
  if (!isPdfPath(relPath)) {
    return { ok: false, statusCode: 415, message: `不是 PDF,没有页图:${relPath}` }
  }
  let dpi: number
  try {
    dpi = normalizeDpi(requestedDpi)
  } catch (error) {
    return { ok: false, statusCode: 400, message: (error as Error).message }
  }
  try {
    resolveWithinRoot(root, relPath)
  } catch {
    return { ok: false, statusCode: 403, message: '路径越界' }
  }

  const contentIdentity = await verify()
  const state = await listPdfPages(root, relPath, dpi)
  if (state.pages.length) await verifyRenderedPageRead(root, relPath, contentIdentity)
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
