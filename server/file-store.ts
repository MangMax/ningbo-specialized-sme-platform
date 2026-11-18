// Application composition of the core store and the installed file categories.
import { createFileStore, type FileStoreDb } from '../layers/core/server/utils/file-store'
import { serverFileCategories } from './file-category-modules'

export const fileStore = createFileStore(serverFileCategories)

let fileRowsReady = false

/** Cold file registration uses the installed admission and classification policies. */
export function ensureFileRowsReady(db: FileStoreDb, root: string, force = false) {
  if (fileRowsReady && !force) return null
  return fileStore.backfillFromDisk(db, root).then(stats => {
    fileRowsReady = true
    return stats
  })
}

export function resetFileRowsReadyForTests() {
  fileRowsReady = false
}
