/** Correspondence's explicit successor binding; ordinary startup remains guarded. */
import { getTableColumns,sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as s from '../../db/schema'
import { targetSchema } from '../../lib/platform/target-schema'

type Db = BetterSQLite3Database<typeof s>
const a = targetSchema.platformLegacyRelationAlias
// relationId is the service's internal storage slot here. Public reads reverse the alias.

// Offline migration replaces the target before opening a runtime connection. Only its fixed
// schema binding is retained here; source rows and decision validity remain request-local.
export function correspondenceTable(db: Db) { return s.recordCorrespondence }
export function externalRelationColumn(db: Db) {
  return sql<number | null>`(select ${a.oldId} from ${a} where ${a.observationId} = ${sql.identifier('record_correspondence')}.${sql.identifier('observation_id')})`
}
export function correspondenceColumns(db: Db) {
  const { observationId: _observationId, ...columns } = getTableColumns(s.recordCorrespondence)
  return { ...columns, relationId: externalRelationColumn(db) }
}
