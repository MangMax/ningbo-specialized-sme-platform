import { count, inArray } from 'drizzle-orm'
import { QueryBuilder } from 'drizzle-orm/pg-core'
import { storedFile as postgresStoredFile } from '../../../../db/postgresql/file-tables'
import { postgresLeadListVersion } from '../../../../db/postgresql/lead-tables'
import type { FileCategoryServer } from '../../../core/server/utils/file-store'
import manifest from '../../manifest'

export const leadListFileServerCategory = {
  id: manifest.id,
  ...manifest.fileCategories,
  postgres: {
    async countReferences(db, ids) {
      const rows = await db.select({ id: postgresLeadListVersion.fileId, referenceCount: count() }).from(postgresLeadListVersion)
        .where(inArray(postgresLeadListVersion.fileId, ids)).groupBy(postgresLeadListVersion.fileId)
      return new Map(rows.map(({ id, referenceCount }) => [id, referenceCount]))
    },
    constraint(filters) {
      if (filters.leadListUsage?.includes('source')) {
        const sources = new QueryBuilder().select({ id: postgresLeadListVersion.fileId }).from(postgresLeadListVersion)
        return inArray(postgresStoredFile.id, sources)
      }
    },
  },
} satisfies FileCategoryServer
