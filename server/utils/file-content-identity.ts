import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../../db/schema'

export interface FileContentIdentity {
  sha256: string
  bytes: number
}

export interface StoredFileContentIdentity extends FileContentIdentity {
  fileId: number
  relPath: string
}

export interface FileContentConflict {
  code: 'file_content_conflict'
  fileId: number
  relPath: string
  registered: FileContentIdentity
  observed: FileContentIdentity
}

/** Registered identity only; it does not certify current disk bytes or historical lineage. */
export function readStoredFileContentIdentity(
  db: BetterSQLite3Database<typeof schema>,
  fileId: number,
): StoredFileContentIdentity | null {
  return db.select({
    fileId: schema.storedFile.id,
    relPath: schema.storedFile.relPath,
    sha256: schema.storedFile.sha256,
    bytes: schema.storedFile.bytes,
  }).from(schema.storedFile).where(eq(schema.storedFile.id, fileId)).get() ?? null
}

export function compareFileContentIdentity(
  registered: StoredFileContentIdentity,
  observed: FileContentIdentity,
): FileContentConflict | null {
  if (registered.sha256 === observed.sha256 && registered.bytes === observed.bytes) return null
  return {
    code: 'file_content_conflict',
    fileId: registered.fileId,
    relPath: registered.relPath,
    registered: { sha256: registered.sha256, bytes: registered.bytes },
    observed: { sha256: observed.sha256, bytes: observed.bytes },
  }
}
