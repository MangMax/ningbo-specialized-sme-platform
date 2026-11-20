import { eq } from 'drizzle-orm'
import { storedFile } from '@db/schema'
import { isLibraryUploadPath, libraryUploadCategory, libraryUploadDirectory } from '../../lib/core/library-uploads'
import { extensionOf } from '../../lib/core/file-path'
import { isFilenameSafe } from '../../lib/upload-transport'
import { compareFileContentIdentity } from './file-content-identity'
import { sha256Of, splitRegistrationPath, UploadRegistrationError, type FileCategoryServer } from './file-store'

export const libraryFileServerCategory = {
  id: libraryUploadCategory,
  prepareBackfill: path => isLibraryUploadPath(path) ? () => {} : null,
  landing({ filename }) {
    if (!filename || filename === '.' || !isFilenameSafe(filename)) {
      throw { status_code: 400, body: '请使用有效的文件名。\n' }
    }
    return [libraryUploadDirectory, filename]
  },
  registration: {
    matchesPath: isLibraryUploadPath,
    prepare(input) {
      const relPath = String(input.relPath ?? '')
      const segments = splitRegistrationPath(relPath)
      if (!isLibraryUploadPath(relPath) || segments.length !== 2 || Object.keys(input).length !== 1) {
        throw new UploadRegistrationError('文件路径不属于平台上传目录，或登记请求带有其他字段。')
      }

      return async (db, { filename, abs, bytes }) => {
        const facts = { relPath, filename, ext: extensionOf(filename), bytes, sha256: await sha256Of(abs) }
        return db.transaction(tx => {
          const existing = tx.select().from(storedFile).where(eq(storedFile.relPath, relPath)).get()
          if (existing) {
            const conflict = compareFileContentIdentity({ ...existing, fileId: existing.id }, facts)
            if (conflict) throw new UploadRegistrationError('当前内容与已登记文件不一致。', 409, conflict)
            if (existing.removedAt) throw new UploadRegistrationError('文件已移出文件库。', 409)
          }
          const row = existing ?? tx.insert(storedFile).values(facts).returning().get()
          return { row: { ...row, displayName: row.displayName ?? row.filename }, created: !existing }
        }, { behavior: 'immediate' })
      }
    },
  },
} satisfies FileCategoryServer
