import { sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { normalizeUscc } from '../domain'
import { TITLE_RDJB_CODES } from '../platform/recognized-evidence'
import { CURRENT_TITLES, type CurrentTitle } from './current-titles'
import { qualificationUsccCandidate } from './platform-qualification-postgres'

type Reader = Pick<NodePgDatabase, 'execute'>
type Sort = 'id_asc' | 'name_asc' | 'name_desc'

export async function readPostgresCurrentCandidateIds(db: Reader, title: CurrentTitle, sort: Sort = 'id_asc') {
  const titles = CURRENT_TITLES.slice(0, CURRENT_TITLES.indexOf(title) + 1)
  const titleNames = sql`${sql.param(titles)}::text[]`
  const returnedTitles = sql`${sql.param(titles.map(code => TITLE_RDJB_CODES[code]))}::text[]`
  const { rows } = await db.execute<{ id: string | null; uscc: string | null }>(sql`
    WITH typed_return AS MATERIALIZED (
      SELECT version_id, observation_id FROM platform_recognized_projection WHERE title_raw = ANY(${returnedTitles})
      UNION
      SELECT version_id, observation_id FROM platform_business_projection WHERE title_raw = ANY(${returnedTitles})
      UNION
      SELECT version_id, observation_id FROM platform_apply_projection WHERE title_raw = ANY(${returnedTitles})
    ), observations AS (
      SELECT o.id FROM typed_return t JOIN platform_business_observation o ON o.version_id = t.version_id
      UNION
      SELECT observation_id FROM typed_return WHERE observation_id IS NOT NULL
    )
    SELECT enterprise_id AS id, NULL::text AS uscc FROM record WHERE title_code = ANY(${titleNames})
    UNION
    SELECT enterprise_id, NULL::text FROM difference_reason WHERE title_code = ANY(${titleNames})
    UNION
    SELECT enterprise_id, NULL::text FROM record_correspondence
      WHERE title_code = ANY(${titleNames}) AND enterprise_id IS NOT NULL
    UNION
    SELECT a.enterprise_id, CASE WHEN a.enterprise_id IS NULL THEN a.uscc_raw END
    FROM observations o JOIN LATERAL (
      SELECT enterprise_id, uscc_raw FROM platform_observation_assignment
      WHERE observation_id = o.id ORDER BY revision DESC LIMIT 1
    ) a ON true`)
  const ids = new Set(rows.flatMap(row => row.id === null ? [] : [Number(row.id)]))
  const keys = new Set(rows.flatMap(row => row.id === null && row.uscc !== null ? [normalizeUscc(row.uscc)] : []))
  if (keys.size) {
    const { rows: owners } = await db.execute<{ id: string; uscc: string }>(sql`
      SELECT id, uscc_norm AS uscc FROM enterprise
      WHERE uscc_norm IS NOT NULL AND ${qualificationUsccCandidate(sql`uscc_norm`, [...keys])}`)
    for (const { id, uscc } of owners) if (keys.has(normalizeUscc(uscc))) ids.add(Number(id))
  }
  if (sort === 'id_asc') return [...ids].sort((a, b) => a - b)
  const { rows: named } = await db.execute<{ id: string }>(sql`
    SELECT id FROM enterprise WHERE id = ANY(${sql.param([...ids])}::bigint[])
    ORDER BY lower(name COLLATE "C") ${sort === 'name_desc' ? sql`DESC` : sql`ASC`}, id`)
  return named.map(row => Number(row.id))
}
