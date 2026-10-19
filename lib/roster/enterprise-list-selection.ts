/** SQL selection coordinates for the enterprise list, never a query-result cache.
 * Full lifecycle/evidence projections still use enterprise-roster's business rules.
 * The only JS-wide operation is the original localeCompare stable sort. */
import { sql, inArray, and, type SQL } from 'drizzle-orm'
import { SQLiteSyncDialect } from 'drizzle-orm/sqlite-core'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { Database } from 'better-sqlite3'
import * as schema from '../../db/schema'
import { normalizeName } from '../domain'
import { TITLE_ORDER, DIFFERENCE_STATUS_ORDER } from '../labels'
import { identityFunctions, identityNameSql, identityUsccSql } from './enterprise-read-snapshot'
import type { RosterEnterpriseFilter, RosterEnterpriseDifference, RosterState, RosterCounts } from './enterprise-roster'

type Db = BetterSQLite3Database<typeof schema>
const rank = (column: SQL, values: string[]) => sql`case ${sql.join(values.map((value, i) => sql`when ${column} = ${value} then ${i}`), sql` `)} else ${values.length} end`
const selected = (column: SQL, values?: (string | number)[]) => values?.length ? inArray(column, values) : sql`1`
const membershipCtes = () => sql`
  uscc_owners as materialized (
    select ${identityUsccSql(sql`uscc_norm`)} as key,max(id) as id from enterprise group by ${identityUsccSql(sql`uscc_norm`)}
  ), name_owners as materialized (select name_norm as key,max(id) as id from enterprise group by name_norm), latest as (
    select id from (select id,row_number() over(partition by title_code order by year desc,id desc) as n from platform_export_batch) where n=1
  ), membership as (
    select cast(coalesce(u.id,n.id) as integer) as id,max(x.batch_id in (select id from latest)) as current
    from platform_export_row x left join uscc_owners u on u.key=${identityUsccSql(sql`x.uscc_raw`)}
    left join name_owners n on n.key=${identityNameSql(sql`x.name_raw`)} and x.name_raw is not null and x.name_raw!=''
    group by coalesce(u.id,n.id)
  )`

/** Only platform-only selected enterprises need export membership when the
 * request does not filter by rosterState. No per-enterprise queries. */
export function removedEnterpriseIds(db: Db, ids: number[]): Set<number> {
  if (!ids.length) return new Set()
  identityFunctions(db)
  return new Set(db.all<{ id: number }>(sql`with ${membershipCtes()} select id from membership where not current and ${inArray(sql`id`, ids)}`).map(row => row.id))
}

export interface EnterpriseSelection {
  id: number
  name: string
  year: number | null
  rank: number
  state: RosterState
  difference: RosterEnterpriseDifference
}

