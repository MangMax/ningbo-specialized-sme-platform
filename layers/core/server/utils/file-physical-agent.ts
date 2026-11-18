import { useDb } from '@db'
import { createError } from 'h3'
import { requireFileRef, type FileRefInput } from './file-agent-reference'
import { type FileMaintenanceOptions } from './file-maintenance'
import { quarantineStoredFile, readPhysicalIntent, recoverStoredFile } from './file-physical'
export function physicalFileForAgent(action: 'quarantine' | 'recover' | 'read', input: FileRefInput & FileMaintenanceOptions & { intentId?: string }) {
  try {
    const db = useDb(), file = requireFileRef(db, input, { allowRemoved: true })
    if (action === 'read') return readPhysicalIntent(db, file.id, input.intentId)
    const { expectedRevision, idempotencyKey, actor, basis } = input
    const options = { expectedRevision, idempotencyKey, actor, basis }
    return action === 'quarantine' ? quarantineStoredFile(db, useRuntimeConfig().filesDir, file.id, options) : recoverStoredFile(db, useRuntimeConfig().filesDir, file.id, input.intentId!, options)
  } catch (error) { throw createError({ statusCode: (error as { statusCode?: number }).statusCode ?? 500, message: (error as Error).message }) }
}
