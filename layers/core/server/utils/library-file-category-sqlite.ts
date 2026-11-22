import { eq } from 'drizzle-orm'
import { storedFile } from '../../../../db/schema'
import { isLibraryUploadPath } from '../../lib/core/library-uploads'
import { compareFileContentIdentity } from './file-identity'
import { fileRegistrationFacts, UploadRegistrationError } from './file-store-contract'
import type { FileCategoryServer } from './file-store'
import { libraryFileServerCategory as postgresCategory, validateLibraryRegistration } from './library-file-category'

export const libraryFileServerCategory = {
  ...postgresCategory,
  prepareBackfill: path => isLibraryUploadPath(path) ? () => {} : null,
  registration: {
    ...postgresCategory.registration,
    prepare(input) {
      validateLibraryRegistration(input)
      return async (db, file) => {
        const facts = await fileRegistrationFacts(file)
        const { relPath } = facts
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
