import { correspondenceTable, correspondenceTarget } from './record-correspondence-store'
import { listRecordCorrespondencesForIds } from './record-correspondence'
import { and, eq, getTableColumns, inArray, sql, type SQL } from 'drizzle-orm'
import { alias, type SQLiteTable } from 'drizzle-orm/sqlite-core'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as s from '../../db/schema'
import { normalizeUscc } from '../../lib/domain'
import { currentProofCoversRows, currentRowProofIds } from './comparison-scope-proof'
import { correspondenceIdentityProblem } from './record-correspondence-identity'
import { storedProcessProjection } from '../../lib/platform/process-stored-schema'

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
const target = alias(s.enterprise,'ref_target')
/** Narrow reverse-link validity, with the same immutable source/change boundary.
 * Proof revalidation retains its existing service behind a 64KiB read budget;
 * a larger proof is explicitly unknown/requiresRevalidation, never assumed valid.
 */
export function correspondenceRefValidity(db: Db, ids: number[]): Map<number, boolean> {
  return createCorrespondenceRefValidityReader(db)(ids)
}

/** Reuse compilation only. Each invocation revalidates live source rows and proofs;
 * no validity result, archive or source fingerprint survives the call. */
export function createCorrespondenceRefValidityReader(db: Db) {
  if (correspondenceTarget(db)) {
    const target = correspondenceTable(db)
    const blobStatuses = db.select({ id: target.id }).from(target)
      .innerJoin(storedProcessProjection, eq(storedProcessProjection.observationId, target.relationId))
      .where(and(sql`${target.id} in (select value from json_each(${sql.placeholder('ids')}))`, sql`typeof(${storedProcessProjection.storedStatus}) = 'blob'`)).prepare()
    return (ids: number[]) => {
      if (!ids.length) return new Map<number, boolean>()
      const validity = new Map(listRecordCorrespondencesForIds(db, ids).map(row => [row.id, row.requiresRevalidation]))
      // The old reverse-link SQL compares saved JSON with the native status cell.
      // A saved Buffer object never IS a SQLite BLOB, unlike the full fingerprint.
      for (const row of blobStatuses.all({ ids: JSON.stringify(ids) })) validity.set(row.id, true)
      return validity
    }
  }
  const checks = and(
    sql`case when ${t.eventId} is null then ${value('$.event')} is null else ${eventMatches(sql`${t.eventId}`,'')} end`,
    sql`case when ${t.predecessorEventId} is null then ${value('$.predecessor')} is null else ${eventMatches(sql`${t.predecessorEventId}`,'$.predecessor')} end`,
    sql`case when ${t.relationId} is null then ${value('$.relation')} is null and ${value('$.query')} is null else ${rowMatches(s.platformRelation,'$.relation',sql`${t.relationId}`)} and ${rowMatches(s.platformQuery,'$.query',sql`(select ${s.platformRelation.queryId} from ${s.platformRelation} where ${s.platformRelation.id} = ${t.relationId})`)} end`,
    sql`case when ${t.exportRowId} is null then ${value('$.exportRow')} is null and ${value('$.exportBatch')} is null else ${rowMatches(s.platformExportRow,'$.exportRow',sql`${t.exportRowId}`)} and ${rowMatches(s.platformExportBatch,'$.exportBatch',sql`(select ${s.platformExportRow.batchId} from ${s.platformExportRow} where ${s.platformExportRow.id} = ${t.exportRowId})`)} end`,
  )!
  const prepared = db.select({ id:t.id, relationUscc:relation.usccRaw, relationEnterpriseId:relation.enterpriseId, relationStatus:relation.verificationStatus, ownerId:owner.id, ownerUscc:owner.usccNorm, targetId:target.id, targetUscc:target.usccNorm, targetTitle:s.title.code, matches: sql<number>`${checks}`, type:t.type, role:t.role, enterpriseId:t.enterpriseId, titleCode:t.titleCode, relationId:t.relationId, exportRowId:t.exportRowId,
    proofIds: sql`json_extract(${t.provenance}, '$.comparisonProofIds')`.mapWith({mapFromDriverValue:(v: string|null) => v ? JSON.parse(v) as number[] : []}),
  }).from(t).leftJoin(relation,eq(relation.id,t.relationId)).leftJoin(owner,eq(owner.id,relation.enterpriseId)).leftJoin(target,eq(target.id,t.enterpriseId)).leftJoin(s.title,eq(s.title.code,t.titleCode)).where(sql`${t.id} in (select value from json_each(${sql.placeholder('ids')}))`).prepare()
  return (ids: number[]): Map<number, boolean> => {
    if (!ids.length) return new Map()
    const rows = prepared.all({ ids: JSON.stringify(ids) })
    return new Map(rows.map(row => [row.id, needsRevalidation(row)]))
  }

  function needsRevalidation(row: ReturnType<typeof prepared.all>[number]): boolean {
    if (!row.matches) return true
    if (row.relationEnterpriseId && row.relationUscc && (!row.ownerId || row.ownerUscc && normalizeUscc(row.ownerUscc) !== normalizeUscc(row.relationUscc))) return true
    if (row.type === 'later_process') {
      if (!row.targetId || !row.targetTitle || correspondenceIdentityProblem({ enterpriseId:row.enterpriseId, uscc:row.targetUscc }, { enterpriseId:row.relationEnterpriseId, uscc:row.relationUscc }, true)) return true
      if (!normalizeUscc(row.relationUscc) && row.relationStatus !== 'confirmed') return true
    }
    if (row.type === 'recognized_export' && row.role === 'same_current_row') {
      // Existing proof service hashes its full source set. Refuse an unbounded
      // source set before calling it, without materializing those source rows.
      const proofIds = currentRowProofIds(db,row.proofIds,row.relationId!,row.exportRowId!)
      if (!proofIds.length) return true
      const proof = s.comparisonScopeProof
      const queryId = sql`json_extract(${proof.evidence}, '$.queryId')`
      const batchId = sql`json_extract(${proof.evidence}, '$.exportBatchId')`
      const freezeId = sql`json_extract(${proof.evidence}, '$.scope.freezeFileId')`
      const bytes = (table: SQLiteTable) => sql.join(Object.values(getTableColumns(table)).map(column => sql`coalesce(length(cast(${column} as blob)),0)`),sql` + `)
      // Sum per proof, not per distinct source: the existing service reads each
      // proof's full source and audit separately, including its freeze file.
      // Also include the two endpoint rows read by currentProofCoversRows itself.
      const budget = db.get<{bytes:number}>(sql`select
        coalesce((select sum(
          ${bytes(proof)} +
          coalesce((select sum(${bytes(s.comparisonScopeProofAudit)}) from ${s.comparisonScopeProofAudit} where ${s.comparisonScopeProofAudit.proofId} = ${proof.id}),0) +
          coalesce((select ${bytes(s.platformQuery)} from ${s.platformQuery} where ${s.platformQuery.id} = ${queryId}),0) +
          coalesce((select sum(${bytes(s.platformRelation)}) from ${s.platformRelation} where ${s.platformRelation.queryId} = ${queryId}),0) +
          coalesce((select ${bytes(s.platformExportBatch)} from ${s.platformExportBatch} where ${s.platformExportBatch.id} = ${batchId}),0) +
          coalesce((select sum(${bytes(s.platformExportRow)}) from ${s.platformExportRow} where ${s.platformExportRow.batchId} = ${batchId}),0) +
          coalesce((select ${bytes(s.storedFile)} from ${s.storedFile} where ${s.storedFile.id} = ${freezeId}),0)
        ) from ${proof} where ${inArray(proof.id,proofIds)}),0) +
        coalesce((select ${bytes(s.platformRelation)} from ${s.platformRelation} where ${s.platformRelation.id} = ${row.relationId}),0) +
        coalesce((select ${bytes(s.platformExportRow)} from ${s.platformExportRow} where ${s.platformExportRow.id} = ${row.exportRowId}),0) as bytes`)
      if (!budget || budget.bytes > 65536) return true
      return !currentProofCoversRows(db,proofIds,row.relationId!,row.exportRowId!)
    }
    return false
  }
}
