import { sql, type SQL, type Table } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import * as schema from '../../../../db/schema'
import { normalizeUscc } from '../domain'
import { projectDifferenceCollectionScope, type DifferenceCollectionScopeRows } from '../platform/difference-sources'
import { TITLE_RDJB_CODES } from '../platform/recognized-evidence'
import { qualificationUsccCandidate } from './platform-qualification-postgres'
import { postgresRosterRow } from './postgres-rows'
import { projectQueryCoverage } from './query-assessment'

type Reader = Pick<NodePgDatabase, 'execute'>
type CoverageSubject = { id: number; uscc_norm: string | null; name_norm: string }
type CoverageCollection = { slot: number; id: number; collection: DifferenceCollectionScopeRows['collection']; matched: number }
type PostgresQueryCoverage = ReturnType<typeof projectQueryCoverage>

/** The caller pins one snapshot for selected query coordinates and their typed metadata. */
export async function readPostgresQueryCoverage(db: Reader, subjects: readonly CoverageSubject[], titleCodes: readonly string[]) {
  const coverages = new Map<number, Map<string, PostgresQueryCoverage>>()
  for (const { id, titleCode, input } of await readPostgresQueryCoverageInputs(db, subjects, titleCodes)) {
    const titled = coverages.get(id) ?? new Map()
    titled.set(titleCode, projectQueryCoverage(input, { titleCode }))
    coverages.set(id, titled)
  }
  return coverages
}

export async function readPostgresQueryCoverageInputs(db: Reader, subjects: readonly CoverageSubject[], titleCodes: readonly string[],
  exactStoredKey = false,
) {
  if (!subjects.length || !titleCodes.length) return []
  const codes = [...new Set(subjects.map(subject => normalizeUscc(subject.uscc_norm)).filter(Boolean))]
  const variants = new Map<string, string[]>()
  if (codes.length) {
    const { rows } = await db.execute<{ key: string }>(sql`
      SELECT DISTINCT query_key AS key FROM platform_collection WHERE ${qualificationUsccCandidate(sql`query_key`, codes)}`)
    for (const { key } of rows) {
      const normalized = normalizeUscc(key)
      if (normalized === key || !codes.includes(normalized)) continue
      const keys = variants.get(normalized) ?? []
      keys.push(key)
      variants.set(normalized, keys)
    }
  }
  const targets = subjects.flatMap(subject => titleCodes.map(titleCode => {
    const uscc = normalizeUscc(subject.uscc_norm) || null
    return { enterprise_id: subject.id, title_code: titleCode, rdjb: TITLE_RDJB_CODES[titleCode] ?? '',
      uscc, query_keys: [`name:${subject.name_norm}`, ...(exactStoredKey ? [subject.uscc_norm ?? ''] : []), ...(uscc ? [uscc, ...variants.get(uscc) ?? []] : [])] }
  }))
  const { rows } = await db.execute<CoverageCollection>(sql`
    WITH targets AS MATERIALIZED (
      SELECT (ordinal - 1)::integer AS slot, (target ->> 'enterprise_id')::bigint AS enterprise_id,
        target ->> 'title_code' AS title_code, target ->> 'rdjb' AS rdjb,
        ARRAY(SELECT json_array_elements_text(target -> 'query_keys')) AS query_keys
      FROM json_array_elements(${JSON.stringify(targets)}::json) WITH ORDINALITY j(target, ordinal)
    ), owners AS MATERIALIZED (
      SELECT DISTINCT a.enterprise_id, o.collection_id FROM platform_observation_assignment a
        JOIN platform_business_observation o ON o.id = a.observation_id
        WHERE a.enterprise_id = ANY(${sql.param(subjects.map(subject => subject.id))}::bigint[])
          AND NOT EXISTS (SELECT 1 FROM platform_observation_assignment newer
            WHERE newer.observation_id = a.observation_id AND newer.revision > a.revision)
    ), candidates AS (
      SELECT t.slot, c.id AS collection_id FROM targets t JOIN platform_collection c ON c.query_key = ANY(t.query_keys)
      UNION
      SELECT t.slot, o.collection_id FROM targets t JOIN owners o USING (enterprise_id)
    ), ranked AS (
      SELECT t.slot, qa.old_id AS id, c.id AS collection_id, (o.enterprise_id IS NOT NULL)::integer AS matched,
        row_number() OVER (PARTITION BY t.slot ORDER BY c.queried_at COLLATE "C" DESC, qa.old_id DESC) AS rank
      FROM candidates x JOIN targets t USING (slot) JOIN platform_collection c ON c.id = x.collection_id
      JOIN platform_legacy_query_alias qa ON qa.collection_id = c.id
      LEFT JOIN owners o ON o.enterprise_id = t.enterprise_id AND o.collection_id = c.id
      WHERE c.interface = 'apply_list' OR c.title_code = t.title_code
        OR t.rdjb = ANY(string_to_array(c.rdjb, ',')) OR c.rdjb = '' AND c.title_code IS NULL
    )
    SELECT r.slot, r.id::float8 AS id, r.matched, ${postgresRosterRow(schema.platformCollection, 'c')} AS collection
    FROM ranked r JOIN platform_collection c ON c.id = r.collection_id WHERE rank <= 51 ORDER BY slot, rank`)
  const byTarget = Map.groupBy(rows, row => row.slot)
  const retained = [...byTarget.values()].flatMap(rows => rows.slice(0, 50))
  const metadata = await readPostgresCollectionScopes(db, [...new Map(retained.map(row => [row.collection.id, row.collection])).values()])
  return targets.map((target, slot) => {
    const { enterprise_id: id, title_code: titleCode, uscc } = target
    const result = byTarget.get(slot) ?? []
    const sources = result.slice(0, 50).map(({ collection, id, matched }) => ({
      id, matched, interface: collection.interface, queryKey: collection.queryKey, titleCode: collection.titleCode,
      rdjb: collection.rdjb, queriedAt: collection.queriedAt, status: collection.status,
      metadata: collection.provenanceState === 'legacy_supplement' ? null : JSON.stringify(metadata.get(collection.id)!.metadata),
    }))
    return { id, titleCode, input: { rows: sources, uscc, truncated: result.length > 50 } }
  })
}

