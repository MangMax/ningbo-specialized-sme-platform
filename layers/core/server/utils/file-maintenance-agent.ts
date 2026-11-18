import type { LogContext } from '../../lib/logging'
import { useDb } from '@db'
import { requireFileRef, type FileRefInput } from '../../../../server/utils/mcp-files'
import { maintainStoredFile, requireVersionedFileMaintenanceOptions, type FileMaintenanceAction, type FileMaintenanceOptions } from './file-maintenance'
export async function maintainFileForAgent(action: FileMaintenanceAction, input: FileRefInput & FileMaintenanceOptions & { patch?: unknown }, context: LogContext = {}) {
  const db = useDb()
  const file = requireFileRef(db, input, { allowRemoved: true })
  const { expectedRevision, idempotencyKey, actor, basis } = requireVersionedFileMaintenanceOptions(input)
  try {
    const row = await maintainStoredFile(db, useRuntimeConfig().filesDir, file.id, action, input.patch, { expectedRevision, idempotencyKey, actor, basis }, context)
    return action === 'remove' ? { removed: row.removedAt !== null, diskDeleted: false, referenceCount: row.referenceCount, file: row } : { file: row }
  } catch (error) {
    throw createError({ statusCode: (error as { statusCode?: number }).statusCode ?? 500, message: (error as Error).message })
  }
}
