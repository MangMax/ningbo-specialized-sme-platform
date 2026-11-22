import { createHash } from 'node:crypto'
import type { FileMaintenanceOptions } from './file-maintenance-shared'
import type { FileRow } from './file-store-contract'
import type { StoredFileContentIdentity } from './file-identity'

export function filePhysicalRequestHash(id: number, action: string, intentId: string | undefined, options: FileMaintenanceOptions) {
  return createHash('sha256').update(JSON.stringify([id, action, intentId ?? null, options.expectedRevision, options.actor, options.basis])).digest('hex')
}

export function filePhysicalReceipt(row: Pick<FileRow, 'removedAt' | 'referenceCount'>, intent: StoredFileContentIdentity & { id: string; state: 'pending' | 'quarantined' | 'recovering' | 'recovered' }) {
  return { removed: row.removedAt !== null, diskDeleted: false, diskQuarantined: intent.state === 'quarantined', referenceCount: row.referenceCount, intent: { id: intent.id, fileId: intent.fileId, relPath: intent.relPath, sha256: intent.sha256, bytes: intent.bytes, state: intent.state } }
}
