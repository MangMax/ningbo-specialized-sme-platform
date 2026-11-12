import { requireH1cReady } from '../../lib/platform/h1c-catalog'
import { sqliteConnection } from '../../lib/platform/target-connection'
/** Correspondence's explicit successor binding; ordinary startup remains guarded. */
import { getTableColumns, sql } from 'drizzle-orm'
import { integer, sqliteTable } from 'drizzle-orm/sqlite-core'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as s from '../../db/schema'
import { correspondenceFields } from '../../lib/platform/correspondence-target'
import { targetSchema } from '../../lib/platform/target-schema'

type Db = BetterSQLite3Database<typeof s>
const a = targetSchema.platformLegacyRelationAlias
// relationId is the service's internal storage slot here. Public reads reverse the alias.
const target = sqliteTable('record_correspondence', {
  ...correspondenceFields(),
  relationId: integer('observation_id').references(() => targetSchema.platformBusinessObservation.id),
})
// Offline migration replaces the target before opening a runtime connection. Only its fixed
// schema binding is retained here; source rows and decision validity remain request-local.
const targetConnections = new WeakMap<object, boolean>()
export function correspondenceTarget(db: Db) {
  const connection = sqliteConnection(db)
  const known = targetConnections.get(connection)
  if (known !== undefined) return known
  const phase = Number(connection.pragma('user_version', { simple: true }))
  if (![0,71605,71606,71607,71608,71609,71610,71611,71612].includes(phase)) throw new Error('Unsupported correspondence target schema version')
  const target = phase === 71611 || phase === 71612
  if (target) requireH1cReady(connection)
  targetConnections.set(connection, target)
  return target
}
export function correspondenceTable(db: Db) { return correspondenceTarget(db) ? target : s.recordCorrespondence }
export function externalRelationColumn(db: Db) {
  const t = correspondenceTable(db)
  return correspondenceTarget(db) ? sql<number | null>`(select ${a.oldId} from ${a} where ${a.observationId} = ${sql.identifier('record_correspondence')}.${sql.identifier('observation_id')})` : sql<number | null>`${t.relationId}`
}
export function correspondenceColumns(db: Db) {
  return { ...getTableColumns(correspondenceTable(db)), relationId: externalRelationColumn(db) }
}
