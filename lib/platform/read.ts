/**
 * 平台查询证据的**读模型**(契约 §7.6 `GET /api/platform/queries`)。
 *
 * 只读:`platform_query` × `platform_relation`,逐条返回 —— **一个信用代码的多条关联
 * 不被覆盖为一条**(§1.4 唯一键是 `(query_id, sequence_no)`,不是企业/信用代码)。
 * 四态(`not_queried` / `failed` / `no_record` / `success`)原样带出,由展示层各自呈现,
 * 读模型**不把失败解释成「无记录」**。
 *
 * 人工确认过的现名/曾用名/已核验处置不在这里、也不复制到关系行上 —— 它们分别落在
 * `enterprise_alias` 与 `difference_reason`,由 RL-04 的读接口与比对页接缝消费。
 * 本模型只多带一个 `matchedName`(关系匹配到的企业名),方便展示「这条归到哪家」。
 */
import { and, eq, getTableColumns, inArray, sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../../db/schema'
import { MAX_PAGE_SIZE } from '../query'
import { sourcePositionForSequence, RDJB_TITLE_CODES } from './recognized-evidence'
import type { PlatformInterface } from '../labels'
import { normalizePlatformRelation, type PlatformNormalizationConflict } from './normalization'
import { readLegacyPlatformProvenance, legacySourcePositionForSequence } from './legacy-provenance'
import { queryHistoryTarget } from './query-history-target'
import { listTargetPlatformQueries } from './target-query-read'
import { MAX_FULL_QUERY_BYTES, MAX_FULL_PAGE_BYTES } from './evidence-contract'
export { MAX_FULL_QUERY_BYTES, MAX_FULL_PAGE_BYTES } from './evidence-contract'

export interface PlatformQueryFilter {
  queryId?: number
  /** Explicit opt-in: metadata/counts only; use exact evidence reads for payloads. */
  view?: 'full' | 'summary'
  interface?: PlatformInterface
  queryKey?: string
  /** 只看「有关系归到该企业」的查询。 */
  enterpriseId?: number
  status?: 'success' | 'failed' | 'no_record' | 'not_queried' | 'partial'
  titleCode?: string
  uscc?: string
  page?: number
  pageSize?: number
  /** 是否带出原始响应原文(§1.3 的 `raw_response`);缺省 false(列表体量控制)。 */
  includeRawResponse?: boolean
}

export interface PlatformRelationRow {
  normalizationConflicts?: PlatformNormalizationConflict[]
  sourceRdjb?: string | null
  sourcePage?: number | null
  id: number
  queryId: number
  sequenceNo: number
  relationKey: string | null
  enterpriseId: number | null
  /** 匹配到的企业名(展示用;未匹配为 null)。 */
  matchedName: string | null
  sourceText: string | null
  usccRaw: string | null
  nameRaw: string | null
  aliasNameRaw: string | null
  province: string | null
  status: string | null
  batch: string | null
  declareKind: string | null
  appliedAt: string | null
  awardBatchLabel: string | null
  year: number | null
  matchBasis: string
  verificationStatus: string
  rawFields: Record<string, unknown> | null
}

export interface PlatformQueryRow {
  /** false only in the explicitly requested summary view; [] does not mean no relations. */
  relationsIncluded?: false
  query: {
    id: number
    interface: string
    queryKey: string
    rdjb: string
    titleCode: string | null
    queriedAt: string
    status: string
    failureReason: string | null
    rawResponse?: string | null
    collectionEvidence?: import('./live-query').PlatformLiveQueryResult | null
    legacyProvenance?: ReturnType<typeof readLegacyPlatformProvenance> extends Map<number, infer Value> ? Value : never
    createdAt: string
    relationCount: number
  }
  relations: PlatformRelationRow[]
}

export interface PlatformQueriesResult {
  rows: PlatformQueryRow[]
  total: number
  page: number
  pageSize: number
  counts: Record<string, number>
}

const DEFAULT_PAGE_SIZE = 25
function clamp(value: number | undefined, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 1) return fallback
  return Math.min(Math.floor(n), max)
}

/**
 * 列出平台查询与它们的全部关系。按 `queriedAt` 倒序(最新的先看),
 * 关系按 `sequenceNo` 升序(保持平台返回时的顺序 —— 那是「第几条」的原始次序)。
 */
export function listPlatformQueries(
  db: BetterSQLite3Database<typeof schema>,
  filter: PlatformQueryFilter = {},
): PlatformQueriesResult {
  if (queryHistoryTarget(db)) return listTargetPlatformQueries(db, filter)
  return db.transaction(tx => listPlatformQueriesSnapshot(tx, filter))
}

