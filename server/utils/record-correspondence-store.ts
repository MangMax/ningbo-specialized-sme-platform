import { getTableColumns,sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as s from '../../db/schema'
import { targetSchema } from '../../lib/platform/target-schema'

type Db = BetterSQLite3Database<typeof s>
const a = targetSchema.platformLegacyRelationAlias
// Public relation IDs resolve through the alias; stored correspondence owns observation_id.
export function correspondenceTable(db: Db) { return s.recordCorrespondence }
export function externalRelationColumn(db: Db) {
  return sql<number | null>`(select ${a.oldId} from ${a} where ${a.observationId} = ${sql.identifier('record_correspondence')}.${sql.identifier('observation_id')})`
}
export function correspondenceColumns(db: Db) {
  const { observationId: _observationId, ...columns } = getTableColumns(s.recordCorrespondence)
  return { ...columns, relationId: externalRelationColumn(db) }
}