export function selectEnterpriseCoordinates(db: Db, filter: RosterEnterpriseFilter, limit?: number) {
  identityFunctions(db)
  const needle = filter.q?.trim() ? normalizeName(filter.q) : null
  const usccNeedle = filter.q?.trim() ? filter.q.trim().toUpperCase() : null
  // Exact district equality cannot match a lone surrogate in stored UTF-8;
  // substring search can match one UTF-16 half of a supplementary character.
  const validText = (filter.district ?? '').isWellFormed()
  const includes = (value: SQL, text: string | null) => (text ?? '').isWellFormed()
    ? sql`instr(${value},${text})>0`
    : sql`roster84_includes_utf16(${value},${JSON.stringify(text)})`
  const search = needle != null || usccNeedle != null ? sql`(${includes(identityNameSql(sql`e.name`), needle)} or
    exists(select 1 from enterprise_alias a where a.enterprise_id=e.id and a.verification_status='confirmed' and ${includes(identityNameSql(sql`a.name`), needle)}) or
    ${includes(sql`case when instr(e.uscc_norm,char(0))>0 or e.uscc_norm glob '*[^ -~]*' then roster84_upper(e.uscc_norm) else upper(coalesce(e.uscc_norm,'')) end`, usccNeedle)})` : sql`1`
  const recognitionMatch = and(selected(sql`f.title_code`, filter.title), selected(sql`f.first_year`, filter.firstYear), selected(sql`f.status`, filter.firstStatus))!
  const recordMatch = and(selected(sql`r.source`, filter.source), filter.eventType?.length || filter.year?.length
    ? sql`exists(select 1 from record_event v where v.record_id=r.id and ${selected(sql`v.event_type`, filter.eventType)} and ${selected(sql`v.year`, filter.year)})` : sql`1`)!
  const defaultDifferenceCount = sql`case when title_code in ('little_giant','specialized_sme','innovative_sme') then
    (official and (uscc_norm is null or not platform)) + (platform and (uscc_norm is null or not official)) else 0 end`
  const diffFilter = filter.diffStatus?.length ? sql`(
    ${filter.diffStatus.includes('none') ? sql`coalesce(d.count,0)=0` : sql`0`} or
    ${inArray(sql`d.status`, filter.diffStatus.filter(x => x !== 'none'))} or
    exists(select 1 from coordinates c where c.enterprise_id=e.id and ${selected(sql`c.status`, filter.diffStatus.filter(x => x !== 'none'))} and c.status != 'none'
      ${filter.diffStatus.every(x => x === 'none') ? sql`and 0` : sql``}) or ${inArray(sql`d.reason`, filter.diffStatus.filter(x => x !== 'none'))})` : sql`1`
  const query = sql`
    with scope as materialized (
      select e.id from enterprise e where ${validText ? search : sql`0`}
        and ${filter.district ? sql`coalesce(nullif(e.district,''),(select district from record r where r.enterprise_id=e.id and r.district is not null and r.district!='' order by r.id limit 1))=${filter.district}` : sql`1`}
    ), fact_base as materialized (
      select r.enterprise_id,r.title_code,e.uscc_norm,
        min(case when v.event_type='award' then coalesce(v.decided_year,v.year) end) as first_year,
        sum(v.event_type='award') as awards,
        max(v.event_type='award' and coalesce(v.decided_year,v.year) is null) as undated,
        max(r.source='jxj') as official,max(r.source!='jxj') as platform,
        max(case when ${recordMatch} then 1 else 0 end) as record_match
      from record r join scope o on o.id=r.enterprise_id join enterprise e on e.id=r.enterprise_id
        left join record_event v on v.record_id=r.id group by r.enterprise_id,r.title_code
    ), facts as (
      select f.*,case when f.first_year is null or f.undated or not exists (
        select 1 from record_evidence ev where ev.record_event_id=(
          select v.id from record r join record_event v on v.record_id=r.id
          where r.enterprise_id=f.enterprise_id and r.title_code=f.title_code and v.event_type='award'
            and coalesce(v.decided_year,v.year)=f.first_year order by v.id limit 1)) then 'pending' else 'confirmed' end as status
      from fact_base f
    ), history as (
      select f.enterprise_id,json_group_array(f.title_code) as titles,min(f.first_year) as first_year,
        min(${rank(sql`f.title_code`, TITLE_ORDER)}) as title_rank,max(f.official) as official,max(f.record_match) as record_match,
        sum(case when f.awards>0 and ${recognitionMatch} then 1 else 0 end) as recognition_pairs,
        max(case when ${selected(sql`f.title_code`, filter.title)} then 1 else 0 end) as title_match
      from facts f group by f.enterprise_id
    ), derived as materialized (
      -- uscc_norm is UNIQUE in the existing schema; non-null exact keys can
      -- only refer to this enterprise. Null keys deliberately never match.
      select enterprise_id,title_code,'missing_in_miit' as direction from fact_base
        where title_code in ('little_giant','specialized_sme','innovative_sme') and official and (uscc_norm is null or not platform)
          and enterprise_id in (select enterprise_id from explanations)
      union all select enterprise_id,title_code,'extra_in_miit' from fact_base
        where title_code in ('little_giant','specialized_sme','innovative_sme') and platform and (uscc_norm is null or not official)
          and enterprise_id in (select enterprise_id from explanations)
    ), explanation_versions as (
      select enterprise_id,title_code,direction,status,reason_code,row_number() over(partition by enterprise_id,title_code,direction order by recorded_at desc,id) as n
      from difference_reason where enterprise_id in (select id from scope)
    ), explanations as materialized (select * from explanation_versions where n=1), coordinates as materialized (
      select d.*,coalesce(x.status,'not_queried') as status,x.reason_code,1 as current from derived d left join explanations x
        on x.enterprise_id=d.enterprise_id and x.title_code=d.title_code and x.direction=d.direction
      union all select x.enterprise_id,x.title_code,x.direction,x.status,x.reason_code,0 from explanations x where not exists(
        select 1 from derived d where d.enterprise_id=x.enterprise_id and d.title_code=x.title_code and d.direction=x.direction)
    ), ranked_differences as (
      select *,row_number() over(partition by enterprise_id order by ${rank(sql`status`, DIFFERENCE_STATUS_ORDER)} desc,${rank(sql`title_code`, TITLE_ORDER)},direction) as n from coordinates
    ), explained_differences as (
      select enterprise_id,count(*) as count,max(current) as current,max(case when n=1 then status end) as status,
        max(case when n=1 then reason_code end) as reason from ranked_differences group by enterprise_id
    ), differences as (
      -- No explanation means every derived coordinate has the same default
      -- not_queried status/null reason. Count them without a coordinate window.
      select enterprise_id,sum(${defaultDifferenceCount}) as count,sum(${defaultDifferenceCount})>0 as current,
        case when sum(${defaultDifferenceCount})>0 then 'not_queried' end as status,null as reason
      from fact_base where enterprise_id not in (select enterprise_id from explanations) group by enterprise_id
      union all select * from explained_differences
    ), ${membershipCtes()}, candidates as (
      select e.id,e.name,h.titles,h.first_year,h.title_rank,h.recognition_pairs,
        ${filter.rosterState ? sql`case when h.official=0 and m.id is not null and not m.current then 'removed_platform_only' else 'current' end` : sql`'current'`} as state,
        coalesce(d.count,0) as difference_count,d.status,d.reason,coalesce(d.current,0) as difference_current
      from scope o join enterprise e on e.id=o.id left join history h on h.enterprise_id=e.id left join differences d on d.enterprise_id=e.id
        ${filter.rosterState ? sql`left join membership m on m.id=+e.id` : sql``}
      where ${filter.title?.length ? sql`h.title_match=1` : sql`1`}
        and ${filter.firstYear?.length || filter.firstStatus?.length ? sql`h.recognition_pairs>0` : sql`1`}
        and ${filter.source?.length || filter.eventType?.length || filter.year?.length ? sql`h.record_match=1` : sql`1`}
        and ${diffFilter}
    ) select * from candidates where ${filter.rosterState ? sql`state=${filter.rosterState}` : sql`1`}`
  // Drizzle builds/binds SQL; a raw cursor avoids per-column ORM mapping and
  // keeps transient rows out of a second full array.
  const bound = new SQLiteSyncDialect().sqlToQuery(query)
  const rows = (db as Db & { $client: Database }).$client.prepare(bound.sql).raw().iterate(...bound.params) as Iterable<[number,string,string|null,number|null,number|null,number|null,RosterState,number,string|null,string|null,number]>
  const counts: RosterCounts = { total: 0, titlePairs: 0, recognitionPairs: 0, differences: 0, titles: Object.fromEntries(TITLE_ORDER.map(code => [code, 0])) }
  const candidates: EnterpriseSelection[] = []
  const sort = filter.sort ?? 'recognition'
  const compare = (a: EnterpriseSelection, b: EnterpriseSelection) => {
    if (sort === 'title' && a.rank !== b.rank) return a.rank-b.rank
    if (sort !== 'name' && sort !== 'title' && a.year !== b.year) return a.year == null ? 1 : b.year == null ? -1 : b.year-a.year
    return a.name.localeCompare(b.name) || a.id-b.id
  }
  for (const [id,name,titles,year,titleRank,recognitions,state,count,status,reasonCode,current] of rows) {
    counts.total++; counts.recognitionPairs += recognitions ?? 0; counts.differences += count
    for (const title of titles == null ? [] : JSON.parse(titles) as string[]) { counts.titlePairs++; counts.titles[title] = (counts.titles[title] ?? 0) + 1 }
    const candidate = { id,name,year,rank: titleRank ?? TITLE_ORDER.length,state,difference: { count,status,reasonCode,anyCurrent: !!current } }
    if (limit == null) candidates.push(candidate)
    else if (candidates.length < limit || compare(candidate,candidates[candidates.length-1]!) < 0) {
      // Exact bounded top-(page*size), using the original JS locale ordering.
      // Counts include every row; off-page lifecycle/sort rows are not retained.
      let lo=0, hi=candidates.length
      while (lo<hi) { const mid=(lo+hi)>>>1; if (compare(candidate,candidates[mid]!)<0) hi=mid; else lo=mid+1 }
      candidates.splice(lo,0,candidate)
      if (candidates.length>limit) candidates.pop()
    }
  }
  if (limit == null) candidates.sort(compare)
  return { candidates, counts }
}
