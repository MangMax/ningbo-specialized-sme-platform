import { createError } from 'h3'
import { stat } from 'node:fs/promises'
import { relative } from 'node:path'
import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../../../../db/schema'
import { compareFileContentIdentity, readStoredFileContentIdentity, type StoredFileContentIdentity } from './file-content-identity'
import { resolveInsideRoot, sha256Of } from './file-store'

type Db = BetterSQLite3Database<typeof schema>
export interface FileReadIdentity {
  registered: StoredFileContentIdentity | null
  status: 'verified' | 'unknown'
  /** Registration does not establish the identity of older evidence or OCR. */
  historical: 'unknown'
}

export function registeredFileAtLocator(db: Db, relPath: string) {
  const row = db.select({ id: schema.storedFile.id }).from(schema.storedFile).where(eq(schema.storedFile.relPath, relPath)).get()
  return row ? readStoredFileContentIdentity(db, row.id) : null
}

/** A locator resolves a registered ID; it never becomes a content identity. */
export async function verifyFileRead(db: Db, root: string, locator: string): Promise<FileReadIdentity> {
  const abs = resolveInsideRoot(root, locator)
  if (!abs) throw createError({ statusCode: 403, message: '路径越界' })
  const registered = registeredFileAtLocator(db, relative(root, abs).split('\\').join('/'))
  if (!registered || !/^[a-f0-9]{64}$/i.test(registered.sha256)) {
    return { registered, status: 'unknown', historical: 'unknown' }
  }
  let before
  try { before = await stat(abs) } catch {
    throw createError({ statusCode: 404, message: '文件不存在' })
  }
  if (!before.isFile()) throw createError({ statusCode: 404, message: '不是一个文件' })
  const observed = { sha256: await sha256Of(abs), bytes: before.size }
  const after = await stat(abs)
  const conflict = compareFileContentIdentity(registered, observed)
  if (conflict) throw createError({ statusCode: 409, message: 'file_content_conflict', data: conflict })
  if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
    throw createError({ statusCode: 409, message: 'file_content_conflict', data: { code: 'file_content_conflict', fileId: registered.fileId, reason: 'changed_during_read' } })
  }
  return { registered, status: 'verified', historical: 'unknown' }
}

/** Existing v2 manifest is the only available page/source lineage. No backfill. */
export async function verifyPageRead(db: Db, root: string, source: string, pagePath?: string, verified?: FileReadIdentity) {
  const identity = verified ?? await verifyFileRead(db, root, source)
  const { readFile } = await import('node:fs/promises')
  const { manifestRelPath } = await import('../../lib/pdf-page')
  const manifestAbs = resolveInsideRoot(root, manifestRelPath(source))
  let manifest: { version?: number; file?: string; sourceSha256?: string; sourceBytes?: number; pages?: { relPath: string; bytes: number }[] } | null = null
  try { manifest = JSON.parse(await readFile(manifestAbs!, 'utf8')) } catch { /* Unknown lineage remains unknown. */ }
  if (!manifest || manifest.version !== 2) {
    return { ...identity, status: 'unknown' as const }
  }
  const expected = identity.registered
  if (manifest.file !== source) {
    throw createError({ statusCode: 409, message: 'file_content_conflict', data: { code: 'file_content_conflict', fileId: expected?.fileId ?? null, reason: 'page_source_mismatch' } })
  }
  if (!Array.isArray(manifest.pages)) {
    throw createError({ statusCode: 409, message: 'file_content_unknown', data: { code: 'file_content_unknown', historical: 'unknown' } })
  }
  // Unregistered compatibility sources still have to agree with their page manifest.
  const abs = resolveInsideRoot(root, source)!
  const sha256 = expected && identity.status === 'verified' ? expected.sha256 : await sha256Of(abs)
  const bytes = expected && identity.status === 'verified' ? expected.bytes : (await stat(abs)).size
  if (manifest.sourceSha256 !== sha256 || manifest.sourceBytes !== bytes) {
    throw createError({ statusCode: 409, message: 'file_content_conflict', data: { code: 'file_content_conflict', fileId: expected?.fileId ?? null, reason: 'page_source_mismatch' } })
  }
  if (pagePath) {
    const entry = manifest.pages.find(p => p.relPath === pagePath)
    const pageAbs = resolveInsideRoot(root, pagePath)
    if (!entry || !pageAbs || (await stat(pageAbs)).size !== entry.bytes) {
      throw createError({ statusCode: 409, message: 'file_content_conflict', data: { code: 'file_content_conflict', reason: 'page_manifest_mismatch' } })
    }
  }
  return identity
}

/** Historical readers keep their text even when the mutable current locator conflicts. */
export async function describeFileRead(db: Db, root: string, locator: string) {
  try { return await verifyFileRead(db, root, locator) } catch (error) {
    const failure = error as { statusCode?: number; code?: string; data?: unknown }
    if (failure.statusCode === 403) throw error
    let status: 'file_content_conflict' | 'missing' | 'unavailable'
    if (failure.statusCode === 409) status = 'file_content_conflict'
    else if (failure.statusCode === 404 || failure.code === 'ENOENT' || failure.code === 'ENOTDIR') status = 'missing'
    else if (failure.code === 'EACCES' || failure.code === 'EPERM') status = 'unavailable'
    else throw error
    return { registered: registeredFileAtLocator(db, locator), status, historical: 'unknown' as const, conflict: failure.data ?? null }
  }
}
