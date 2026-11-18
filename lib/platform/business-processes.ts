import type { PlatformBusinessMetadata } from './business-record'
import { z } from 'zod'
import { MAX_PAGE_SIZE } from '../../layers/sme-roster/lib/query-limits'

/** Local business_list (关联办理) queries. These read the source-specific typed projection, never raw JSON. */
export const BUSINESS_PROCESS_VIEWS = ['records', 'isolated'] as const
export type BusinessProcessView = (typeof BUSINESS_PROCESS_VIEWS)[number]

export const businessProcessFilterSchema = z.strictObject({
  view: z.enum(BUSINESS_PROCESS_VIEWS).default('records'),
  /** Enterprise name or USCC keyword; matched only through an assigned observation. */
  q: z.string().trim().min(1).max(200).optional(),
  enterpriseId: z.number().int().positive().optional(),
  /** Exact archived row-level rdjb string, independent of query scope. */
  titleRaw: z.string().min(1).max(200).optional(),
  /** Exact 办理编号 as archived; never normalized or merged across interfaces. */
  platformKey: z.string().trim().min(1).max(200).optional(),
  /** Explicit query title scope (rdjb 1/2/3) from the source query, never a per-row title fact. */
  rdjb: z.enum(['1', '2', '3']).optional(),
  /** Known source values are normalized to apply/update/review; unknown values stay raw. */
  declareKind: z.string().trim().min(1).max(200).optional(),
  /** Explicit source year only. */
  year: z.number().int().positive().optional(),
  /** Raw cszt value preserved by the typed projection. */
  status: z.string().trim().min(1).max(200).optional(),
  /** Raw whpc (维护批次) preserved by the typed projection. */
  batch: z.string().trim().min(1).max(200).optional(),
  page: z.number().int().positive().default(1),
  pageSize: z.number().int().min(1).max(MAX_PAGE_SIZE).default(25),
})
export type BusinessProcessFilter = z.infer<typeof businessProcessFilterSchema>

/** HTTP query strings are converted once, then validated by the same strict schema as MCP. */
export function businessProcessFilterFromQuery(raw: Record<string, unknown>): BusinessProcessFilter {
  const text = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : undefined
  const positive = (value: unknown, name: string) => {
    if (value === undefined || value === '') return undefined
    const parsed = Number(value)
    if (!Number.isSafeInteger(parsed) || parsed < 1) {
      throw Object.assign(new Error(`${name} must be a positive integer`), { statusCode: 400, code: 'invalid_business_process_filter' })
    }
    return parsed
  }
  const enterpriseId = positive(raw.enterpriseId, 'enterpriseId')
  const year = positive(raw.year, 'year')
  const page = positive(raw.page, 'page')
  const pageSize = positive(raw.pageSize, 'pageSize')
  const view = text(raw.view), rdjb = text(raw.rdjb)
  try {
    return businessProcessFilterSchema.parse({
      ...(view ? { view } : {}),
      ...(raw.titleRaw !== undefined ? { titleRaw: raw.titleRaw } : {}),
      ...(text(raw.q) ? { q: text(raw.q) } : {}),
      ...(enterpriseId != null ? { enterpriseId } : {}),
      ...(text(raw.platformKey) ? { platformKey: text(raw.platformKey) } : {}),
      ...(rdjb ? { rdjb } : {}),
      ...(text(raw.declareKind) ? { declareKind: text(raw.declareKind) } : {}),
      ...(year != null ? { year } : {}),
      ...(text(raw.status) ? { status: text(raw.status) } : {}),
      ...(text(raw.batch) ? { batch: text(raw.batch) } : {}),
      ...(page != null ? { page } : {}),
      ...(pageSize != null ? { pageSize } : {}),
    })
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw Object.assign(new Error('Invalid business process query parameters'), { statusCode: 400, code: 'invalid_business_process_filter' })
    }
    throw error
  }
}

export interface BusinessProcessVersionFields {
  versionId: number
  titleRaw?: string | null
  declareKind: string | null
  businessYear: number | null
  appliedAt: string | null
  status: string | null
  batch: string | null
  awardBatchLabel: string | null
  province: string | null
  nameRaw: string | null
  usccRaw: string | null
  ruleVersion: string | null
}

export interface BusinessProcessRecordRow {
  kind: 'record'
  record: { id: number; platformKey: string; interface: 'business_list' }
  matchedVersion: BusinessProcessVersionFields
  /** Number of content versions matching the current year/kind/status/batch/title conditions. */
  matchedVersionCount: number
  /** All content versions for this business identity, including non-matching history. */
  versionCount: number
  observationCount: number
  latestObservationAt: string | null
  enterpriseIds: number[]
  enterpriseNames: string[]
  /** Explicit query title scopes observed for this record; never a per-row title fact. */
  titleScopes: string[]
  conflicts: string[]
}

export interface BusinessProcessIsolatedRow {
  titleRaw?: string | null
  kind: 'observation'
  relationId: number
  queryId: number
  queriedAt: string
  queryKey: string
  queryStatus: string
  sequenceNo: number
  identityState: PlatformBusinessMetadata['identityState']
  contentState: PlatformBusinessMetadata['contentState']
  nameRaw: string | null
  usccRaw: string | null
  declareKind: string | null
  businessYear: number | null
  appliedAt: string | null
  status: string | null
  batch: string | null
  awardBatchLabel: string | null
  province: string | null
  titleScopes: string[]
  enterpriseId: number | null
  enterpriseName: string | null
}

export type BusinessProcessRow = BusinessProcessRecordRow | BusinessProcessIsolatedRow

export interface BusinessProcessListResult {
  view: BusinessProcessView
  rows: BusinessProcessRow[]
  total: number
  page: number
  pageSize: number
}

/** Observation-scoped decision reference. Never copies a decision to other observations. */
export interface BusinessProcessCorrespondenceRef {
  id: number
  status: string
  revision: number
}

export interface BusinessProcessObservation {
  relationId: number
  queryId: number
  queriedAt: string
  queryKey: string
  queryStatus: string
  sequenceNo: number
  enterpriseId: number | null
  enterpriseName: string | null
  identityState: 'resolved' | 'missing_key' | 'conflict'
  contentState: 'verified' | 'unverifiable'
  keySource: 'relation_key' | 'raw_id' | 'both' | 'none'
  projectionRuleVersion: string
  versionId: number | null
  /** Explicit query title scopes for this observation; query fact, not a row title. */
  titleScopes: string[]
  /** Original correspondence decisions for this exact observation only; IDs/status, no content. */
  correspondenceRefs: BusinessProcessCorrespondenceRef[]
  version: BusinessProcessVersionFields | null
}

export interface BusinessProcessVersion extends BusinessProcessVersionFields {
  hashAlgorithm: string
  contentHash: string
  createdAt: string
  observationCount: number
  firstObservedAt: string | null
  lastObservedAt: string | null
  titleScopes: string[]
}

export interface BusinessProcessDetail {
  record: { id: number; platformKey: string; interface: 'business_list'; identityRuleVersion: string; createdAt: string }
  versions: BusinessProcessVersion[]
  observations: BusinessProcessObservation[]
  counts: { versions: number; observations: number; versionsTruncated: boolean; observationsTruncated: boolean }
}

export const BUSINESS_PROCESS_VERSION_LIMIT = 100
export const BUSINESS_PROCESS_OBSERVATION_LIMIT = 200
