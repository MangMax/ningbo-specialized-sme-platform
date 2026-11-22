import type { LogContext } from '../../lib/logging'
import { requirePostgresFileRef, type FileRefInput } from './file-agent-reference'
import { requireVersionedFileMaintenanceOptions, type FileMaintenanceAction, type FileMaintenanceOptions } from './file-maintenance-shared'
import { maintainPostgresFile } from './file-maintenance-postgres'
import { usePostgresFileDb } from './file-store-postgres'
export async function maintainFileForAgent(action: FileMaintenanceAction, input: FileRefInput & FileMaintenanceOptions & { patch?: unknown }, context: LogContext = {}) {
  try {
    const pg = usePostgresFileDb()
    const file = await requirePostgresFileRef(pg, input, { allowRemoved: true })
    const options = requireVersionedFileMaintenanceOptions(input)
    const root = useRuntimeConfig().filesDir
    const row = await maintainPostgresFile(pg, root, file.id, action, input.patch, options, context)
    return action === 'remove' ? { removed: row.removedAt !== null, diskDeleted: false, referenceCount: row.referenceCount, file: row } : { file: row }
  } catch (error) {
    throw createError({ statusCode: (error as { statusCode?: number }).statusCode ?? 500, message: (error as Error).message })
  }
}
