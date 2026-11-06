import { sql, type SQL } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type * as schema from '../../db/schema'
import { platformFilterOptionsQueryFromQuery, type PlatformFilterOptions } from '../../lib/platform/filter-options'

type Db = BetterSQLite3Database<typeof schema>
type OptionKey = keyof PlatformFilterOptions

/** Candidate columns only: no raw JSON, page limit, or inferred business facts. */
export function readPlatformFilterOptions(input: unknown, db: Db): PlatformFilterOptions {
  const { source, view } = platformFilterOptionsQueryFromQuery(input)
  const result: PlatformFilterOptions = { titles: [], declareKinds: [], years: [], statuses: [], batches: [], districts: [], validityDates: [] }

  const definition = {
    declarations: { interface: 'apply_list', table: 'platform_apply_projection', columns: { titles: 'title_raw', declareKinds: 'declare_kind', years: 'declaration_year', statuses: 'status' } },
    'business-processes': { interface: 'business_list', table: 'platform_business_projection', columns: { titles: 'title_raw', declareKinds: 'declare_kind', years: 'business_year', statuses: 'status', batches: 'batch' } },
    'recognized-directory': { interface: 'recognized_list', table: 'platform_recognized_projection', columns: { titles: 'title_raw', batches: 'maintenance_batch', districts: 'district', validityDates: 'validity_date_raw' } },
  }[source]

  const from: SQL = view === 'records'
    ? sql`from ${sql.identifier(definition.table)} p
        join platform_business_record_version v on v.id = p.version_id
        join platform_business_record b on b.id = v.record_id
        where b.interface = ${definition.interface}`
    : sql`from platform_business_observation o
        join platform_relation r on r.id = o.relation_id
        join platform_query q on q.id = r.query_id
        where q.interface = ${definition.interface}
          and (o.identity_state <> 'resolved' or o.content_state <> 'verified' or o.version_id is null)`

  for (const [key, name] of Object.entries(definition.columns) as [OptionKey, string][]) {
    if (source === 'recognized-directory' && view === 'isolated' && key !== 'titles') continue
    const column = sql`${sql.identifier(view === 'records' ? 'p' : 'r')}.${sql.identifier(view === 'isolated' && key === 'years' ? 'year' : name)}`
    if (key === 'years') {
      result.years = db.all<{ value: number }>(sql`select distinct ${column} as value ${from}
        and ${column} is not null order by ${column} desc`).map(row => row.value)
        .filter(value => Number.isSafeInteger(value) && value > 0)
    } else {
      result[key] = db.all<{ value: string }>(sql`select distinct ${column} as value ${from}
        and ${column} is not null and trim(${column}) <> '' order by ${column} collate binary`).map(row => row.value)
    }
  }
  return result
}
