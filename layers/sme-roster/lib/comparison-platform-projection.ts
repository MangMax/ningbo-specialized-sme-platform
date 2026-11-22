import type { PlatformCollectionCoverage, PlatformStoredQuery, PlatformStoredRelation } from './platform/read'
import type { PlatformObservationFact } from './platform/observation-facts'
import { sourcePositionForSequence } from './platform/recognized-evidence'
import type { PlatformNormalizationConflict } from './platform/normalization'
import type { publicVersion102 } from '../server/utils/decision-lifecycle-102/contract'
import type { ComparisonDirection } from './comparison-model'
import { normalizeUscc } from './domain'

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
  /**
   * 存下来的解释行 id;**`null` = 还没有解释记录** —— 此时 `status` 就是状态机的
   * 默认态 `not_queried`(与 `layers/sme-roster/lib/roster/enterprise-roster.ts` 的 `explanationId` 同义)。
   */
  explanationId: number | null
  status: string
  reasonCode: string | null
  reasonNote: string | null
  measureCode: string | null
  measureNote: string | null
  movedIn: { city: string | null; titleCode: string | null; year: number | null; batch: number | null } | null
  verificationStatus: string
  /** 该解释的登记时点;没有解释记录时为 `null`。 */
  recordedAt: string | null
  evidenceQueryId: number | null
  evidenceRelationId: number | null
}

/** 一条**平台原始关系**(`platform_relation`)—— 可展开的接口证据原文。 */
export interface ComparisonRelation {
  normalizationConflicts?: PlatformNormalizationConflict[]
  enterpriseId?: number | null
  rawFields?: Record<string, unknown> | null
  sourceRdjb?: string | null
  sourcePage?: number | null
  id: number
  queryId: number
  sequenceNo: number
  relationKey: string | null
  usccRaw: string | null
  nameRaw: string | null
  aliasNameRaw: string | null
  province: string | null
  status: string | Buffer | null
  batch: string | null
  declareKind: string | null
  appliedAt: string | null
  awardBatchLabel: string | null
  year: number | null
  matchBasis: string
  verificationStatus: string
}

export interface ComparisonQuerySummary {
  collectionEvidence?: PlatformCollectionCoverage | null
  titleCode?: string | null
  id: number
  interface: string
  queryKey: string
  rdjb: string
  queriedAt: string
  status: string
  failureReason: string | null
  relationCount: number
  /** 这次查询返回的**全部**关系(逐条原文;不按企业二次过滤 —— 查询本身就是证据)。 */
  relations: ComparisonRelation[]
}

export interface ComparisonPlatformEvidence {
  aliases: ComparisonAlias[]
  /**
   * **当前**处置 = `recordedAt` 最新的那条(时态化,旧解释不丢但只展示最新)。
   * 没有解释记录时也给一条:状态即状态机的默认态 `not_queried`。
   */
  disposition: ComparisonDisposition
  queries: ComparisonQuerySummary[]
  /** Included queries' original source-row count, independent of confirmed ownership. */
  relationCount: number
}

export interface RowKey {
  enterpriseId: number
  titleCode: string
  direction: ComparisonDirection
}

/**
 * 给比对行附加库内平台证据。按 `enterpriseId` **批量取数**(不是每行一次查询),
 * 并只把「对得上 `(企业, 称号, 方向)`」的那条处置挂到行上。
 *
 * **每一行都返回 `platform`**(永不为 `null`):没有解释记录时,处置就是状态机的
 * 默认态 `not_queried` + `explanationId: null`。页面因此不会再有「整列 —」的观感。
 */
export type ComparisonObservation = Pick<PlatformObservationFact, 'archiveProcessFacts' | 'normalizationConflicts'>
type StoredDisposition = Parameters<typeof publicVersion102>[0]

