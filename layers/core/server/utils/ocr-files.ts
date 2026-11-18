import { useDb } from '@db'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../../../../db/schema'
import { resolveFileRef, type FileRefInput } from './file-agent-reference'
import { ensureFileStoreReady } from '../../../../server/utils/mcp-files'
import type { StoredFileRow } from '../../../../server/utils/stored-files'

type Db = BetterSQLite3Database<typeof schema>

/**
 * OCR 结果的三条 HTTP 路由共用的**开场白**:把 `{fileId?|relPath?}` 翻成库里的那一行。
 *
 * ── 为什么需要它 ────────────────────────────────────────────────────────
 * 三条路由(`GET /api/ocr-results`、`POST /api/ocr-results`、`GET …/markdown`)都要
 * 「先回填、再按 id/relPath 找到文件」这两步。写在三处的话,冷启动那一趟(`ensureFileStoreReady`)
 * 迟早有一处忘掉 —— 那一处的表现是「刚起的服务查不到任何文件」,而另外两处正常,
 * 极难查。收在这里,顺序就只有一种。
 *
 * 顺序是**有讲究**的:`ensureFileStoreReady` 必须**先**跑,`resolveFileRef` 才有东西可查
 * (冷启动时库里一行都没有,先查就是一片 404)。与 MCP 的 `openFileStore` 同一条理由。
 *
 * 指向文件的两种写法取其一(`fileId` / `relPath`)直接复用 MCP 那一层的判据
 * (`resolveFileRef` 的「只能给一个」),不在这里再判一遍 —— 两处各判一份,文案必然漂。
 */
export type OcrFileTargetResult =
  | { ok: true; db: Db; root: string; row: StoredFileRow }
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
  const db = useDb()
  const root = useRuntimeConfig().filesDir
  await ensureFileStoreReady(db, root)

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
