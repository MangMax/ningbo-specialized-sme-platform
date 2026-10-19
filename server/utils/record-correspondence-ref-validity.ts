import { and, eq, getTableColumns, inArray, sql, type SQL } from 'drizzle-orm'
import { alias, type SQLiteTable } from 'drizzle-orm/sqlite-core'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as s from '../../db/schema'
import { normalizeUscc } from '../../lib/domain'
import { currentProofCoversRows } from './comparison-scope-proof'

type Db = BetterSQLite3Database<typeof s>
const t = s.recordCorrespondence
const value = (path: string) => sql`json_extract(${t.provenance}, ${path})`
/** Compare inside SQLite, including archives. Only the boolean crosses the driver.
 * JSON columns are compared after SQLite's JSON normalization, as on persistence.
 * This compares the saved source snapshot rather than loading it to hash it again.
 */
function fields(table: SQLiteTable, path: string, versioned = false): SQL {
  return and(...Object.entries(getTableColumns(table)).map(([key, column]) => {
    const saved = value(path + '.' + key)
    if (versioned && key === 'revision') return sql`${saved} is case when ${column} <= 1 then null else ${column} end`
    return column.dataType === 'json' ? sql`json(${saved}) is json(${column})` : sql`${saved} is ${column}`
  }))!
}
function rowMatches(table: SQLiteTable & { id: unknown }, path: string, id: SQL, versioned = false): SQL {
  return sql`exists (select 1 from ${table} where ${table.id} = ${id} and ${fields(table, path, versioned)})`
}
function evidenceMatches(eventId: SQL, path: string): SQL {
  const e = s.recordEvidence, file = s.storedFile
  // json_each is kept inside SQLite too; no saved provenance is materialized.
  const entry = sql.raw('saved.value')
  const savedFile = (key: string) => sql`json_extract(${entry}, ${'$.storedFile.' + key})`
  const fileMatches = sql`((json_extract(${entry}, '$.storedFile') is null and not exists (select 1 from ${file} where ${file.relPath} = ${e.sourceFile})) or exists (select 1 from ${file} where ${file.relPath} = ${e.sourceFile} and ${and(...(['id','relPath','bytes','sha256','removedAt'] as const).map(key => sql`${file[key]} is ${savedFile(key)}`))}))`
  const evidenceFields = and(...Object.entries(getTableColumns(e)).map(([key, column]) => sql`${column} is json_extract(${entry}, ${'$.evidence.' + key})`))
  return sql`json_array_length(${t.provenance}, ${path}) = (select count(*) from ${e} where ${e.recordEventId} = ${eventId}) and not exists (select 1 from ${e} where ${e.recordEventId} = ${eventId} and not exists (select 1 from json_each(${t.provenance}, ${path}) saved where ${evidenceFields} and ${fileMatches}))`
}
function eventMatches(id: SQL, prefix: string): SQL {
  const eventPath = prefix ? prefix + '.event' : '$.event'
  const recordPath = prefix ? prefix + '.record' : '$.record'
  const enterprisePath = prefix ? prefix + '.enterprise' : '$.officialEnterprise'
  const event = s.recordEvent, record = s.record
  return and(
    rowMatches(event,eventPath,id,true),
    rowMatches(record,recordPath,sql`(select ${event.recordId} from ${event} where ${event.id} = ${id})`),
    rowMatches(s.enterprise,enterprisePath,sql`(select ${record.enterpriseId} from ${record} where ${record.id} = ${value(recordPath + '.id')})`),
    evidenceMatches(id,prefix ? prefix + '.officialEvidence' : '$.officialEvidence'),
  )!
}
const owner = alias(s.enterprise,'ref_owner')
const relation = alias(s.platformRelation,'ref_relation')
/** Narrow reverse-link validity, with the same immutable source/change boundary.
 * Proof revalidation retains its existing service behind a 64KiB read budget;
 * a larger proof is explicitly unknown/requiresRevalidation, never assumed valid.
 */
