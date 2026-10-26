/** SQL-only page metadata projection. Original rows and response bodies never cross the driver. */
import { TITLE_RDJB_CODES, RDJB_TITLE_CODES } from '../platform/recognized-evidence'
export { TITLE_RDJB_CODES }
const titleCase = (value: string) => `case ${value} ${Object.entries(RDJB_TITLE_CODES).map(([rdjb,title]) => `when '${rdjb}' then '${title}'`).join(' ')} end`
// q and r are fixed aliases in the bounded candidate/reference queries below.
export const relationTitleSql = `case when instr(q.rdjb,',')=0 then coalesce(q.title_code,${titleCase('q.rdjb')}) else coalesce((select ${titleCase("json_extract(p.value,'$.rdjb')")}
  from json_each(case when json_valid(q.collection_evidence) then json_extract(q.collection_evidence,'$.pages') else '[]' end) p
  where json_extract(p.value,'$.status')='success' and json_extract(p.value,'$.fetchedCount')>0
    and r.sequence_no > coalesce((select sum(json_extract(prev.value,'$.fetchedCount')) from json_each(case when json_valid(q.collection_evidence) then json_extract(q.collection_evidence,'$.pages') else '[]' end) prev where cast(prev.key as integer)<cast(p.key as integer) and json_extract(prev.value,'$.status')='success'),0)
    and r.sequence_no <= (select sum(json_extract(prev.value,'$.fetchedCount')) from json_each(case when json_valid(q.collection_evidence) then json_extract(q.collection_evidence,'$.pages') else '[]' end) prev where cast(prev.key as integer)<=cast(p.key as integer) and json_extract(prev.value,'$.status')='success')
  order by cast(p.key as integer) limit 1),q.title_code) end`
export const relationScopeSql = `(${relationTitleSql}=@title or (${relationTitleSql} is null and instr(','||q.rdjb||',',','||@rdjb||',')>0))`

/** Candidate-only, request-local projections; candidate_relations supplies joined coordinates.
 * Integer array pages have unique ordered keys and exact sums. Keep every other
 * historical shape/type on relationTitleSql, including its SQLite coercion/errors.
 * Both array length and counts are bounded here so their product fits int64;
 * this chooses an optimization, never rejects or drops historical input.
 */
export const candidatePageScopeCtes = `candidate_queries as materialized (
  select q.id,q.title_code,q.rdjb,q.collection_evidence,
    case when instr(q.rdjb,',')>0 and json_valid(q.collection_evidence) then
      case when json_type(q.collection_evidence,'$.pages')='array'
        and json_array_length(q.collection_evidence,'$.pages')<=2147483647 then
        not exists (select 1 from json_each(json_extract(q.collection_evidence,'$.pages')) p
          where case when p.type<>'object' then 1
            when json_extract(p.value,'$.status')='success' then
              case when json_type(p.value,'$.fetchedCount')='integer'
                and json_extract(p.value,'$.fetchedCount') between 0 and 2147483647 then 0 else 1 end
            else 0 end)
      else 0 end else 0 end as ranged
  from platform_query q where q.id in (select query_id from candidate_relations)
), candidate_page_counts as materialized (
  select q.id as query_id,cast(p.key as integer) as page_key,
    ${titleCase("json_extract(p.value,'$.rdjb')")} as page_title,
    json_extract(p.value,'$.fetchedCount') as fetched_count
  from candidate_queries q,
    json_each(case when q.ranged then json_extract(q.collection_evidence,'$.pages') else '[]' end) p
  where json_extract(p.value,'$.status')='success'
), candidate_page_ranges as materialized (
  select query_id,page_key,page_title,fetched_count,
    coalesce(sum(fetched_count) over (partition by query_id order by page_key rows between unbounded preceding and 1 preceding),0) as previous_count,
    sum(fetched_count) over (partition by query_id order by page_key rows between unbounded preceding and current row) as through_count
  from candidate_page_counts
)`

// q/r retain their original meanings. An unmapped first covering page returns
// NULL before coalesce, exactly like the legacy scalar subquery (no skipping).
export const candidateRelationTitleSql = `case when q.ranged then coalesce((
  select p.page_title from candidate_page_ranges p
  where p.query_id=q.id and p.fetched_count>0
    and r.sequence_no>p.previous_count and r.sequence_no<=p.through_count
  order by p.page_key limit 1),q.title_code) else ${relationTitleSql} end`
