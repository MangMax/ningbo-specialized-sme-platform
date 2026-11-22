import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../../../../db/schema'
import { readStoredFileContentIdentity } from './file-content-identity'
import { describeFileReadAtLocator, verifyFileReadAtLocator, verifyRenderedPageRead, type FileReadIdentity } from './file-read'
export * from './file-read'

type Db = BetterSQLite3Database<typeof schema>
export function registeredFileAtLocator(db: Db, relPath: string) {
  const row = db.select({ id: schema.storedFile.id }).from(schema.storedFile).where(eq(schema.storedFile.relPath, relPath)).get()
  return row ? readStoredFileContentIdentity(db, row.id) : null
}

/** A locator resolves a registered ID; it never becomes a content identity. */
export async function verifyFileRead(db: Db, root: string, locator: string): Promise<FileReadIdentity> {
  return verifyFileReadAtLocator(root, locator, path => registeredFileAtLocator(db, path))
}

/** Existing v2 manifest is the only available page/source lineage. No backfill. */
export async function verifyPageRead(db: Db, root: string, source: string, pagePath?: string, verified?: FileReadIdentity) {
  const identity = verified ?? await verifyFileRead(db, root, source)
  return verifyRenderedPageRead(root, source, identity, pagePath)
}

/** Historical readers keep their text even when the mutable current locator conflicts. */
export function describeFileRead(db: Db, root: string, locator: string) {
  return describeFileReadAtLocator(root, locator, path => registeredFileAtLocator(db, path))
}
