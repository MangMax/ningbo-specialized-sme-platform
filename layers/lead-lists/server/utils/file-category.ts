import { count, inArray, sql } from 'drizzle-orm'
import { storedFile } from '../../../../db/schema'
import type { FileCategoryServer } from '../../../core/server/utils/file-store'
import { leadListVersion } from '../../schema'
import manifest from '../../manifest'

export const leadListFileServerCategory = {
  id: manifest.id,
  ...manifest.fileCategories,
  postgres: {
    async countReferences(db, ids) {
      const { rows } = await db.execute<{ file_id: string; count: string }>(sql`
        SELECT file_id, count(*) AS count FROM lead_list_version WHERE file_id IN (${sql.join(ids.map(id => sql`${id}`), sql`, `)})
        GROUP BY file_id`)
      return new Map(rows.map(row => [Number(row.file_id), Number(row.count)]))
    },
    constraint(filters) {
      if (filters.leadListUsage?.includes('source')) {
        return sql`stored_file.id IN (SELECT file_id FROM lead_list_version)`
      }
    },
  },
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
