import { eq } from 'drizzle-orm'
import { storedFile } from '../../../../db/schema'
import { getStoredFile, softRemoveStoredFile } from '../../../../server/file-store'
import { FileMaintenanceError, type FileStoreDb as Db } from './file-store'

export {
  checkAdmission, getStoredFile, listStoredFiles, extensionSnapshot, renameStoredFileDisplayName,
  verifyStoredFileRestoration, restoreVerifiedStoredFile, softRemoveStoredFile,
  backfillFromDisk, backfillStoredFiles, resolveUploadPlacement, registerUploadedFile, parseMetadataPatch, updateStoredFile,
} from '../../../../server/file-store'

export type StoredFileRow = NonNullable<ReturnType<typeof getStoredFile>>

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
