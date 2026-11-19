import { and,eq,getTableColumns,sql,type SQL } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { alias,type SQLiteTable } from 'drizzle-orm/sqlite-core'
import * as s from '../../../../db/schema'
import { normalizeUscc } from '../../lib/domain'
import { storedProcessProjection } from '../../lib/platform/process-stored-schema'
import { sourceQueryFields,sourceRelationFields } from '../../lib/platform/source-snapshot-fields'
import { targetSchema } from '../../lib/platform/target-schema'
import { listRecordCorrespondencesForIds } from './record-correspondence'
import { correspondenceIdentityProblem } from './record-correspondence-identity'
import { correspondenceTable } from './record-correspondence-store'

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
/** Historical fingerprint equality stays inside SQLite. Decode the sealed cells
 * once per row; no original body or parsed provenance crosses the driver. */
function targetSourceMatches(observationId: SQL): SQL {
  const original = () => {
    const kind = sql`json_extract(cell.value,'$.storageClass')`, bytes = sql`unhex(json_extract(cell.value,'$.hex'))`
    return sql`case ${kind} when 'null' then null when 'text' then cast(${bytes} as text) when 'integer' then cast(${bytes} as integer) when 'real' then cast(${bytes} as real) else ${bytes} end`
  }
  const currentAssignment = (column: string) => sql`(select ${sql.identifier(column)} from platform_observation_assignment where observation_id=o.id order by revision desc limit 1)`
  const relationFields = Object.entries(sourceRelationFields).map(([key,column]) => {
    const actual = key==='id' ? sql`ra.old_id` : key==='queryId' ? sql`qa.old_id`
      : key==='enterpriseId' ? currentAssignment('enterprise_id') : key==='matchBasis' ? currentAssignment('match_basis')
      : key==='verificationStatus' ? currentAssignment('verification_status') : original()
    const matches=column.dataType==='json' ? sql`json(${value('$.relation.'+key)}) is json(${actual})` : sql`${value('$.relation.'+key)} is ${actual}`
    return sql`when ${column.name} then ${matches}`
  })
  const queryFields = Object.entries(sourceQueryFields).map(([key,column]) => {
    const actual = key==='id' ? sql`qa.old_id`
      : key==='rawResponse'||key==='collectionEvidence' ? sql`(select cast(v.bytes as text) from platform_collection_archive_ref r join platform_archive_value v on v.id=r.archive_id where r.owner_id=c.id and r.field=${key})`
      : sql`c.${sql.identifier(column.name)}`
    return column.dataType==='json' ? sql`json(${value('$.query.'+key)}) is json(${actual})` : sql`${value('$.query.'+key)} is ${actual}`
  })
  return sql`exists(select 1 from platform_business_observation o
    join platform_legacy_relation_alias ra on ra.observation_id=o.id
    join platform_collection c on c.id=o.collection_id
    join platform_legacy_query_alias qa on qa.collection_id=c.id
    join platform_observation_archive_ref sr on sr.owner_id=o.id and sr.field='legacyRowSnapshot'
    join platform_archive_value snapshot on snapshot.id=sr.archive_id
    where o.id=${observationId}
      and (select count(*) from json_each(snapshot.bytes,'$.fields') cell where json_extract(cell.value,'$.name') in (${sql.join(Object.values(sourceRelationFields).map(c=>sql`${c.name}`),sql`, `)}))=${relationFields.length}
      and not exists(select 1 from json_each(snapshot.bytes,'$.fields') cell where not(case json_extract(cell.value,'$.name') ${sql.join(relationFields,sql` `)} else 1 end))
      and ${and(...queryFields)})`
}
const owner = alias(s.enterprise,'ref_owner')
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

    const target = correspondenceTable(db)
    const blobStatuses = db.select({ id: target.id }).from(target)
      .innerJoin(storedProcessProjection, eq(storedProcessProjection.observationId, target.observationId))
      .where(and(sql`${target.id} in (select value from json_each(${sql.placeholder('ids')}))`, sql`typeof(${storedProcessProjection.storedStatus}) = 'blob'`)).prepare()
    const sourceMatches = and(
      sql`case when ${target.eventId} is null then ${value('$.event')} is null else ${eventMatches(sql`${target.eventId}`,'')} end`,
      sql`case when ${target.predecessorEventId} is null then ${value('$.predecessor')} is null else ${eventMatches(sql`${target.predecessorEventId}`,'$.predecessor')} end`,
      sql`case when ${target.observationId} is null then ${value('$.relation')} is null and ${value('$.query')} is null else ${targetSourceMatches(sql`${target.observationId}`)} end`,
      sql`case when ${target.exportRowId} is null then ${value('$.exportRow')} is null and ${value('$.exportBatch')} is null else ${rowMatches(s.platformExportRow,'$.exportRow',sql`${target.exportRowId}`)} and ${rowMatches(s.platformExportBatch,'$.exportBatch',sql`(select ${s.platformExportRow.batchId} from ${s.platformExportRow} where ${s.platformExportRow.id}=${target.exportRowId})`)} end`,
    )!
    const assignment=targetSchema.platformObservationAssignment
    const prepared=db.select({id:target.id,type:target.type,role:target.role,enterpriseId:target.enterpriseId,titleCode:target.titleCode,
      matches:sql<number>`${sourceMatches}`,relationEnterpriseId:assignment.enterpriseId,relationStatus:assignment.verificationStatus,
      relationUscc:sql<string|null>`${value('$.relation.usccRaw')}`,ownerId:owner.id,ownerUscc:owner.usccNorm,targetId:s.enterprise.id,targetUscc:s.enterprise.usccNorm,targetTitle:s.title.code,
    }).from(target).leftJoin(assignment,and(eq(assignment.observationId,target.observationId),eq(assignment.revision,sql`(select max(revision) from platform_observation_assignment where observation_id=${target.observationId})`)))
      .leftJoin(owner,eq(owner.id,assignment.enterpriseId)).leftJoin(s.enterprise,eq(s.enterprise.id,target.enterpriseId)).leftJoin(s.title,eq(s.title.code,target.titleCode))
      .where(sql`${target.id} in (select value from json_each(${sql.placeholder('ids')}))`).prepare()
    return (ids: number[]) => {
      if (!ids.length) return new Map<number, boolean>()
      const rows=prepared.all({ids:JSON.stringify(ids)})
      const proofs=rows.filter(row=>row.type==='recognized_export'&&row.role==='same_current_row').map(row=>row.id)
      const proofValidity=new Map(proofs.length?listRecordCorrespondencesForIds(db,proofs).map(row=>[row.id,row.requiresRevalidation]):[])
      const validity = new Map(rows.map(row => {
        let invalid=!row.matches
        if(row.relationEnterpriseId&&row.relationUscc&&(!row.ownerId||row.ownerUscc&&normalizeUscc(row.ownerUscc)!==normalizeUscc(row.relationUscc)))invalid=true
        if(row.type==='later_process') {
          if(!row.targetId||!row.targetTitle||correspondenceIdentityProblem({enterpriseId:row.enterpriseId,uscc:row.targetUscc},{enterpriseId:row.relationEnterpriseId,uscc:row.relationUscc},true))invalid=true
          if(!normalizeUscc(row.relationUscc)&&row.relationStatus!=='confirmed')invalid=true
        }
        return [row.id,invalid||(proofValidity.get(row.id)??false)] as const
      }))
      // The old reverse-link SQL compares saved JSON with the native status cell.
      // A saved Buffer object never IS a SQLite BLOB, unlike the full fingerprint.
      for (const row of blobStatuses.all({ ids: JSON.stringify(ids) })) validity.set(row.id, true)
      return validity
    }

}
