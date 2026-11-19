import { count, inArray, sql } from 'drizzle-orm'
import { storedFile } from '../../../../db/schema'
import type { FileCategoryServer } from '../../../core/server/utils/file-store'
import { leadListVersion } from '../../schema'
import manifest from '../../manifest'

export const leadListFileServerCategory = {
  id: manifest.id,
  ...manifest.fileCategories,
  readFields(db, ids) {
    if (!db.get(sql`SELECT 1 FROM sqlite_schema WHERE type='table' AND name='lead_list_row'`)) return new Map()
    const rows = db.select({ id: leadListVersion.fileId, referenceCount: count() }).from(leadListVersion)
      .where(inArray(leadListVersion.fileId, ids)).groupBy(leadListVersion.fileId).all()
    return new Map(rows.map(({ id, referenceCount }) => [id, { referenceCount }]))
  },
  constraint(db, filters) {
    if (!filters.leadListUsage?.includes('source')) return
    if (!db.get(sql`SELECT 1 FROM sqlite_schema WHERE type='table' AND name='lead_list_row'`)) return inArray(storedFile.id, [])
    return inArray(storedFile.id, db.select({ id: leadListVersion.fileId }).from(leadListVersion))
  },
} satisfies FileCategoryServer
