import { verifyFileRead, verifyPageRead } from '../../layers/core/server/utils/file-read-identity'
import { appLog, type LogContext } from '../../layers/core/lib/logging'
import { eq, sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { z } from 'zod'
import type { BackfillExclusion } from '../../layers/core/server/utils/file-store'
import { useDb } from '@db'
import * as schema from '../../db/schema'
import { DEFAULT_DPI, isPdfPath, normalizeDpi } from '../../lib/pdf-page'
import {
  backfillFileParts,
  type PartsBackfillStats,
} from './file-parts'
import { maintainStoredFileSync, type FileMaintenanceOptions } from '../../layers/core/server/utils/file-maintenance'
import { listPdfPages, resolveWithinRoot, type PdfPagesState } from './pdf-pages'
import {
  backfillFromDisk,
  getStoredFile,
  parseMetadataPatch,
  type StoredFileRow,
} from './stored-files'

type Db = BetterSQLite3Database<typeof schema>

/**
 * MCP 面(票 18)读写用的**共用件**:怎么指一个文件、库要不要先回填。
 *
 * 放在 `server/utils/` 而不是 `server/mcp/` 下,有两个原因:
 *  1. `server/mcp/` 的子目录被模块当**定义目录**扫(`tools/` `resources/` `prompts/`),
 *     在它旁边塞共用件会被误认成定义;
 *  2. 这里的逻辑是**纯函数 + Db**,放 utils 里能像 `stored-files.ts` / `file-parts.ts`
 *     一样单测,而 tool 文件本身(声明 + 转发)不必起服务也能读。
 *
 * tool 文件保持「只做声明与转发」:每个能力一个文件(模块要求),但一行业务判断都不写在里面。
 */

// ---------------------------------------------------------------------------
// 指一个文件:id 还是 rel_path
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// 库要不要先回填
// ---------------------------------------------------------------------------

/**
 * 库是否「已就绪」的**进程内记忆**。
 *
 * ⚠️ 与 `server/api/files/index.get.ts` 里那个标记是**两份**,道理与 `pdf-pages.ts`
 * 照抄 `sha256Of` 一样:那张票的文件(票 09/17 的地盘)同时可能有别的会话在动,
 * 为抽一个 5 行的记忆去改它,会把两票的改动绞在一起。两处各自幂等,重复跑只是
 * 多一遍扫描。合流留给后续清理。
 */
let filesReady = false

/** 只有测试需要(每个用例一个临时库)。 */
export function __resetFileStoreReady(): void {
  filesReady = false
}

function countOf(db: Db, table: typeof schema.storedFilePart | typeof schema.recordEvidence): number {
  return db.select({ n: sql<number>`count(*)` }).from(table).get()?.n ?? 0
}

/**
 * MCP 冷启动时只要 evidence 存在就回填一次,即使库里已有代理段;后续若尚无派生段也补跑。
 * 回填只重建派生行,因此能安全地保留代理段并检测同坐标冲突。
 */
function needParts(db: Db, firstRun: boolean): boolean {
  if (countOf(db, schema.recordEvidence) === 0) return false
  if (firstRun) return true
  const derivedCount = db
    .select({ n: sql<number>`count(*)` })
    .from(schema.storedFilePart)
    .where(eq(schema.storedFilePart.origin, 'derived'))
    .get()?.n ?? 0
  return derivedCount === 0
}

const NO_FILE_STATS = {
  inserted: 0,
  updated: 0,
  unchanged: 0,
  skipped: [] as string[],
  excluded: [] as BackfillExclusion[],
}
interface BackfillReport extends Awaited<ReturnType<typeof backfillFromDisk>> {
  parts: PartsBackfillStats
}

const NO_PART_STATS: PartsBackfillStats = { files: 0, parts: 0, orphanPaths: [] }

/**
 * 保证 MCP 的读 tool 能读到东西:先扫 `files/` 回填 `stored_file`(票 09),再按需回填段(票 17)。
 *
 * 与 `/api/files` 的懒回填**同一顺序、同一幂等性**,只是触发点不同 —— MCP 客户端不走那个
 * 路由,所以它自己入口也要有一次。返回**本次是否真的跑了**(没跑返回 `null`),便于验收时
 * 核对「第一次调用会回填出 22 个文件」(RL-16 后的应有集合,见 `lib/file-store-scope.ts`)。
 *
 * `force` 只强制文件行回填；段回填仍守 `needParts`。
 * 的判据,不因为 `force` 就去覆盖已有段。
 */
export async function ensureFileStoreReady(
  db: Db,
  root: string,
  force = false,
): Promise<BackfillReport | null> {
  const runFiles = !filesReady || force
  const runParts = needParts(db, !filesReady)
  if (!runFiles && !runParts) return null

  const fileStats = runFiles ? await backfillFromDisk(db, root) : NO_FILE_STATS
  filesReady = true
  return {
    ...fileStats,
    parts: runParts ? backfillFileParts(db, { preserveExisting: true }) : NO_PART_STATS,
  }
}

// ---------------------------------------------------------------------------
// 两个「tool 级」操作(get_file 那一类的取值、set_file_category 的回写)
// ---------------------------------------------------------------------------

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
  contentIdentity?: import('../../layers/core/server/utils/file-read-identity').FileReadIdentity
}