function listPlatformQueriesSnapshot(
  db: Pick<BetterSQLite3Database<typeof schema>, 'select' | 'all'>,
  filter: PlatformQueryFilter,
): PlatformQueriesResult {
  if (filter.view === 'summary' && filter.includeRawResponse) throw Object.assign(new Error('Invalid view or includeRawResponse combination'), { statusCode: 400 })
  const conditions = []
  if (filter.queryId != null) conditions.push(eq(schema.platformQuery.id, filter.queryId))
  if (filter.interface) conditions.push(eq(schema.platformQuery.interface, filter.interface))
  if (filter.uscc) conditions.push(sql`(${schema.platformQuery.queryKey} = ${filter.uscc} OR ${schema.platformQuery.id} in (select ${schema.platformRelation.queryId} from ${schema.platformRelation} where ${schema.platformRelation.usccRaw} = ${filter.uscc}))`)
  if (filter.queryKey) conditions.push(eq(schema.platformQuery.queryKey, filter.queryKey))
  if (filter.status) conditions.push(eq(schema.platformQuery.status, filter.status))
  if (filter.enterpriseId != null) {
    conditions.push(
      sql`${schema.platformQuery.id} in (select ${schema.platformRelation.queryId} from ${schema.platformRelation} where ${schema.platformRelation.enterpriseId} = ${filter.enterpriseId})`,
    )
  }
  if (filter.titleCode) {
    // Preserve the legacy predicate's error for a malformed archive in this exact
    // filter scope. Only marked IDs are read; ordinary title requests stay indexed.
    const withoutTitle = conditions.length ? and(...conditions) : sql`1`
    const malformed = db.all<{ archive: string }>(sql`select collection_evidence as archive from platform_query
      where id in (select query_id from platform_query_title_scope_error)
        and ${withoutTitle} and (title_code is null or title_code <> ${filter.titleCode}) limit 1`)
    if (malformed.length) db.all(sql`select value from json_each(json_extract(${malformed[0]!.archive}, '$.titleScope.rdjb'))`)
    const rdjb = Object.keys(RDJB_TITLE_CODES).find(key => RDJB_TITLE_CODES[key] === filter.titleCode) ?? ''
    conditions.push(sql`${schema.platformQuery.id} in (
      select id from platform_query where title_code = ${filter.titleCode}
      union select query_id from platform_query_title_scope where rdjb = ${rdjb}
    )`)
  }
  const where = conditions.length ? and(...conditions) : undefined
  // A title membership can span many queries. Read the narrow status/time indexes
  // while evaluating that ID set, rather than fetching every wide archive row by PK.
  const countRows = filter.titleCode
    ? db.all<{ status: string; count: number }>(sql`select status, count(*) as count from platform_query indexed by platform_query_status_time_idx where ${where} group by status`)
    : db.select({ status: schema.platformQuery.status, count: sql<number>`count(*)` })
      .from(schema.platformQuery).where(where).groupBy(schema.platformQuery.status).all()
  const counts: Record<string, number> = Object.fromEntries(countRows.map(row => [row.status, row.count]))

  const page = clamp(filter.page, 1)
  const pageSize = clamp(filter.pageSize, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE)
  const summary = filter.view === 'summary'
  // Establish the page before evaluating any archive lengths or relation projections.
  const offset = Math.min(Number.MAX_SAFE_INTEGER, (page - 1) * pageSize)
  const ids = (filter.titleCode
    ? db.all<{ id: number }>(filter.status
      ? sql`select id from platform_query indexed by platform_query_status_time_idx where ${where} order by queried_at desc, id desc limit ${pageSize} offset ${offset}`
      : sql`select id from platform_query indexed by platform_query_time_idx where ${where} order by queried_at desc, id desc limit ${pageSize} offset ${offset}`)
    : db.select({ id: schema.platformQuery.id }).from(schema.platformQuery).where(where)
      .orderBy(sql`${schema.platformQuery.queriedAt} desc`, sql`${schema.platformQuery.id} desc`)
      .limit(pageSize).offset(offset).all()).map(q => q.id)
  const { rawResponse: _rawResponse, collectionEvidence: _collectionEvidence, ...columns } = getTableColumns(schema.platformQuery)
  const selectedMeta = ids.length ? db
    .select({
      ...columns,
      // Keep the outer qualifier: Drizzle unqualifies interpolated columns in a single-table projection.
      relationCount: sql<number>`(select count(*) from platform_relation r where r.query_id = platform_query.id)`,
      ...(!summary ? { evidenceBytes: sql<number>`
        coalesce(length(cast(collection_evidence as blob)), 0) +
        coalesce((select length(cast(json_remove(collection, '$.rows') as blob)) from platform_query_legacy_provenance p where p.query_id = platform_query.id), 0) +
        ${filter.includeRawResponse ? sql`coalesce(length(cast(raw_response as blob)), 0)` : sql`0`} +
        coalesce((select sum(1024 + coalesce(length(cast(raw_fields as blob)), 0) +
          coalesce(length(cast(source_text as blob)), 0) + coalesce(length(cast(name_raw as blob)), 0) +
          coalesce(length(cast(alias_name_raw as blob)), 0) + coalesce(length(cast(uscc_raw as blob)), 0) +
          coalesce(length(cast(relation_key as blob)), 0) + coalesce(length(cast(province as blob)), 0) +
          coalesce(length(cast(r.status as blob)), 0) + coalesce(length(cast(batch as blob)), 0) +
          coalesce(length(cast(declare_kind as blob)), 0) + coalesce(length(cast(applied_at as blob)), 0) +
          coalesce(length(cast(award_batch_label as blob)), 0) + coalesce(length(cast(e.name as blob)), 0))
          from platform_relation r left join enterprise e on e.id = r.enterprise_id where r.query_id = platform_query.id), 0)` } : {}),
    })
    .from(schema.platformQuery)
    .where(inArray(schema.platformQuery.id, ids))
    .all() : []
  const metaById = new Map(selectedMeta.map(q => [q.id, q]))
  const pageMeta = ids.map(id => metaById.get(id)!)

  if (!summary && (pageMeta.some(q => (q.evidenceBytes ?? 0) > MAX_FULL_QUERY_BYTES) || pageMeta.reduce((n, q) => n + (q.evidenceBytes ?? 0), 0) > MAX_FULL_PAGE_BYTES)) {
    const message = 'Platform evidence exceeds full-read budget; use view=summary and /api/platform/queries/{queryId}/evidence (get_platform_query_evidence)'
    throw Object.assign(new Error(message), { statusCode: 413, statusMessage: message })
  }
  const evidenceById = new Map(!summary && ids.length ? db.select({
    id: schema.platformQuery.id,
    collectionEvidence: schema.platformQuery.collectionEvidence,
    ...(filter.includeRawResponse ? { rawResponse: schema.platformQuery.rawResponse } : {}),
  }).from(schema.platformQuery).where(inArray(schema.platformQuery.id, ids)).all().map(q => [q.id, q]) : [])
  const legacyById = readLegacyPlatformProvenance(db, summary ? [] : ids)
  const pageQueries = pageMeta.map(({ evidenceBytes: _bytes, ...q }) => ({ ...q, ...evidenceById.get(q.id), ...(legacyById.has(q.id) ? { legacyProvenance: legacyById.get(q.id)! } : {}) }))
  const relations = ids.length && !summary
    ? db
        .select({
          relation: schema.platformRelation,
          matchedName: schema.enterprise.name,
        })
        .from(schema.platformRelation)
        .leftJoin(schema.enterprise, eq(schema.enterprise.id, schema.platformRelation.enterpriseId))
        .where(inArray(schema.platformRelation.queryId, ids))
        .orderBy(schema.platformRelation.queryId, schema.platformRelation.sequenceNo)
        .all()
    : []

  const byQuery = new Map<number, PlatformRelationRow[]>()
  for (const { relation: archivedRelation, matchedName } of relations) {
    const relation = normalizePlatformRelation(pageQueries.find(q => q.id === archivedRelation.queryId)!.interface, archivedRelation)
    const row: PlatformRelationRow = {
      ...(legacyById.has(relation.queryId) ? legacySourcePositionForSequence(legacyById.get(relation.queryId)!.collection, relation.sequenceNo)
        : sourcePositionForSequence(pageQueries.find(q => q.id === relation.queryId)?.collectionEvidence, relation.sequenceNo)),
      id: relation.id,
      queryId: relation.queryId,
      sequenceNo: relation.sequenceNo,
      relationKey: relation.relationKey,
      enterpriseId: relation.enterpriseId,
      matchedName: matchedName ?? null,
      sourceText: relation.sourceText,
      usccRaw: relation.usccRaw,
      nameRaw: relation.nameRaw,
      aliasNameRaw: relation.aliasNameRaw,
      province: relation.province,
      status: relation.status,
      batch: relation.batch,
      declareKind: relation.declareKind,
      appliedAt: relation.appliedAt,
      awardBatchLabel: relation.awardBatchLabel,
      year: relation.year,
      matchBasis: relation.matchBasis,
      verificationStatus: relation.verificationStatus,
      rawFields: relation.rawFields ?? null,
      normalizationConflicts: relation.normalizationConflicts,
    }
    const bucket = byQuery.get(relation.queryId)
    if (bucket) bucket.push(row)
    else byQuery.set(relation.queryId, [row])
  }

  return {
    rows: pageQueries.map((query) => {
      const { rawResponse, ...rest } = query
      return {
        ...(summary ? { relationsIncluded: false as const } : {}),
        query: {
          ...rest,
          ...(filter.includeRawResponse ? { rawResponse } : {}),
          relationCount: query.relationCount,
        },
        relations: byQuery.get(query.id) ?? [],
      }
    }),
    total: Object.values(counts).reduce((sum, n) => sum + n, 0),
    page,
    pageSize,
    counts,
  }
}
