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
/** Full reads fail explicitly above these archive-byte budgets; chunk reads never truncate. */
export const MAX_FULL_QUERY_BYTES = 4 * 1024 * 1024
export const MAX_FULL_PAGE_BYTES = 8 * 1024 * 1024

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
  return db.transaction(tx => listPlatformQueriesSnapshot(tx, filter))
}

function listPlatformQueriesSnapshot(
  db: Pick<BetterSQLite3Database<typeof schema>, 'select'>,
  filter: PlatformQueryFilter,
): PlatformQueriesResult {
  if (filter.view === 'summary' && filter.includeRawResponse) throw Object.assign(new Error('Invalid view or includeRawResponse combination'), { statusCode: 400 })
  const conditions = []
  if (filter.queryId != null) conditions.push(eq(schema.platformQuery.id, filter.queryId))
  if (filter.interface) conditions.push(eq(schema.platformQuery.interface, filter.interface))
  if (filter.uscc) conditions.push(sql`(${schema.platformQuery.queryKey} = ${filter.uscc} OR ${schema.platformQuery.id} in (select ${schema.platformRelation.queryId} from ${schema.platformRelation} where ${schema.platformRelation.usccRaw} = ${filter.uscc}))`)
  if (filter.titleCode) {
    const rdjb = Object.keys(RDJB_TITLE_CODES).find(key => RDJB_TITLE_CODES[key] === filter.titleCode) ?? ''
    conditions.push(sql`(${schema.platformQuery.titleCode} = ${filter.titleCode} OR EXISTS (SELECT 1 FROM json_each(json_extract(${schema.platformQuery.collectionEvidence}, '$.titleScope.rdjb')) WHERE value = ${rdjb}))`)
  }
  if (filter.queryKey) conditions.push(eq(schema.platformQuery.queryKey, filter.queryKey))
  if (filter.status) conditions.push(eq(schema.platformQuery.status, filter.status))
  if (filter.enterpriseId != null) {
    conditions.push(
      sql`${schema.platformQuery.id} in (select ${schema.platformRelation.queryId} from ${schema.platformRelation} where ${schema.platformRelation.enterpriseId} = ${filter.enterpriseId})`,
    )
  }
  const where = conditions.length ? and(...conditions) : undefined

  const counts: Record<string, number> = Object.fromEntries(db
    .select({ status: schema.platformQuery.status, count: sql<number>`count(*)` })
    .from(schema.platformQuery)
    .where(where)
    .groupBy(schema.platformQuery.status)
    .all().map(row => [row.status, row.count]))

  const page = clamp(filter.page, 1)
  const pageSize = clamp(filter.pageSize, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE)
  const summary = filter.view === 'summary'
  // Establish the page before evaluating any archive lengths or relation projections.
  const ids = db.select({ id: schema.platformQuery.id }).from(schema.platformQuery).where(where)
    .orderBy(sql`${schema.platformQuery.queriedAt} desc`, sql`${schema.platformQuery.id} desc`)
    .limit(pageSize).offset(Math.min(Number.MAX_SAFE_INTEGER, (page - 1) * pageSize)).all().map(q => q.id)
  const { rawResponse: _rawResponse, collectionEvidence: _collectionEvidence, ...columns } = getTableColumns(schema.platformQuery)
  const selectedMeta = ids.length ? db
    .select({
      ...columns,
      // Keep the outer qualifier: Drizzle unqualifies interpolated columns in a single-table projection.
      relationCount: sql<number>`(select count(*) from platform_relation r where r.query_id = platform_query.id)`,
      ...(!summary ? { evidenceBytes: sql<number>`
        coalesce(length(cast(collection_evidence as blob)), 0) +
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
  const pageQueries = pageMeta.map(({ evidenceBytes: _bytes, ...q }) => ({ ...q, ...evidenceById.get(q.id) }))
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
  for (const { relation, matchedName } of relations) {
    const row: PlatformRelationRow = {
      ...sourcePositionForSequence(pageQueries.find(q => q.id === relation.queryId)?.collectionEvidence, relation.sequenceNo),
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
