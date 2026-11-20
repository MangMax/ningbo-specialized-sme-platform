import { sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { getPostgresComparison } from '../comparison'
import { normalizeName } from '../domain'
import { postgresDifferenceRow } from '../../server/utils/decision-lifecycle-102/postgres-reads'
import { projectDifferences } from './current-difference'
import { readPostgresDifferenceQualifications } from './current-qualification-postgres'
import { projectRosterDifferenceList, selectRosterDifferencePage } from './difference-list'
import type { RosterDifferenceFilter, RosterDifferencesResult } from './enterprise-roster'
import { readPostgresQueryAssessments } from './query-assessment-postgres'

type Reader = Pick<NodePgDatabase,'execute'>
type Head = Parameters<typeof selectRosterDifferencePage>[2][number]
type MapValue<T> = T extends Map<unknown,infer Value> ? Value : never
type Explanation = MapValue<Parameters<typeof projectRosterDifferenceList>[2]>
type Query = MapValue<Parameters<typeof projectRosterDifferenceList>[4]>
const ids = (values: readonly number[]) => sql`${sql.param(values)}::bigint[]`

async function selectPage(db: Reader, filter: RosterDifferenceFilter) {
  const { rows: heads } = await db.execute<Head>(sql`
    SELECT DISTINCT ON(enterprise_id,title_code,direction) id::float8 AS id,enterprise_id::float8 AS "enterpriseId",
      title_code AS "titleCode",direction,status,reason_code AS "reasonCode"
    FROM difference_reason ORDER BY enterprise_id,title_code,direction,recorded_at DESC,id DESC`)
  const { rows: derived } = await getPostgresComparison(db)
  const selectedOwners = [...new Set([...heads.map(row => row.enterpriseId), ...derived.map(row => row.enterpriseId)])]
  const { rows: enterprises } = await db.execute<{ id: number; name: string; uscc: string | null }>(sql`
    SELECT id::float8 AS id,name,uscc_norm AS uscc FROM enterprise WHERE id=ANY(${ids(selectedOwners)})`)
  const aliases = new Map<number, string[]>()
  if (filter.q?.trim()) {
    const { rows } = await db.execute<{ enterpriseId: number; name: string }>(sql`
      SELECT enterprise_id::float8 AS "enterpriseId",name FROM enterprise_alias
      WHERE verification_status='confirmed' AND enterprise_id=ANY(${ids(selectedOwners)})`)
    for (const [owner, names] of Map.groupBy(rows, row => row.enterpriseId)) aliases.set(owner, names.map(row => normalizeName(row.name)))
  }
  return selectRosterDifferencePage(filter, derived, heads, new Map(enterprises.map(row => [row.id,row])), aliases)
}

export async function listPostgresRosterDifferences(db: NodePgDatabase, filter: RosterDifferenceFilter): Promise<RosterDifferencesResult> {
  return db.transaction(async tx => {
    const asOf = Date.now()
    const page = await selectPage(tx, filter)
    if (!page.rows.length) return { ...page, rows: [] }
    const enterpriseIds = [...new Set(page.rows.map(row => row.enterpriseId))]
    const qualification = await readPostgresDifferenceQualifications(tx, enterpriseIds, asOf)
    const selected = projectDifferences(page.rows, qualification.assessed, qualification.facts, asOf)
    const selectedIds = selected.flatMap(row => row.explanationId === null ? [] : [row.explanationId])
    const { rows: stored } = await tx.execute<{ row: Explanation }>(sql`
      SELECT ${postgresDifferenceRow()} AS row FROM difference_reason p WHERE p.id=ANY(${ids(selectedIds)})`)
    const { rows: districts } = await tx.execute<{ id: number; district: string | null }>(sql`
      SELECT e.id::float8 AS id,coalesce(e.district,(SELECT r.district FROM record r WHERE r.enterprise_id=e.id
        AND r.district IS NOT NULL AND r.district<>'' ORDER BY r.id LIMIT 1)) AS district
      FROM enterprise e WHERE e.id=ANY(${ids(enterpriseIds)})`)
    const queryIds = [...new Set(stored.flatMap(({ row }) => row.evidenceQueryId === null ? [] : [row.evidenceQueryId]))]
    const queries = queryIds.length ? (await tx.execute<Query>(sql`
      SELECT a.old_id::float8 AS id,c.queried_at AS "queriedAt",c.interface,c.status,c.failure_reason AS "failureReason"
      FROM platform_legacy_query_alias a JOIN platform_collection c ON c.id=a.collection_id WHERE a.old_id=ANY(${ids(queryIds)})`)).rows : []
    const observations = queryIds.length ? (await tx.execute<{ queryId: number; id: number }>(sql`
      SELECT q.old_id::float8 AS "queryId",a.old_id::float8 AS id FROM platform_legacy_query_alias q
      JOIN platform_business_observation o ON o.collection_id=q.collection_id JOIN platform_legacy_relation_alias a ON a.observation_id=o.id
      WHERE q.old_id=ANY(${ids(queryIds)}) ORDER BY o.id`)).rows : []
    const relations = new Map([...Map.groupBy(observations, row => row.queryId)].map(([id, rows]) => [id, rows.map(row => row.id)]))
    const assessments = await readPostgresQueryAssessments(tx, selected)
    return projectRosterDifferenceList(page, selected, new Map(stored.map(({ row }) => [row.id,row])),
      new Map(districts.map(row => [row.id,row.district])), new Map(queries.map(row => [row.id,row])), relations, assessments)
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' })
}
