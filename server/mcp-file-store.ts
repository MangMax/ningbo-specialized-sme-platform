import { useDb } from '@db'
import { ensureFileRowsReady } from './file-store'
import type { FileStoreDb } from '../layers/core/server/utils/file-store'

type PrepareFileStore = (db: FileStoreDb, root: string) => Promise<unknown> | null
let prepareFileStore: PrepareFileStore = ensureFileRowsReady

export function installMcpFilePreparation(prepare: PrepareFileStore): void {
  prepareFileStore = prepare
}

export async function openFileStore(options: { readOnly?: boolean } = {}) {
  const db = useDb()
  const root = useRuntimeConfig().filesDir
  if (!options.readOnly) await prepareFileStore(db, root)
  return { db, root }
}