export function projectPlatformComparisonEvidence<T extends RowKey>(rows: T[],
  aliases: readonly (ComparisonAlias & { enterpriseId: number })[],
  dispositions: readonly StoredDisposition[], queriedEnterpriseByKey: ReadonlyMap<string, number[]>,
  queries: readonly PlatformStoredQuery[], relationRows: readonly PlatformStoredRelation[],
  facts: ReadonlyMap<number, ComparisonObservation>,
): (T & { platform: ComparisonPlatformEvidence })[] {
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

  const queryById = new Map(queries.map(query => [query.id, query]))
  const toRelation = (archived: PlatformStoredRelation): ComparisonRelation => {
    const query = queryById.get(archived.queryId)
    const fact = facts.get(archived.id)
    if (!fact?.archiveProcessFacts) throw new Error(`missing_archive_process_facts:${archived.id}`)
    const row = { ...archived, ...fact.archiveProcessFacts, normalizationConflicts: fact.normalizationConflicts }
    return {
      ...(query?.interface === 'recognized_list' ? { enterpriseId: row.enterpriseId } : {}),
      normalizationConflicts: row.normalizationConflicts,
      id: row.id,
      queryId: row.queryId,
      sequenceNo: row.sequenceNo,
      relationKey: row.relationKey,
      rawFields: row.rawFields,
      ...sourcePositionForSequence(query?.collectionEvidence, row.sequenceNo),
      usccRaw: row.usccRaw,
      nameRaw: row.nameRaw,
      aliasNameRaw: row.aliasNameRaw,
      province: row.province,
      status: row.status,
      batch: row.batch,
      declareKind: row.declareKind,
      appliedAt: row.appliedAt,
      awardBatchLabel: row.awardBatchLabel,
      year: row.year,
      matchBasis: row.matchBasis,
      verificationStatus: row.verificationStatus,
    }
  }

  const relationsByQuery = new Map<number, ComparisonRelation[]>()
  /** 查询 → 有关系归到它的企业集合(用于把查询摘要挂到每个相关企业上)。 */
  const enterprisesByQuery = new Map<number, Set<number>>()
  for (const row of relationRows) {
    const list = relationsByQuery.get(row.queryId)
    if (list) list.push(toRelation(row))
    else relationsByQuery.set(row.queryId, [toRelation(row)])
    if (row.enterpriseId != null) {
      const bucket = enterprisesByQuery.get(row.queryId)
      if (bucket) bucket.add(row.enterpriseId)
      else enterprisesByQuery.set(row.queryId, new Set([row.enterpriseId]))
    }
  }

  const queriesByEnterprise = new Map<number, ComparisonQuerySummary[]>()
  for (const query of queries) {
    const relations = relationsByQuery.get(query.id) ?? []
    const summary: ComparisonQuerySummary = {
      id: query.id,
      interface: query.interface,
      queryKey: query.queryKey,
      rdjb: query.rdjb,
      queriedAt: query.queriedAt,
      collectionEvidence: query.collectionEvidence,
      titleCode: query.titleCode,
      status: query.status,
      failureReason: query.failureReason,
      relationCount: relations.length,
      relations,
    }
    // 一个查询可能同时有关系归到多个企业;按关系归属逐个企业挂。
    const owners = new Set<number>(enterprisesByQuery.get(query.id) ?? [])
    // 再加上「查询键就是它」的企业 —— 没有关系的那种查询靠这一条才挂得上。
    for (const enterpriseId of queriedEnterpriseByKey.get(query.queryKey) ?? queriedEnterpriseByKey.get(normalizeUscc(query.queryKey) || query.queryKey) ?? []) {
      owners.add(enterpriseId)
    }
    for (const enterpriseId of owners) {
      const bucket = queriesByEnterprise.get(enterpriseId)
      if (bucket) bucket.push(summary)
      else queriesByEnterprise.set(enterpriseId, [summary])
    }
  }

  const latestDisposition = new Map<string, ComparisonDisposition>()
  for (const row of dispositions) {
    const key = `${row.enterpriseId}|${row.titleCode}|${row.direction}`
    const previous = latestDisposition.get(key)
    if (previous && previous.recordedAt != null && previous.recordedAt >= row.recordedAt) continue
    latestDisposition.set(key, {
      explanationId: row.id,
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

  /**
   * 没有解释记录时的处置:**状态机的默认态**(契约 §3.2 的 `not_queried`)。
   * 这里**不**看查询、不看关系 —— 展示态只从 `difference_reason.status` 取。
   */
  const defaultDisposition: ComparisonDisposition = {
    explanationId: null,
    status: 'not_queried',
    reasonCode: null,
    reasonNote: null,
    measureCode: null,
    measureNote: null,
    movedIn: null,
    verificationStatus: 'pending',
    recordedAt: null,
    evidenceQueryId: null,
    evidenceRelationId: null,
  }

  return rows.map((row) => {
    const rowAliases = aliasesByEnterprise.get(row.enterpriseId) ?? []
    const rowQueries = queriesByEnterprise.get(row.enterpriseId) ?? []
    const disposition =
      latestDisposition.get(`${row.enterpriseId}|${row.titleCode}|${row.direction}`) ?? defaultDisposition
    const relationCount = rowQueries.reduce((count, query) => count + query.relations.length, 0)
    return {
      ...row,
      platform: { aliases: rowAliases, disposition, queries: rowQueries, relationCount },
    }
  })
}
