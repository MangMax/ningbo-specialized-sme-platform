import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../../db/schema'

type Db = BetterSQLite3Database<typeof schema>
const { storedFile, rosterFileClassification } = schema

export const fileClassificationJoin = eq(storedFile.id, rosterFileClassification.fileId)

export const classificationColumns = {
  source: rosterFileClassification.source,
  kind: rosterFileClassification.kind,
  year: rosterFileClassification.year,
  batch: rosterFileClassification.batch,
  titleCode: rosterFileClassification.titleCode,
  categoryState: rosterFileClassification.categoryState,
  parseState: rosterFileClassification.parseState,
}

export function createClassifiedFile(
  db: Db,
  file: typeof storedFile.$inferInsert,
  classification: Omit<typeof rosterFileClassification.$inferInsert, 'fileId'>,
) {
  return db.transaction(tx => {
    const inserted = tx.insert(storedFile).values(file).returning().get()
    tx.insert(rosterFileClassification).values({ ...classification, fileId: inserted.id }).run()
    return inserted
  })
}
