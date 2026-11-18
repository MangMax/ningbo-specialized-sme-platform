/** Collection/observation evidence read model; public IDs use retained aliases. */
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type * as schema from '../../db/schema'
import type { PlatformInterface } from '../../layers/sme-roster/lib/labels'
import type { PlatformNormalizationConflict } from './normalization'
import type { LegacyProvenanceDisplay } from './legacy-provenance'
import { listTargetPlatformQueries } from './target-query-read'
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

/** Stable public source snapshot. IDs are external aliases, never runtime table keys. */
export type PlatformStoredQuery = Pick<typeof schema.platformCollection.$inferSelect,
  'id'|'interface'|'queryKey'|'rdjb'|'titleCode'|'queriedAt'|'lastCollectedAt'|'status'|'failureReason'|'createdAt'> & {
  rawResponse: string | null
  collectionEvidence: import('./live-query').PlatformLiveQueryResult | null
}
export interface PlatformStoredRelation {
  id: number; queryId: number; sequenceNo: number; relationKey: string | null; enterpriseId: number | null
  rawFields: Record<string, unknown> | null; titleRaw: string | null; sourceText: string | null
  usccRaw: string | null; nameRaw: string | null; aliasNameRaw: string | null; province: string | null
  status: string | Buffer | null; batch: string | null; declareKind: string | null; appliedAt: string | null
  awardBatchLabel: string | null; year: number | null
  matchBasis: typeof schema.platformObservationAssignment.$inferSelect.matchBasis
  verificationStatus: typeof schema.platformObservationAssignment.$inferSelect.verificationStatus
  createdAt: string
}

export interface PlatformRelationRow<I extends PlatformInterface = PlatformInterface> {
  normalizationConflicts?: PlatformNormalizationConflict[]
  /** Historical page values are displayed as captured, including noncanonical types. */
  sourceRdjb?: unknown
  sourcePage?: unknown
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
  status: I extends 'business_list' ? string | Buffer | null : string | null
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
    legacyProvenance?: LegacyProvenanceDisplay
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

export function listPlatformQueries(db: BetterSQLite3Database<typeof schema>, filter: PlatformQueryFilter = {}): PlatformQueriesResult {
  return listTargetPlatformQueries(db, filter)
}