// ---------------------------------------------------------------------------
// 读 tool 的统一入口
// ---------------------------------------------------------------------------

/** 默认保证文件库已回填；只读列表跳过维护。 */
export async function openFileStore(options: { readOnly?: boolean } = {}): Promise<{
  db: Db
  root: string
}> {
  const db = useDb()
  const root = useRuntimeConfig().filesDir
  if (!options.readOnly) await ensureFileStoreReady(db, root)
  return { db, root }
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

/**
 * `set_file_category` 的写入逻辑(票 12 的代理通路)。
 *
 * 复用页面那条 PATCH 的**同一个写入口**:`parseMetadataPatch`(白名单 + 三态
 * 「未提供 / 置空 / 置值」+ 拒掉 `relPath` 之类磁盘事实键)+ `updateStoredFile`
 * (分类补齐后自动把 `categoryState` 从 `unset` 升为 `set`)。所以从 MCP 写进去与
 * 从页面写进去是**同一件事**,没有第二条写库通路。
 */
export function setFileCategoryForAgent(
  db: Db,
  ref: FileRefInput,
  meta: Record<string, unknown>,
  options: FileRefOptions = { allowRemoved: false },
  maintenanceOptions: FileMaintenanceOptions = {},
  context: LogContext = {},
): { ok: true; row: StoredFileRow } | AgentFailure {
  const found = resolveFileRef(db, ref, options)
  if (!found.ok) return { ok: false, statusCode: 404, message: found.message }

  if (!Object.keys(meta).length) {
    return {
      ok: false,
      statusCode: 400,
      message: '至少给一个分类字段:source / kind / year / batch / titleCode',
    }
  }

  let patch: ReturnType<typeof parseMetadataPatch>
  try {
    patch = parseMetadataPatch(meta)
  } catch (error) {
    return { ok: false, statusCode: 400, message: (error as Error).message }
  }

  try {
    const row = maintainStoredFileSync(db, found.row.id, 'update', patch, maintenanceOptions)
    appLog({ module: 'core', source: 'file', operation: 'file.maintenance.update', outcome: 'success', fileId: row.id }, context)
    return { ok: true, row }
  } catch (error) {
    appLog({ module: 'core', source: 'file', operation: 'file.maintenance.update', outcome: ((error as { statusCode?: number }).statusCode ?? 500) < 500 ? 'denied' : 'failure', fileId: found.row.id, level: 'error', errorCode: 'file_maintenance_failed' }, context)
    return { ok: false, statusCode: (error as { statusCode?: number }).statusCode ?? 500, message: (error as Error).message }
  }
}
