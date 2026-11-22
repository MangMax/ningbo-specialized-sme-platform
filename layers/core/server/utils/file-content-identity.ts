import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { StoredFileContentIdentity } from './file-identity'
import * as schema from '../../../../db/schema'
export * from './file-identity'

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
