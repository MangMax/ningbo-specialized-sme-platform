import type { FileLanding } from '../../lib/core/file-categories'
// Application composition of the platform file store and the enabled server manifests.
import { eq } from 'drizzle-orm'
import { getAppModules } from '../../lib/app-modules'
import { storedFile } from '../../db/schema'
import { createFileStore, FileMaintenanceError, type FileStoreDb as Db, type FileRow, type FileQuery } from './file-store'
import { rosterFileServerCategory, type RosterFileFields, type FileMetadataPatch } from '../modules/sme-roster/files'
import type { PartsBackfillStats } from './file-parts'
import type { BackfillStats } from './file-store'

const serverCategories = new Map([['sme-roster', rosterFileServerCategory]])
const categories = getAppModules().flatMap(module => {
  const category = serverCategories.get(module.id)
  return module.fileCategories && category ? [category] : []
})
const store = createFileStore<RosterFileFields, FileMetadataPatch>(categories)

export const {
  checkAdmission, getStoredFile, extensionSnapshot, renameStoredFileDisplayName,
  verifyStoredFileRestoration, restoreVerifiedStoredFile, softRemoveStoredFile,
  backfillFromDisk, backfillStoredFiles,
} = store

export const resolveUploadPlacement: FileLanding = metadata => {
  const [category] = categories
  if (!category) throw { status_code: 400, body: '未登记上传落位规则\n' }
  return category.landing(metadata)
}

export type StoredFileRow = FileRow & RosterFileFields

export interface BackfillReport extends BackfillStats {
  parts: PartsBackfillStats
}

type FilterValues = Readonly<Record<string, readonly string[] | undefined>>

export function listStoredFiles(db: Db, params: FileQuery & { [key: string]: unknown } = {}) {
  const filters = Object.fromEntries(categories.flatMap(category => category.filters ?? []).map(filter => {
    const raw = params[filter.key]
    const values = (Array.isArray(raw) ? raw : [raw]).flatMap(value => typeof value === 'string' ? value.split(',') : [])
    return [filter.key, values.map(value => value.trim()).filter(value => filter.options.some(option => option.value === value))]
  })) satisfies FilterValues
  return store.listStoredFiles(db, params, filters)
}

export function parseMetadataPatch(input: unknown): FileMetadataPatch {
  const [category] = categories
  return category ? category.parseMetadataPatch(input) : {}
}

export function updateStoredFile(db: Db, id: number, patch: FileMetadataPatch): StoredFileRow | null {
  for (const category of categories) {
    if (!category.writeFileClassification(db, id, patch)) return null
  }
  return getStoredFile(db, id)
}

export interface RemoveResult {
  row: StoredFileRow
  /** 磁盘文件是否被真的删掉了。默认 false。 */
  diskDeleted: boolean
  /** 被引用数 > 0 时的提示(删了会让台账的出处指向不存在的文件)。 */
  referenceCount: number
}

/**
 * 把一个文件**移出库与索引**。默认**不删磁盘**:只打 `removed_at` 标(软删除)。
 * `deleteDisk: true` 时才真的 unlink —— 调用方(路由)必须先做二次确认。
 *
 * 被记录引用时允许软移出并回报引用数；磁盘删除在同一个写锁内拒绝仍被引用的文件。
 */
export async function removeStoredFile(
  db: Db,
  filesRoot: string,
  id: number,
  options: { deleteDisk?: boolean } = {},
): Promise<RemoveResult | null> {
  return removeStoredFileSync(db, filesRoot, id, options)
}

/** Short filesystem metadata operation under the SQLite write lock protects references. */
export function removeStoredFileSync(
  db: Db,
  filesRoot: string,
  id: number,
  options: { deleteDisk?: boolean } = {},
): RemoveResult | null {
  return db.transaction((tx) => {
    const current = tx.select().from(storedFile).where(eq(storedFile.id, id)).get()
    if (!current) return null

    const refs = getStoredFile(tx, id)?.referenceCount ?? 0

    const diskDeleted = false
    if (options.deleteDisk) throw new FileMaintenanceError(400, '物理删除必须通过带版本封套的隔离命令执行')

    softRemoveStoredFile(tx, id)

    return { row: getStoredFile(tx, id)!, diskDeleted, referenceCount: refs }
  }, { behavior: 'immediate' })
}
