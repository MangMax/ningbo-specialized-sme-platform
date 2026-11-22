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

export { type SnapshotRow, type SnapshotFieldChange, type SnapshotChange, type SnapshotDiff, snapshotRowKey, diffPlatformSnapshots } from './platform-snapshot-diff'
