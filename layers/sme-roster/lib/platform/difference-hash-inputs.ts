/** Original inputs to the existing #113/refresh hashes. Evidence-only owner:
 * callers must use structured sources for identity, filtering, scope and paging. */
import { and, eq, inArray, sql, type SQL } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as s from '../../../../db/schema'
import { targetSchema } from './target-schema'
import { currentDifferenceAssignment } from './difference-sources'

type Db = BetterSQLite3Database<typeof s>
const o = targetSchema.platformBusinessObservation, r = targetSchema.platformObservationArchiveRef
const a = targetSchema.platformObservationAssignment, ra = targetSchema.platformLegacyRelationAlias, v = s.platformArchiveValue
/** Decode the sealed original SQLite cell, retaining NULL/string/number types.
 * JSON is read only here to reproduce the old hash envelope, never a business predicate. */
function cell(name: string): SQL {
  const bytes = sql`unhex(json_extract(cell.value,'$.hex'))`
  return sql`(select case json_extract(cell.value,'$.storageClass')
    when 'null' then null when 'text' then cast(${bytes} as text)
    when 'integer' then cast(${bytes} as integer) when 'real' then cast(${bytes} as real)
    when 'blob' then ${bytes} end
    from json_each(cast(${v.bytes} as text),'$.fields') cell where json_extract(cell.value,'$.name')=${name})`
}
export function readDifferenceRevisionMaterials(db: Db, observationIds: number[]) {
  if (!observationIds.length) return new Map<number, unknown[]>()
  const raw = cell('raw_fields')
  const material = sql<string>`json_array(${cell('relation_key')},${cell('uscc_raw')},${cell('name_raw')},${cell('alias_name_raw')},
    ${cell('province')},${cell('status')},${cell('batch')},${cell('declare_kind')},${cell('applied_at')},${cell('award_batch_label')},${cell('year')},${a.verificationStatus},
    json_extract(${raw},'$.rddqrq'),json_extract(${raw},'$.whpcyear'),json_extract(${raw},'$.whpc'),json_extract(${raw},'$.szq'))`
  const rows = db.select({ id: o.id, material }).from(o).innerJoin(r, and(eq(r.ownerId, o.id), eq(r.field, 'legacyRowSnapshot')))
    .innerJoin(v, eq(v.id, r.archiveId)).innerJoin(a, currentDifferenceAssignment(db)).where(inArray(o.id, observationIds)).all()
  if (rows.length !== observationIds.length) throw new Error('Difference original hash input missing')
  return new Map(rows.map(row => [row.id, JSON.parse(row.material) as unknown[]]))
}
export const refreshRelationFields = ['relation_key','uscc_raw','name_raw','alias_name_raw','province','status','batch','declare_kind','applied_at','award_batch_label','year'] as const
export const refreshSourceKeys = ['id','rdjb','rddqrq','whpcyear','whpc','cszt','year','sqsj','sblx','personuuid','szsfmc','szq','rdxx','qymc','tyshxydm'] as const
export const refreshMetadataKeys = ['source','status','effectiveConditions','titleScope','completeness','fullRange','pages'] as const

export function readDifferenceRefreshRows(db: Db, collectionId: number) {
  const raw = cell('raw_fields')
  const args = refreshRelationFields.flatMap(name => [sql`${name}`, cell(name)])
  const base = sql`json_object(${sql.join(args, sql`,`)},'match_basis',${a.matchBasis},'verification_status',${a.verificationStatus})`
  const business = sql`(select json_group_object(key,json(${raw} -> fullkey)) from json_each(${raw})
    where key in (${sql.join(refreshSourceKeys.map(k => sql`${k}`),sql`,`)}))`
  const material = sql<string>`case when ${raw} is null then ${base}
    when not json_valid(${raw}) or json_type(${raw})='null' then json_set(${base},'$.sourceBusinessMalformed',json('true'))
    else json_set(${base},'$.sourceBusiness',json(${business})) end`
  return db.select({ id: ra.oldId, material }).from(o).innerJoin(ra, eq(ra.observationId, o.id))
    .innerJoin(r, and(eq(r.ownerId, o.id), eq(r.field, 'legacyRowSnapshot'))).innerJoin(v, eq(v.id, r.archiveId))
    .innerJoin(a, currentDifferenceAssignment(db)).where(eq(o.collectionId, collectionId)).orderBy(ra.oldId).all()
    .map(row => JSON.parse(row.material) as Record<string, unknown>)
}
/** Same old metadata hash input, including malformed/absent distinctions. */
export function readDifferenceRefreshMetadata(db: Db, collectionId: number) {
  const r = s.platformCollectionArchiveRef
  const raw = sql`cast(${v.bytes} as text)`
  // Preserve JSON scalar types in the old hash input while excluding rows and
  // transport bodies before they cross the driver.
  const args = refreshMetadataKeys.flatMap(key => [sql`${key}`,sql`${raw} -> ${'$.'+key}`])
  return db.select({ text: sql<string | null>`case when ${v.storageClass}='null' then null
    when not json_valid(${raw}) then '{' when json_type(${raw})='null' then 'null'
    else json_object(${sql.join(args,sql`,`)}) end` }).from(r).innerJoin(v, eq(v.id, r.archiveId))
    .where(and(eq(r.ownerId, collectionId), eq(r.field, 'collectionEvidence'))).get()?.text ?? null
}
/** Key order belongs only to the historical serialized #113 envelope.
 * Condition values and relevance still come from platform_collection_condition. */
export function orderDifferenceEnvelopeConditions(db: Db, collectionId: number, conditions: Record<string, unknown>) {
  const r = s.platformCollectionArchiveRef
  const row = db.select({ keys: sql<string>`(select json_group_array(key) from json_each(cast(${v.bytes} as text),'$.effectiveConditions'))` })
    .from(r).innerJoin(v, eq(v.id, r.archiveId)).where(and(eq(r.ownerId, collectionId), eq(r.field, 'collectionEvidence'))).get()
  const keys: string[] = row ? JSON.parse(row.keys) : []
  return Object.fromEntries([...new Set([...keys,...Object.keys(conditions)])].filter(key => Object.hasOwn(conditions,key)).map(key => [key,conditions[key]]))
}
