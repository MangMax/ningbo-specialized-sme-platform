import { candidatePageScopeCtes, candidateRelationTitleSql, TITLE_RDJB_CODES } from './current-platform-scope'
import type { CurrentTitle } from './current-qualification'

/** Same complete candidate set for the current workbook and qualified list.
 * Unowned relations must still evaluate titles before exclusion, preserving legacy errors.
 */
export const currentCandidateSql = `with owners as materialized (select id,roster84_uscc(uscc_norm) as uscc from enterprise where uscc_norm is not null),
  candidate_relations as materialized (
    select r.query_id,r.sequence_no,coalesce(r.enterprise_id,e.id) as owner_id
    from platform_relation r join platform_query q on q.id=r.query_id
    left join owners e on r.enterprise_id is null and e.uscc=roster84_uscc(r.uscc_raw)
  ), ${candidatePageScopeCtes},
  candidate_titles as materialized (
    select r.owner_id,q.rdjb,${candidateRelationTitleSql} as title_code
    from candidate_relations r join candidate_queries q on q.id=r.query_id
  )
  select enterprise_id as id from record where title_code=@title
  union select enterprise_id as id from difference_reason where title_code=@title
  union select enterprise_id as id from record_correspondence where title_code=@title and enterprise_id is not null
  union select owner_id as id from candidate_titles
    where owner_id is not null and (title_code=@title or (title_code is null and instr(','||rdjb||',',','||@rdjb||',')>0))`

export function currentCandidateBindings(title: CurrentTitle) {
  return { title, rdjb: TITLE_RDJB_CODES[title] }
}