export function correspondenceRefValidity(db: Db, ids: number[]): Map<number, boolean> {
  const checks = and(
    sql`case when ${t.eventId} is null then ${value('$.event')} is null else ${eventMatches(sql`${t.eventId}`,'')} end`,
    sql`case when ${t.predecessorEventId} is null then ${value('$.predecessor')} is null else ${eventMatches(sql`${t.predecessorEventId}`,'$.predecessor')} end`,
    sql`case when ${t.relationId} is null then ${value('$.relation')} is null and ${value('$.query')} is null else ${rowMatches(s.platformRelation,'$.relation',sql`${t.relationId}`)} and ${rowMatches(s.platformQuery,'$.query',sql`(select ${s.platformRelation.queryId} from ${s.platformRelation} where ${s.platformRelation.id} = ${t.relationId})`)} end`,
    sql`case when ${t.exportRowId} is null then ${value('$.exportRow')} is null and ${value('$.exportBatch')} is null else ${rowMatches(s.platformExportRow,'$.exportRow',sql`${t.exportRowId}`)} and ${rowMatches(s.platformExportBatch,'$.exportBatch',sql`(select ${s.platformExportRow.batchId} from ${s.platformExportRow} where ${s.platformExportRow.id} = ${t.exportRowId})`)} end`,
  )!
  const rows = db.select({ id:t.id, relationUscc:relation.usccRaw, ownerUscc:owner.usccNorm, matches: sql<number>`${checks}`, type:t.type, role:t.role, enterpriseId:t.enterpriseId, titleCode:t.titleCode, relationId:t.relationId, exportRowId:t.exportRowId,
    proofIds: sql`json_extract(${t.provenance}, '$.comparisonProofIds')`.mapWith({mapFromDriverValue:(v: string|null) => v ? JSON.parse(v) as number[] : []}),
  }).from(t).leftJoin(relation,eq(relation.id,t.relationId)).leftJoin(owner,eq(owner.id,relation.enterpriseId)).where(inArray(t.id,ids)).all()
  return new Map(rows.map(row => [row.id, needsRevalidation(row)]))

  function needsRevalidation(row: typeof rows[number]): boolean {
    if (!row.matches) return true
    if (row.relationUscc && row.ownerUscc && normalizeUscc(row.ownerUscc) !== normalizeUscc(row.relationUscc)) return true
    if (row.type === 'later_process' && (!db.select({id:s.enterprise.id}).from(s.enterprise).where(eq(s.enterprise.id,row.enterpriseId!)).get() || !db.select({code:s.title.code}).from(s.title).where(eq(s.title.code,row.titleCode)).get())) return true
    if (row.type === 'recognized_export' && row.role === 'same_current_row') {
      // Existing proof service hashes its full source set. Refuse an unbounded
      // source set before calling it, without materializing those source rows.
      const proofIds = JSON.stringify(row.proofIds)
      const selected = sql`id in (select value from json_each(${proofIds}))`
      const queryIds = sql`(select json_extract(evidence,'$.queryId') from comparison_scope_proof where ${selected})`
      const batchIds = sql`(select json_extract(evidence,'$.exportBatchId') from comparison_scope_proof where ${selected})`
      const bytes = (table: SQLiteTable) => sql.join(Object.values(getTableColumns(table)).map(column => sql`coalesce(length(cast(${column} as blob)),0)`),sql` + `)
      const budget = db.get<{bytes:number}>(sql`select
        coalesce((select sum(${bytes(s.platformQuery)}) from ${s.platformQuery} where ${s.platformQuery.id} in ${queryIds}),0) +
        coalesce((select sum(${bytes(s.platformRelation)}) from ${s.platformRelation} where ${s.platformRelation.queryId} in ${queryIds}),0) +
        coalesce((select sum(${bytes(s.platformExportRow)}) from ${s.platformExportRow} where ${s.platformExportRow.batchId} in ${batchIds}),0) +
        coalesce((select sum(${bytes(s.platformExportBatch)}) from ${s.platformExportBatch} where ${s.platformExportBatch.id} in ${batchIds}),0) +
        coalesce((select sum(${bytes(s.comparisonScopeProof)}) from ${s.comparisonScopeProof} where ${selected}),0) as bytes`)
      if (!budget || budget.bytes > 65536) return true
      return !currentProofCoversRows(db,row.proofIds,row.relationId!,row.exportRowId!)
    }
    return false
  }
}
