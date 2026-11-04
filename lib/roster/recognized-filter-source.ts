import type Database from 'better-sqlite3'

/** Explicit read-path switch. `legacy` keeps the pre-#468 reader byte-for-byte;
 * `typed` prefers the recognized_list typed projection and falls back only when no
 * projection row exists. */
export type RecognizedFactSource = 'typed' | 'legacy'

/** Operational rollback without a code change. Any other/absent value keeps typed. */
export const RECOGNIZED_FACT_SOURCE_ENV = 'ROSTER_RECOGNIZED_FILTER_SOURCE'

export function resolveRecognizedFactSource(explicit?: RecognizedFactSource): RecognizedFactSource {
  if (explicit) return explicit
  return process.env[RECOGNIZED_FACT_SOURCE_ENV] === 'legacy' ? 'legacy' : 'typed'
}

/** Query-level facts (pages, submitted conditions, completeness) remain
 * platform_query.collection_evidence. The typed projection does not own them. */
const QUERY_COLUMNS = `q.id as queryId,q.title_code as titleCode,q.rdjb,r.sequence_no as sequenceNo,
      json_extract(q.collection_evidence,'$.pages') as pages,
      json_extract(q.collection_evidence,'$.effectiveConditions.rddqrq') as conditionValidYear,
      json_extract(q.collection_evidence,'$.effectiveConditions.whpcyear') as conditionMaintenanceYear,
      json_extract(q.collection_evidence,'$.effectiveConditions.whpc') as conditionMaintenanceBatch`

const LEGACY_CONTENT = `json_extract(r.raw_fields,'$.rddqrq') as rawValid,
      json_extract(r.raw_fields,'$.whpcyear') as rawMaintenanceYear,
      json_extract(r.raw_fields,'$.whpc') as rawMaintenanceBatch`

/** Explicit CASE, not COALESCE: an existing projection with a null field is the source
 * answer (unknown), and must not silently fall back to the original raw value. */
const TYPED_CONTENT = `case when p.version_id is not null then p.validity_date_raw else json_extract(r.raw_fields,'$.rddqrq') end as rawValid,
      case when p.version_id is not null then p.maintenance_year else json_extract(r.raw_fields,'$.whpcyear') end as rawMaintenanceYear,
      case when p.version_id is not null then p.maintenance_batch else json_extract(r.raw_fields,'$.whpc') end as rawMaintenanceBatch`

const FILTER = `where r.id=@relationId and (r.enterprise_id=@enterpriseId or (r.enterprise_id is null and @uscc is not null and roster84_uscc(r.uscc_raw)=@uscc)) and r.verification_status='confirmed'
      and q.interface='recognized_list' and q.status='success'
      and json_extract(q.collection_evidence,'$.status')='success'
      and json_extract(q.collection_evidence,'$.source')='queryBusList'
      and json_extract(q.collection_evidence,'$.effectiveConditions.combination')='and'
      and json_extract(q.collection_evidence,'$.completeness')='complete'
      and json_extract(q.collection_evidence,'$.fullRange')=1`

/** The legacy statement is the exact pre-switch text (no added joins). */
export function recognizedFilterSourceSql(source: RecognizedFactSource): string {
  if (source === 'legacy') return `select ${QUERY_COLUMNS},
      ${LEGACY_CONTENT}
      from platform_relation r join platform_query q on q.id=r.query_id
      ${FILTER}`
  return `select ${QUERY_COLUMNS},
      ${TYPED_CONTENT}
      from platform_relation r join platform_query q on q.id=r.query_id
      left join platform_business_observation o on o.relation_id=r.id
      left join platform_recognized_projection p on p.version_id=o.version_id
      ${FILTER}`
}

export interface RecognizedFilterSourceRow {
  queryId: number
  titleCode: string | null
  rdjb: string
  sequenceNo: number
  pages: string | null
  conditionValidYear: unknown
  conditionMaintenanceYear: unknown
  conditionMaintenanceBatch: unknown
  rawValid: unknown
  rawMaintenanceYear: unknown
  rawMaintenanceBatch: unknown
}

export interface RecognizedFilterSourceParams {
  relationId: number
  enterpriseId: number
  uscc: string | null
}

/** Request-scoped, statement-cached reader; no rows or facts survive the call. */
export function createRecognizedFilterSourceReader(db: Database.Database, explicit?: RecognizedFactSource) {
  const source = resolveRecognizedFactSource(explicit)
  const statement = db.prepare(recognizedFilterSourceSql(source))
  return {
    source,
    read(params: RecognizedFilterSourceParams) {
      return statement.get(params) as RecognizedFilterSourceRow | undefined
    },
  }
}
