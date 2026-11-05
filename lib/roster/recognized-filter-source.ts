import type Database from 'better-sqlite3'

/** Explicit read-path switch. `legacy` keeps the pre-#468 reader byte-for-byte;
 * `typed` requires captured recognized source-fidelity fields; unavailable
 * history stays unknown until explicit source-owned completion. */
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

/** The exact untrimmed strings feed the unchanged grammar. The boolean only
 * answers the grammar's absence test: false must remain nonmissing, even if the
 * directory's normalized maintenance year is null. No original raw reads here. */
const TYPED_CONTENT = `p.source_validity_date as rawValid,
      case when p.source_maintenance_year_absent=1 then null else 0 end as rawMaintenanceYear,
      p.source_maintenance_batch as rawMaintenanceBatch`

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
      join platform_business_observation o on o.relation_id=r.id and o.identity_state='resolved' and o.content_state='verified'
      join platform_business_record b on b.id=o.record_id and b.interface='recognized_list'
      join platform_recognized_projection p on p.version_id=o.version_id and p.record_id=b.id
      ${FILTER} and p.source_maintenance_year_absent is not null`
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
