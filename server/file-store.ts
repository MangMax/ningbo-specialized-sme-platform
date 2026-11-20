import { createFileStore, type FileCategoryServer, type FileStoreDb } from '../layers/core/server/utils/file-store'

export let {
  checkAdmission, getStoredFile, listStoredFiles, extensionSnapshot, renameStoredFileDisplayName,
  verifyStoredFileRestoration, restoreVerifiedStoredFile, softRemoveStoredFile,
  backfillFromDisk, backfillStoredFiles, resolveUploadPlacement, resolveFileRegistration, registerUploadedFile, parseMetadataPatch, updateStoredFile,
} = createFileStore<readonly FileCategoryServer[]>([])

export let serverFileCategories: readonly FileCategoryServer[] = []
let fileRowsReady = false

export function configureFileStore(categories: readonly FileCategoryServer[]): void {
  ({
    checkAdmission, getStoredFile, listStoredFiles, extensionSnapshot, renameStoredFileDisplayName,
    verifyStoredFileRestoration, restoreVerifiedStoredFile, softRemoveStoredFile,
    backfillFromDisk, backfillStoredFiles, resolveUploadPlacement, resolveFileRegistration, registerUploadedFile, parseMetadataPatch, updateStoredFile,
  } = createFileStore(categories))
  serverFileCategories = categories
  fileRowsReady = false
}

/** Cold file registration uses the installed admission and classification policies. */
export function ensureFileRowsReady(db: FileStoreDb, root: string, force = false) {
  if (fileRowsReady && !force) return null
  return backfillFromDisk(db, root).then(stats => {
    fileRowsReady = true
    return stats
  })
}

export function resetFileRowsReadyForTests() {
  fileRowsReady = false
}
