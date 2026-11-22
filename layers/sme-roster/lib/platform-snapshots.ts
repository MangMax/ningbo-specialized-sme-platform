import { type SnapshotRow } from './platform-snapshot-diff'
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
export { type SnapshotRow, type SnapshotFieldChange, type SnapshotChange, type SnapshotDiff, snapshotRowKey, diffPlatformSnapshots } from './platform-snapshot-diff'
