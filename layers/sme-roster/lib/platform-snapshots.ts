/**
 * RL-05 —— 平台导出**快照的读侧**(契约 §7.7)与**版本比较**。
 *
 * 两件事:
 *   1. `listPlatformSnapshots` —— 某称号某年度的采集快照与版本(读 `platform_export_batch`);
 *   2. `diffPlatformSnapshots` —— 两个快照间**新增 / 消失 / 字段变化**,并**追溯到原始行**
 *      (`source_row_no`);纯函数,不碰库。
 *
 * 边界(契约 §0/§5):这里只读**采集时点现状**,不与 `record*` join 出历史事实。
 */
import { and, asc, eq, inArray, type SQL } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../../../db/schema'

type Db = BetterSQLite3Database<typeof schema>

/** 一条导出批次(映射契约 §1.6)。 */
export interface PlatformSnapshotBatch {
  id: number
  titleCode: string
  year: number
  collectedOn: string
  originalFilename: string
  sha256: string
  rowCount: number
  importStatus: string
  sourceDocumentId: number | null
  importBatchId: number | null
  /** 本批**替换**了哪一批(自引用);首版为 null。 */
  replacedBatchId: number | null
  createdAt: string
}

/** 契约 §7.7 的**响应行**形状。 */
export interface PlatformSnapshotListItem {
  batch: PlatformSnapshotBatch
  replacedBatchId: number | null
  rowCount: number
  importStatus: string
}

export interface PlatformSnapshotQuery {
  /** 称号代号(可多值)。 */
  title?: string[]
  /** 快照年度(可多值)。 */
  year?: number[]
}

/**
 * 列出导出快照批次。排序:`title_code` → `year` → `id`(同年同称号下,
 * 后导入的版本在后,便于人按时间读)。
 */
export function listPlatformSnapshots(
  db: Db,
  query: PlatformSnapshotQuery = {},
): PlatformSnapshotListItem[] {
  const conds: SQL[] = []
  if (query.title?.length) conds.push(inArray(schema.platformExportBatch.titleCode, query.title))
  if (query.year?.length) conds.push(inArray(schema.platformExportBatch.year, query.year))

  const rows = db
    .select()
    .from(schema.platformExportBatch)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(asc(schema.platformExportBatch.titleCode), asc(schema.platformExportBatch.year), asc(schema.platformExportBatch.id))
    .all()

  return rows.map((row) => ({
    batch: toBatch(row),
    replacedBatchId: row.replacedBatchId,
    rowCount: row.rowCount,
    importStatus: row.importStatus,
  }))
}

/** 取一条批次;不存在返回 null。 */
export function getPlatformSnapshotBatch(db: Db, batchId: number): PlatformSnapshotBatch | null {
  const row = db
    .select()
    .from(schema.platformExportBatch)
    .where(eq(schema.platformExportBatch.id, batchId))
    .get()
  return row ? toBatch(row) : null
}

/** 取一批的全部快照行,按源行号升序(供比较与追溯)。 */
export function getPlatformExportRows(db: Db, batchId: number): SnapshotRow[] {
  return db
    .select()
    .from(schema.platformExportRow)
    .where(eq(schema.platformExportRow.batchId, batchId))
    .orderBy(asc(schema.platformExportRow.sourceRowNo))
    .all()
    .map((row) => ({
      sourceRowNo: row.sourceRowNo,
      usccRaw: row.usccRaw,
      nameRaw: row.nameRaw,
      province: row.province,
      city: row.city,
      district: row.district,
      regStatus: row.regStatus,
    }))
}

function toBatch(row: typeof schema.platformExportBatch.$inferSelect): PlatformSnapshotBatch {
  return {
    id: row.id,
    titleCode: row.titleCode,
    year: row.year,
    collectedOn: row.collectedOn,
    originalFilename: row.originalFilename,
    sha256: row.sha256,
    rowCount: row.rowCount,
    importStatus: row.importStatus,
    sourceDocumentId: row.sourceDocumentId,
    importBatchId: row.importBatchId,
    replacedBatchId: row.replacedBatchId,
    createdAt: row.createdAt,
  }
}

// ---------------------------------------------------------------------------
// 版本比较(纯函数)
// ---------------------------------------------------------------------------

