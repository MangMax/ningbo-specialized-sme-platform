// Install the registered roster parts maintenance for MCP file reads.
import { useDb } from '@db'
import { ensureFileStoreReady } from '../layers/sme-roster/server/utils/mcp-files'

export async function openFileStore(options: { readOnly?: boolean } = {}) {
  const db = useDb()
  const root = useRuntimeConfig().filesDir
  if (!options.readOnly) await ensureFileStoreReady(db, root)
  return { db, root }
}
