import { sql, type SQL } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { createError } from 'h3'
import { MAX_PAGE_SIZE } from '../query'
import type { PlatformQueriesResult, PlatformQueryFilter, PlatformQueryRow } from './read'
import { RDJB_TITLE_CODES } from './recognized-evidence'

const fromCollections = sql`
  FROM platform_collection c
  JOIN platform_legacy_query_alias q ON q.collection_id = c.id`

function conditionsOf(filter: PlatformQueryFilter) {
  const conditions: SQL[] = []
  if (filter.queryId != null) conditions.push(sql`q.old_id = ${filter.queryId}`)
  if (filter.interface) conditions.push(sql`c.interface = ${filter.interface}`)
  if (filter.status) conditions.push(sql`c.status = ${filter.status}`)
  if (filter.queryKey) conditions.push(filter.queryKey.includes('\0') ? sql`FALSE` : sql`c.query_key = ${filter.queryKey}`)
  if (filter.uscc) conditions.push(filter.uscc.includes('\0') ? sql`FALSE` : sql`(
    c.query_key = ${filter.uscc} OR EXISTS (
      SELECT 1 FROM platform_business_observation o
      JOIN platform_observation_assignment a ON a.observation_id = o.id AND a.revision = 1
      WHERE o.collection_id = c.id AND a.uscc_raw = ${filter.uscc}
    ))`)
  if (filter.enterpriseId != null) conditions.push(!Number.isSafeInteger(filter.enterpriseId) ? sql`FALSE` : sql`EXISTS (
    SELECT 1 FROM platform_observation_assignment a
    JOIN platform_business_observation o ON o.id = a.observation_id
    WHERE o.collection_id = c.id AND a.enterprise_id = ${filter.enterpriseId}
      AND NOT EXISTS (
        SELECT 1 FROM platform_observation_assignment later
        WHERE later.observation_id = a.observation_id AND later.revision > a.revision
      )
  )`)
  return conditions
}

type Query = Omit<PlatformQueryRow['query'], 'id' | 'relationCount'> & {
  id: string
  lastCollectedAt: string | null
  relationCount: string
}

export function readPostgresPlatformQuerySummary(db: NodePgDatabase, filter: PlatformQueryFilter): Promise<PlatformQueriesResult> {
  if (filter.includeRawResponse) throw createError({ statusCode: 400, statusMessage: 'Invalid view or includeRawResponse combination' })
  const page = Math.min(filter.page ?? 1, Number.MAX_SAFE_INTEGER)
  const pageSize = Math.min(filter.pageSize ?? 25, MAX_PAGE_SIZE)
  const offset = (BigInt(page) - BigInt(1)) * BigInt(pageSize)
  const conditions = conditionsOf(filter)
  const where = () => conditions.length ? sql`WHERE ${sql.join(conditions, sql` AND `)}` : sql.empty()

  return db.transaction(async tx => {
    if (filter.titleCode) {
      const base = conditions.length ? sql`${where()} AND` : sql`WHERE`
      const { rows: [malformed] } = await tx.execute(sql`
        SELECT c.id ${fromCollections}
        JOIN platform_query_title_scope_error e ON e.collection_id = c.id
        JOIN platform_collection_archive_ref r ON r.owner_id = c.id AND r.field = 'collectionEvidence'
        JOIN platform_archive_value v ON v.id = r.archive_id
        ${base} c.title_code IS DISTINCT FROM ${filter.titleCode} AND v.storage_class <> 'null'
        LIMIT 1`)
      if (malformed) throw createError({ statusCode: 500, statusMessage: 'Malformed stored platform title scope' })
      const rdjb = Object.keys(RDJB_TITLE_CODES).find(key => RDJB_TITLE_CODES[key] === filter.titleCode) ?? ''
      conditions.push(sql`(c.title_code = ${filter.titleCode} OR EXISTS (
        SELECT 1 FROM platform_query_title_scope s WHERE s.collection_id = c.id AND s.rdjb = ${rdjb}
      ))`)
    }
    const predicate = where()
    const { rows: countRows } = await tx.execute<{ status: string; count: string }>(sql`
      SELECT c.status, count(*) ${fromCollections} ${predicate} GROUP BY c.status`)
    const counts = Object.fromEntries(countRows.map(row => [row.status, Number(row.count)]))
    const total = Object.values(counts).reduce((sum, n) => sum + n, 0)
    const rows = offset >= BigInt(total) ? [] : (await tx.execute<Query>(sql`
      SELECT q.old_id AS id, c.interface, c.query_key AS "queryKey", c.rdjb, c.title_code AS "titleCode",
        c.queried_at AS "queriedAt", c.status, c.failure_reason AS "failureReason",
        c.created_at AS "createdAt", c.last_collected_at AS "lastCollectedAt",
        (SELECT count(*) FROM platform_business_observation o WHERE o.collection_id = c.id) AS "relationCount"
      ${fromCollections} ${predicate}
      ORDER BY c.queried_at COLLATE "C" DESC, q.old_id DESC LIMIT ${pageSize} OFFSET ${String(offset)}`)).rows
    return { rows: rows.map(row => ({
      relationsIncluded: false,
      query: { ...row, id: Number(row.id), relationCount: Number(row.relationCount) },
      relations: [],
    })), total, page, pageSize, counts }
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' })
}
