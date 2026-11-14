/** Original offline candidate oracle API from ab503081; never imported by runtime. */
import type Database from 'better-sqlite3'
import { relationScopeSql, TITLE_RDJB_CODES } from './current-platform-scope'
import type { CurrentTitle } from '../../lib/roster/current-titles'
import { resolveRecognizedFactSource, type RecognizedFactSource } from './recognized-filter-source'

/** Same complete candidate set for the current workbook and qualified list. */
export const currentCandidateSql = `with owners as materialized (select id,roster84_uscc(uscc_norm) as uscc from enterprise where uscc_norm is not null)
  select enterprise_id as id from record where title_code=@title
  union select enterprise_id as id from difference_reason where title_code=@title
  union select enterprise_id as id from record_correspondence where title_code=@title and enterprise_id is not null
  union select coalesce(r.enterprise_id,e.id) as id from platform_relation r join platform_query q on q.id=r.query_id
    left join owners e on r.enterprise_id is null and e.uscc=roster84_uscc(r.uscc_raw)
    where coalesce(r.enterprise_id,e.id) is not null and ${relationScopeSql}`

const coveringIndexes = [
  { table: 'platform_relation', name: 'platform_relation_current_candidate_cover_idx', columns: ['query_id', 'sequence_no', 'enterprise_id', 'uscc_raw'] },
  { table: 'platform_query', name: 'platform_query_current_candidate_cover_idx', columns: ['id', 'rdjb', 'title_code', 'collection_evidence'] },
] as const
const coveringCandidateSql = currentCandidateSql
  .replace('platform_relation r join', 'platform_relation r INDEXED BY platform_relation_current_candidate_cover_idx join')
  .replace('platform_query q on', 'platform_query q INDEXED BY platform_query_current_candidate_cover_idx on')

/** Recheck this connection on each request, including old readonly databases. */
export function currentCandidateSqlFor(db: Database.Database): string {
  const covered = coveringIndexes.every(index => {
    const indexes = db.pragma(`index_list('${index.table}')`) as { name: string; partial: number }[]
    if (!indexes.some(row => row.name === index.name && row.partial === 0)) return false
    const columns = db.pragma(`index_info('${index.name}')`) as { name: string | null }[]
    return columns.length === index.columns.length && columns.every((column, position) => column.name === index.columns[position])
  })
  return covered ? coveringCandidateSql : currentCandidateSql
}

export function currentCandidateBindings(title: CurrentTitle) {
  return { title, rdjb: TITLE_RDJB_CODES[title] }
}

/** Candidate ownership and title scope remain archive facts. A verified recognized
 * observation supplies the source identity only when it agrees with the archived
 * identity. Missing/null/conflicting history stays on the compatibility branch;
 * it must neither disappear nor acquire a new enterprise from a source mismatch.
 * In particular, row-level title_raw never replaces archived query/page scope.
 */
const typedCandidateSql = `with owners as materialized (select id,roster84_uscc(uscc_norm) as uscc from enterprise where uscc_norm is not null),
  recognized_identities as materialized (
    select o.relation_id,p.uscc_raw from platform_business_observation o
      join platform_business_record b on b.id=o.record_id and b.interface='recognized_list'
      join platform_recognized_projection p on p.version_id=o.version_id and p.record_id=b.id
      join platform_relation r on r.id=o.relation_id
      join platform_query q on q.id=r.query_id and q.interface='recognized_list'
      where o.identity_state='resolved' and o.content_state='verified'
        and p.uscc_raw is not null and roster84_uscc(p.uscc_raw)<>''
        and roster84_uscc(p.uscc_raw)=roster84_uscc(r.uscc_raw)
  )
  select enterprise_id as id from record where title_code=@title
  union select enterprise_id as id from difference_reason where title_code=@title
  union select enterprise_id as id from record_correspondence where title_code=@title and enterprise_id is not null
  union select coalesce(r.enterprise_id,e.id) as id from recognized_identities p
    join platform_relation r on r.id=p.relation_id join platform_query q on q.id=r.query_id
    left join owners e on r.enterprise_id is null and e.uscc=roster84_uscc(p.uscc_raw)
    where coalesce(r.enterprise_id,e.id) is not null and ${relationScopeSql}
  union select coalesce(r.enterprise_id,e.id) as id from platform_relation r join platform_query q on q.id=r.query_id
    left join owners e on r.enterprise_id is null and e.uscc=roster84_uscc(r.uscc_raw)
    where not exists (select 1 from recognized_identities p where p.relation_id=r.id)
      and coalesce(r.enterprise_id,e.id) is not null and ${relationScopeSql}`

/** The frozen functions above remain the independent legacy oracle and rollback.
 * This selector is shared by qualified HTTP/MCP/page reads and export workers.
 */
export function currentCandidateReadSqlFor(db: Database.Database, explicit?: RecognizedFactSource): string {
  if (resolveRecognizedFactSource(explicit) === 'legacy') return currentCandidateSqlFor(db)
  const covered = currentCandidateSqlFor(db) === coveringCandidateSql
  return covered ? typedCandidateSql
    .replace('platform_relation r join', 'platform_relation r INDEXED BY platform_relation_current_candidate_cover_idx join')
    .replaceAll('platform_query q on', 'platform_query q INDEXED BY platform_query_current_candidate_cover_idx on') : typedCandidateSql
}
