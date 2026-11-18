import type { initializeDb } from '../../../db/client'
import * as schema from '../../../db/schema'
import { listPlatformQueries } from '../../../layers/sme-roster/lib/platform/read'
import { readPlatformQueryEvidence } from '../../../layers/sme-roster/lib/platform/evidence-read'

type Db = ReturnType<typeof initializeDb>

/** Read retained public aliases and DTOs through the native evidence boundary. */
export function nativeQueryRows(db: Db) {
  return db.select().from(schema.platformLegacyQueryAlias).all().map(alias =>
    listPlatformQueries(db, { queryId: alias.oldId, includeRawResponse: true }).rows[0]!.query)
}

export function nativeRelationRows(db: Db) {
  return db.select().from(schema.platformLegacyQueryAlias).all().flatMap(alias =>
    listPlatformQueries(db, { queryId: alias.oldId }).rows[0]!.relations)
}
