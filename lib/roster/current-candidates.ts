import { relationScopeSql, TITLE_RDJB_CODES } from './current-platform-scope'
import type { CurrentTitle } from './current-qualification'

/** Same complete candidate set for the current workbook and qualified list. */
export const currentCandidateSql = `with owners as materialized (select id,roster84_uscc(uscc_norm) as uscc from enterprise where uscc_norm is not null)
  select enterprise_id as id from record where title_code=@title
  union select enterprise_id as id from difference_reason where title_code=@title
  union select enterprise_id as id from record_correspondence where title_code=@title and enterprise_id is not null
  union select coalesce(r.enterprise_id,e.id) as id from platform_relation r join platform_query q on q.id=r.query_id
    left join owners e on r.enterprise_id is null and e.uscc=roster84_uscc(r.uscc_raw)
    where coalesce(r.enterprise_id,e.id) is not null and ${relationScopeSql}`

export function currentCandidateBindings(title: CurrentTitle) {
  return { title, rdjb: TITLE_RDJB_CODES[title] }
}
