/**
 * 比对行 × 平台证据的**接缝**(RL-03 交付物 3)。
 *
 * 比对页原来只把 `data/platform-reconcile.json` 的**离线解释缓存**挂在行上
 * (见 `lib/reconcile.ts`,那条路径**保持兼容、一字不改**)。本模块补的是**库内证据**:
 *  - 该企业的**现名 / 已确认曾用名**(`enterprise_alias`);
 *  - 该差异的**已核验处置**(`difference_reason`,原因 + 配对措施,取 `recordedAt` 最新那条);
 *  - 该企业的**平台查询与关系条数**(`platform_query` / `platform_relation`)—— 供「查看全部关系」跳转。
 *
 * 两者互不覆盖:库内证据是权威证据,JSON 缓存是旧的离线增强;读不到库内证据时为 `null`,
 * 页面照常渲染(与 `reconcile` 同样是增强项,不该让比对页挂掉)。
 */
import { inArray, sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../db/schema'
import type { ComparisonDirection } from './comparison'

export interface ComparisonAlias {
  id: number
  name: string
  nameNorm: string
  sourceKind: string
  sourceRefId: number
  verificationStatus: string
  validFrom: string | null
  note: string | null
}

export interface ComparisonDisposition {
  id: number
  status: string
  reasonCode: string | null
  reasonNote: string | null
  measureCode: string | null
  measureNote: string | null
  movedIn: { city: string | null; titleCode: string | null; year: number | null; batch: number | null } | null
  verificationStatus: string
  recordedAt: string
  evidenceQueryId: number | null
  evidenceRelationId: number | null
}

export interface ComparisonQuerySummary {
  id: number
  interface: string
  rdjb: string
  queriedAt: string
  status: string
  failureReason: string | null
  relationCount: number
}

export interface ComparisonPlatformEvidence {
  aliases: ComparisonAlias[]
  /** **当前**处置 = `recordedAt` 最新的那条(时态化,旧解释不丢但只展示最新)。 */
  disposition: ComparisonDisposition | null
  queries: ComparisonQuerySummary[]
  /** 归到该企业的关系总条数。 */
  relationCount: number
}

interface RowKey {
  enterpriseId: number
  titleCode: string
  direction: ComparisonDirection
}

/**
 * 给比对行附加库内平台证据。按 `enterpriseId` **批量取数**(不是每行一次查询),
 * 并只把「对得上 `(企业, 称号, 方向)`」的那条处置挂到行上。
 */
export function attachPlatformEvidence<T extends RowKey>(
  rows: T[],
  db: BetterSQLite3Database<typeof schema>,
): (T & { platform: ComparisonPlatformEvidence | null })[] {
  const enterpriseIds = [...new Set(rows.map((row) => row.enterpriseId))]
  if (!enterpriseIds.length) return rows.map((row) => ({ ...row, platform: null }))

  const aliases = db
    .select()
    .from(schema.enterpriseAlias)
    .where(inArray(schema.enterpriseAlias.enterpriseId, enterpriseIds))
    .orderBy(schema.enterpriseAlias.nameNorm)
    .all()

  const dispositions = db
    .select()
    .from(schema.differenceReason)
    .where(inArray(schema.differenceReason.enterpriseId, enterpriseIds))
    .all()

  const relationRows = db
    .select({
      queryId: schema.platformRelation.queryId,
      enterpriseId: schema.platformRelation.enterpriseId,
    })
    .from(schema.platformRelation)
    .where(inArray(schema.platformRelation.enterpriseId, enterpriseIds))
    .all()

  const queries = db
    .select()
    .from(schema.platformQuery)
    .where(
      enterpriseIds.length
        ? sql`${schema.platformQuery.id} in (select ${schema.platformRelation.queryId} from ${schema.platformRelation} where ${schema.platformRelation.enterpriseId} in ${enterpriseIds})`
        : sql`0`,
    )
    .all()

  const aliasesByEnterprise = new Map<number, ComparisonAlias[]>()
  for (const alias of aliases) {
    const item: ComparisonAlias = {
      id: alias.id,
      name: alias.name,
      nameNorm: alias.nameNorm,
      sourceKind: alias.sourceKind,
      sourceRefId: alias.sourceRefId,
      verificationStatus: alias.verificationStatus,
      validFrom: alias.validFrom,
      note: alias.note,
    }
    const bucket = aliasesByEnterprise.get(alias.enterpriseId)
    if (bucket) bucket.push(item)
    else aliasesByEnterprise.set(alias.enterpriseId, [item])
  }

  const relationsByQuery = new Map<number, number>()
  const relationsByEnterprise = new Map<number, number>()
  /** 查询 → 有关系归到它的企业集合(用于把查询摘要挂到每个相关企业上)。 */
  const enterprisesByQuery = new Map<number, Set<number>>()
  for (const row of relationRows) {
    relationsByQuery.set(row.queryId, (relationsByQuery.get(row.queryId) ?? 0) + 1)
    if (row.enterpriseId != null) {
      relationsByEnterprise.set(row.enterpriseId, (relationsByEnterprise.get(row.enterpriseId) ?? 0) + 1)
      const bucket = enterprisesByQuery.get(row.queryId)
      if (bucket) bucket.add(row.enterpriseId)
      else enterprisesByQuery.set(row.queryId, new Set([row.enterpriseId]))
    }
  }

  const queriesByEnterprise = new Map<number, ComparisonQuerySummary[]>()
  for (const query of queries) {
    const summary: ComparisonQuerySummary = {
      id: query.id,
      interface: query.interface,
      rdjb: query.rdjb,
      queriedAt: query.queriedAt,
      status: query.status,
      failureReason: query.failureReason,
      relationCount: relationsByQuery.get(query.id) ?? 0,
    }
    // 一个查询可能同时有关系归到多个企业;按关系归属逐个企业挂。
    for (const enterpriseId of enterprisesByQuery.get(query.id) ?? []) {
      const bucket = queriesByEnterprise.get(enterpriseId)
      if (bucket) bucket.push(summary)
      else queriesByEnterprise.set(enterpriseId, [summary])
    }
  }

  const latestDisposition = new Map<string, ComparisonDisposition>()
  for (const row of dispositions) {
    const key = `${row.enterpriseId}|${row.titleCode}|${row.direction}`
    const previous = latestDisposition.get(key)
    if (previous && previous.recordedAt >= row.recordedAt) continue
    latestDisposition.set(key, {
      id: row.id,
      status: row.status,
      reasonCode: row.reasonCode,
      reasonNote: row.reasonNote,
      measureCode: row.measureCode,
      measureNote: row.measureNote,
      movedIn: {
        city: row.movedInCity,
        titleCode: row.movedInTitleCode,
        year: row.movedInYear,
        batch: row.movedInBatch,
      },
      verificationStatus: row.verificationStatus,
      recordedAt: row.recordedAt,
      evidenceQueryId: row.evidenceQueryId,
      evidenceRelationId: row.evidenceRelationId,
    })
  }

  return rows.map((row) => {
    const rowAliases = aliasesByEnterprise.get(row.enterpriseId) ?? []
    const rowQueries = queriesByEnterprise.get(row.enterpriseId) ?? []
    const disposition = latestDisposition.get(`${row.enterpriseId}|${row.titleCode}|${row.direction}`) ?? null
    const relationCount = relationsByEnterprise.get(row.enterpriseId) ?? 0
    const empty = !rowAliases.length && !disposition && !rowQueries.length
    return {
      ...row,
      platform: empty ? null : { aliases: rowAliases, disposition, queries: rowQueries, relationCount },
    }
  })
}
