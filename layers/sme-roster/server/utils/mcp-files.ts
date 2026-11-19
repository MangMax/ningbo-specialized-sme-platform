import { resolveFileRef, type AgentFailure, type FileRefInput, type FileRefOptions } from '../../../core/server/utils/file-agent-reference'
import { appLog, type LogContext } from '../../../core/lib/logging'
import { eq, sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { ensureFileRowsReady, resetFileRowsReadyForTests } from '../../../../server/file-store'
import type { BackfillExclusion } from '../../../core/server/utils/file-store'
import * as schema from '../../../../db/schema'
import {
  backfillFileParts,
  type PartsBackfillStats,
} from './file-parts'
import { maintainStoredFileSync, type FileMaintenanceOptions } from '../../../core/server/utils/file-maintenance'
import {
  backfillFromDisk,
  parseMetadataPatch,
  type StoredFileRow,
} from '../../../core/server/utils/stored-files'

type Db = BetterSQLite3Database<typeof schema>

// ---------------------------------------------------------------------------
// 库要不要先回填
// ---------------------------------------------------------------------------

// The roster maintenance entry point tracks its own first derived-parts pass.
let partsChecked = false

/** 只有测试需要(每个用例一个临时库)。 */
export function __resetFileStoreReady(): void {
  partsChecked = false
  resetFileRowsReadyForTests()
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
  const runParts = needParts(db, !partsChecked)
  const backfill = ensureFileRowsReady(db, root, force)
  const fileStats = backfill && await backfill
  partsChecked = true
  if (!fileStats && !runParts) return null
  return {
    ...(fileStats ?? NO_FILE_STATS),
    parts: runParts ? backfillFileParts(db, { preserveExisting: true }) : NO_PART_STATS,
  }
}

// ---------------------------------------------------------------------------
// 两个「tool 级」操作(get_file 那一类的取值、set_file_category 的回写)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 读 tool 的统一入口
// ---------------------------------------------------------------------------

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