/** 参与比较的一行(只要这几列;`platform_export_row` 的子集)。 */
export interface SnapshotRow {
  sourceRowNo: number
  usccRaw: string | null
  nameRaw: string | null
  province: string | null
  city: string | null
  district: string | null
  regStatus: string | null
}

/** 字段级变化。 */
export interface SnapshotFieldChange {
  field: 'name' | 'province' | 'city' | 'district' | 'regStatus'
  from: string | null
  to: string | null
}

/** 一条「两边都有、但有字段变了」的行。 */
export interface SnapshotChange {
  /** 行身份键(统代优先,缺失退化为名称)。 */
  key: string
  usccRaw: string | null
  nameRaw: string | null
  /** 旧快照里的源行号。 */
  fromSourceRowNo: number
  /** 新快照里的源行号。 */
  toSourceRowNo: number
  fields: SnapshotFieldChange[]
}

export interface SnapshotDiff {
  /** 新快照有、旧快照没有的行。 */
  added: SnapshotRow[]
  /** 旧快照有、新快照没有的行。 */
  removed: SnapshotRow[]
  /** 两边都有、字段有变化的行。 */
  changed: SnapshotChange[]
  unchanged: number
  fromCount: number
  toCount: number
}

const COMPARED_FIELDS: Array<{ field: SnapshotFieldChange['field']; read: (row: SnapshotRow) => string | null }> = [
  { field: 'name', read: (r) => r.nameRaw },
  { field: 'province', read: (r) => r.province },
  { field: 'city', read: (r) => r.city },
  { field: 'district', read: (r) => r.district },
  { field: 'regStatus', read: (r) => r.regStatus },
]

/**
 * 行身份键:统一社会信用代码(trim + 大写);统代缺失时退化为 `name:<名称>`。
 * 三张导出表实测统代 **0 缺失、0 重复**,所以键在批内唯一;退化分支只是防御。
 */
export function snapshotRowKey(row: SnapshotRow): string {
  const uscc = row.usccRaw?.trim().toUpperCase()
  if (uscc) return uscc
  return `name:${row.nameRaw?.trim() ?? ''}`
}

/**
 * 比较两个快照。
 *
 * 语义以**统代**为准:「新快照有、旧快照没有」= 新增,反之 = 消失,
 * 两边都在但比较字段有差 = 变化。每条结果都带**源行号**,可回溯到原始文件的行。
 */
export function diffPlatformSnapshots(
  from: readonly SnapshotRow[],
  to: readonly SnapshotRow[],
): SnapshotDiff {
  const fromIndex = new Map<string, SnapshotRow>()
  for (const row of from) fromIndex.set(snapshotRowKey(row), row)
  const toIndex = new Map<string, SnapshotRow>()
  for (const row of to) toIndex.set(snapshotRowKey(row), row)

  const added = to.filter((row) => !fromIndex.has(snapshotRowKey(row)))
  const removed = from.filter((row) => !toIndex.has(snapshotRowKey(row)))

  const changed: SnapshotChange[] = []
  let unchanged = 0
  for (const [key, before] of fromIndex) {
    const after = toIndex.get(key)
    if (!after) continue
    const fields: SnapshotFieldChange[] = []
    for (const { field, read } of COMPARED_FIELDS) {
      const beforeValue = read(before)
      const afterValue = read(after)
      if (beforeValue !== afterValue) fields.push({ field, from: beforeValue, to: afterValue })
    }
    if (fields.length === 0) unchanged += 1
    else {
      changed.push({
        key,
        usccRaw: after.usccRaw ?? before.usccRaw,
        nameRaw: after.nameRaw ?? before.nameRaw,
        fromSourceRowNo: before.sourceRowNo,
        toSourceRowNo: after.sourceRowNo,
        fields,
      })
    }
  }

  const byRowNo = (a: { sourceRowNo: number }, b: { sourceRowNo: number }) => a.sourceRowNo - b.sourceRowNo
  return {
    added: [...added].sort(byRowNo),
    removed: [...removed].sort(byRowNo),
    changed: changed.sort((a, b) => a.toSourceRowNo - b.toSourceRowNo),
    unchanged,
    fromCount: from.length,
    toCount: to.length,
  }
}
