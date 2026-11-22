import type { LogContext } from '../../../../core/lib/logging'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { eq } from 'drizzle-orm'
import * as schema from '../../../../../db/schema'
import { checkAdmission, getStoredFile } from '../../../../core/server/utils/stored-files'
import { fileRegistrationFacts, runFileRegistration, UploadRegistrationError, type RegistrationWriter } from '../../../../core/server/utils/file-store'
import { createClassifiedFile } from '../../utils/roster-file-classification'
import { recordLegacyFileMaintenanceWrite } from '../../../../core/server/utils/file-maintenance'
import { compareFileContentIdentity } from '../../../../core/server/utils/file-content-identity'
import { declaredClassification, parseUploadDeclaration, type UploadDeclaration } from './file-upload'
export { parseUploadDeclaration } from './file-upload'

function prepareRosterWriter(input: UploadDeclaration): RegistrationWriter {
  const classification = declaredClassification(input)
  return async (db, file) => {
    const facts = await fileRegistrationFacts(file)
    return db.transaction((tx) => {
      const existing = tx
        .select()
        .from(schema.storedFile)
        .where(eq(schema.storedFile.relPath, facts.relPath))
        .get()

      if (existing) {
        const conflict = compareFileContentIdentity({ ...existing, fileId: existing.id }, facts)
        if (conflict) {
          throw new UploadRegistrationError('文件内容与登记身份不符,请恢复原文件或使用新路径登记', 409, conflict)
        }
        const before = getStoredFile(tx, existing.id)!
        tx.update(schema.storedFile)
          .set({ filename: facts.filename, ext: facts.ext, removedAt: null })
          .where(eq(schema.storedFile.id, existing.id))
          .run()
        tx.update(schema.rosterFileClassification).set(classification)
          .where(eq(schema.rosterFileClassification.fileId, existing.id)).run()
        const row = getStoredFile(tx, existing.id)!
        recordLegacyFileMaintenanceWrite(tx, before, row)
        return { row, created: false }
      }

      const inserted = createClassifiedFile(tx, facts, classification)
      return { row: getStoredFile(tx, inserted.id)!, created: true }
    }, { behavior: 'immediate' })
  }
}

export function prepareRosterRegistration(input: Record<string, unknown>): RegistrationWriter {
  return prepareRosterWriter(parseUploadDeclaration(input))
}

export function registerStoredFile(
  db: BetterSQLite3Database<typeof schema>, filesRoot: string, input: UploadDeclaration,
  context: LogContext = {},
) {
  return runFileRegistration(db, filesRoot, input.relPath, () => prepareRosterWriter(input), checkAdmission, context)
}