export async function readPostgresCollectionScopes(db: Reader, collections: DifferenceCollectionScopeRows['collection'][]) {
  const ids = collections.map(collection => collection.id)
  if (!ids.length) return new Map<number, ReturnType<typeof projectDifferenceCollectionScope>>()
  const coordinates = sql`${sql.param(ids)}::bigint[]`
  async function projected<T extends Table>(table: T, source: SQL, order: SQL) {
    return (await db.execute<{ row: T['$inferSelect'] }>(sql`
      SELECT ${postgresRosterRow(table, 'p')} AS row FROM ${source} p
      WHERE p.collection_id = ANY(${coordinates}) ORDER BY p.collection_id, ${order}`)).rows.map(({ row }) => row)
  }
  const { rows } = await db.execute<{ collectionId: string; name: string; valueKind: string; textValue: string | null; integerValue: number | null }>(sql`
    SELECT collection_id AS "collectionId", name, value_kind AS "valueKind", text_value AS "textValue", integer_value::float8 AS "integerValue"
    FROM platform_collection_condition WHERE collection_id = ANY(${coordinates}) ORDER BY collection_id, name COLLATE "C"`)
  const conditions = Map.groupBy(rows as Array<DifferenceCollectionScopeRows['conditions'][number] & { collectionId: string }>,
    row => Number(row.collectionId))
  const pages = Map.groupBy(await projected(schema.platformCollectionPage, sql`platform_collection_page`, sql`p.ordinal`), row => row.collectionId)
  const unfinished = Map.groupBy(await projected(schema.platformCollectionUnfinished, sql`platform_collection_unfinished`, sql`p.ordinal`), row => row.collectionId)
  const titles = Map.groupBy(await projected(schema.platformQueryTitleScope, sql`platform_query_title_scope`, sql`p.rdjb COLLATE "C"`), row => row.collectionId)
  return new Map(collections.map(collection => [collection.id, projectDifferenceCollectionScope({
    collection, conditions: conditions.get(collection.id) ?? [], pages: pages.get(collection.id) ?? [],
    unfinished: unfinished.get(collection.id) ?? [], titles: (titles.get(collection.id) ?? []).map(row => row.rdjb),
  })]))
}
