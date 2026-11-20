import { useDb } from '@db'
import { createError } from 'h3'
import { requireFileRef, requirePostgresFileRef, type FileRefInput } from './file-agent-reference'
import { type FileMaintenanceOptions } from './file-maintenance'
import { quarantineStoredFile, readPhysicalIntent, recoverStoredFile } from './file-physical'
import { quarantinePostgresFile, readPostgresPhysicalIntent, recoverPostgresFile } from './file-physical-postgres'
import { usePostgresFileDb } from './file-store-postgres'
export async function physicalFileForAgent(action: 'quarantine' | 'recover' | 'read', input: FileRefInput & FileMaintenanceOptions & { intentId?: string }) {
  try {
    const pg = usePostgresFileDb()
    const referenceOptions = { allowRemoved: true }
    const file = pg ? await requirePostgresFileRef(pg, input, referenceOptions) : requireFileRef(useDb(), input, referenceOptions)
    const { expectedRevision, idempotencyKey, actor, basis, intentId } = input
    if (action === 'read') return pg ? await readPostgresPhysicalIntent(pg, file.id, intentId) : readPhysicalIntent(useDb(), file.id, intentId)
    const options = { expectedRevision, idempotencyKey, actor, basis }
    const root = useRuntimeConfig().filesDir
    if (action === 'quarantine') {
      return pg ? await quarantinePostgresFile(pg, root, file.id, options) : quarantineStoredFile(useDb(), root, file.id, options)
    }
    return pg ? await recoverPostgresFile(pg, root, file.id, intentId!, options) : recoverStoredFile(useDb(), root, file.id, intentId!, options)
  } catch (error) { throw createError({ statusCode: (error as { statusCode?: number }).statusCode ?? 500, message: (error as Error).message }) }
}
