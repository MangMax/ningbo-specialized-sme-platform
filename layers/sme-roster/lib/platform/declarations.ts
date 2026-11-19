import type { PlatformBusinessMetadata } from './business-record'
import { z } from 'zod'
import { MAX_PAGE_SIZE } from '../query-limits'

/** Local declaration queries. These read the source-specific typed projection, never raw JSON. */
export const DECLARATION_VIEWS = ['records', 'isolated'] as const
export type DeclarationView = (typeof DECLARATION_VIEWS)[number]

export const declarationFilterSchema = z.strictObject({
  view: z.enum(DECLARATION_VIEWS).default('records'),
  /** Enterprise name or USCC keyword; matched only through an assigned observation. */
  q: z.string().trim().min(1).max(200).optional(),
  enterpriseId: z.number().int().positive().optional(),
  /** Exact archived row-level rdjb string, independent of query scope. */
  titleRaw: z.string().min(1).max(200).optional(),
  /** Exact 申报编号 as archived; never normalized or merged across interfaces. */
  platformKey: z.string().trim().min(1).max(200).optional(),
  /** Known source values are normalized to apply/update/review; unknown values stay raw. */
  declareKind: z.string().trim().min(1).max(200).optional(),
  /** Explicit source year only. */
  year: z.number().int().positive().optional(),
  /** Raw cszt value preserved by the typed projection. */
  status: z.string().trim().min(1).max(200).optional(),
  page: z.number().int().positive().default(1),
  pageSize: z.number().int().min(1).max(MAX_PAGE_SIZE).default(25),
})
export type DeclarationFilter = z.infer<typeof declarationFilterSchema>

/** HTTP query strings are converted once, then validated by the same strict schema as MCP. */
export function declarationFilterFromQuery(raw: Record<string, unknown>): DeclarationFilter {
  const text = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : undefined
  const positive = (value: unknown, name: string) => {
    if (value === undefined || value === '') return undefined
    const parsed = Number(value)
    if (!Number.isSafeInteger(parsed) || parsed < 1) {
      throw Object.assign(new Error(`${name} must be a positive integer`), { statusCode: 400, code: 'invalid_declaration_filter' })
    }
    return parsed
  }
  const enterpriseId = positive(raw.enterpriseId, 'enterpriseId')
  const year = positive(raw.year, 'year')
  const page = positive(raw.page, 'page')
  const pageSize = positive(raw.pageSize, 'pageSize')
  const view = text(raw.view)
  try {
    return declarationFilterSchema.parse({
      ...(view ? { view } : {}),
      ...(raw.titleRaw !== undefined ? { titleRaw: raw.titleRaw } : {}),
      ...(text(raw.q) ? { q: text(raw.q) } : {}),
      ...(enterpriseId != null ? { enterpriseId } : {}),
      ...(text(raw.platformKey) ? { platformKey: text(raw.platformKey) } : {}),
      ...(text(raw.declareKind) ? { declareKind: text(raw.declareKind) } : {}),
      ...(year != null ? { year } : {}),
      ...(text(raw.status) ? { status: text(raw.status) } : {}),
      ...(page != null ? { page } : {}),
      ...(pageSize != null ? { pageSize } : {}),
    })
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw Object.assign(new Error('Invalid declaration query parameters'), { statusCode: 400, code: 'invalid_declaration_filter' })
    }
    throw error
  }
}

export interface DeclarationVersionFields {
  versionId: number
  titleRaw?: string | null
  declareKind: string | null
  declarationYear: number | null
  appliedAt: string | null
  status: string | null
  nameRaw: string | null
  usccRaw: string | null
  ruleVersion: string | null
}

export interface DeclarationRecordRow {
  kind: 'record'
  record: { id: number; platformKey: string; interface: 'apply_list' }
  matchedVersion: DeclarationVersionFields
  /** Number of content versions matching the current year/kind/status conditions. */
  matchedVersionCount: number
  /** All content versions for this business identity, including non-matching history. */
  versionCount: number
  observationCount: number
  latestObservationAt: string | null
  enterpriseIds: number[]
  enterpriseNames: string[]
  conflicts: string[]
}

export interface DeclarationIsolatedRow {
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
  declarationYear: number | null
  appliedAt: string | null
  status: string | null
  enterpriseId: number | null
  enterpriseName: string | null
}

export type DeclarationRow = DeclarationRecordRow | DeclarationIsolatedRow

export interface DeclarationListResult {
  view: DeclarationView
  rows: DeclarationRow[]
  total: number
  page: number
  pageSize: number
}

export interface DeclarationObservation {
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
  keySource: string
  projectionRuleVersion: string
  versionId: number | null
  version: DeclarationVersionFields | null
}

export interface DeclarationVersion extends DeclarationVersionFields {
  hashAlgorithm: string
  contentHash: string
  createdAt: string
  observationCount: number
  firstObservedAt: string | null
  lastObservedAt: string | null
}

export interface DeclarationDetail {
  record: { id: number; platformKey: string; interface: 'apply_list'; identityRuleVersion: string; createdAt: string }
  versions: DeclarationVersion[]
  observations: DeclarationObservation[]
  counts: {
    versions: number
    observations: number
    versionsTruncated: boolean
    observationsTruncated: boolean
  }
}

export const DECLARATION_VERSION_LIMIT = 100
export const DECLARATION_OBSERVATION_LIMIT = 200
