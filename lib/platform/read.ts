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
import { and, eq, inArray, sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../../db/schema'
import { MAX_PAGE_SIZE } from '../query'
import type { PlatformInterface } from '../labels'

export interface PlatformQueryFilter {
  interface?: PlatformInterface
  queryKey?: string
  /** 只看「有关系归到该企业」的查询。 */
  enterpriseId?: number
  status?: 'success' | 'failed' | 'no_record' | 'not_queried'
  page?: number
  pageSize?: number
  /** 是否带出原始响应原文(§1.3 的 `raw_response`);缺省 false(列表体量控制)。 */
  includeRawResponse?: boolean
}

export interface PlatformRelationRow {
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
  const conditions = []
  if (filter.interface) conditions.push(eq(schema.platformQuery.interface, filter.interface))
  if (filter.queryKey) conditions.push(eq(schema.platformQuery.queryKey, filter.queryKey))
  if (filter.status) conditions.push(eq(schema.platformQuery.status, filter.status))
  if (filter.enterpriseId != null) {
    conditions.push(
      sql`${schema.platformQuery.id} in (select ${schema.platformRelation.queryId} from ${schema.platformRelation} where ${schema.platformRelation.enterpriseId} = ${filter.enterpriseId})`,
    )
  }
  const where = conditions.length ? and(...conditions) : undefined

  const all = db
    .select()
    .from(schema.platformQuery)
    .where(where)
    .orderBy(sql`${schema.platformQuery.queriedAt} desc`, sql`${schema.platformQuery.id} desc`)
    .all()

  const counts: Record<string, number> = {}
  for (const query of all) counts[query.status] = (counts[query.status] ?? 0) + 1

  const page = clamp(filter.page, 1)
  const pageSize = clamp(filter.pageSize, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE)
  const pageQueries = all.slice((page - 1) * pageSize, page * pageSize)

  const ids = pageQueries.map((q) => q.id)
  const relations = ids.length
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
        query: {
          ...rest,
          ...(filter.includeRawResponse ? { rawResponse } : {}),
          relationCount: (byQuery.get(query.id) ?? []).length,
        },
        relations: byQuery.get(query.id) ?? [],
      }
    }),
    total: all.length,
    page,
    pageSize,
    counts,
  }
}
