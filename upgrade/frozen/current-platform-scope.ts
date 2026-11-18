/** Fixed legacy scope oracle from ab503081; offline fixture use only. */
/** SQL-only page metadata projection. Original rows and response bodies never cross the driver. */
import { TITLE_RDJB_CODES, RDJB_TITLE_CODES } from '../../layers/sme-roster/lib/platform/recognized-evidence'
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
