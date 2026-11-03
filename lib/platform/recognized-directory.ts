import { z } from 'zod'
import { MAX_PAGE_SIZE } from '../query'

/** Read-only local queries over the recognized_list (upstream queryBusList, 平台认定目录)
 * source-specific typed projection. Never raw JSON, never a second qualification model. */
export const RECOGNIZED_DIRECTORY_VIEWS = ['records', 'isolated'] as const
export type RecognizedDirectoryView = (typeof RECOGNIZED_DIRECTORY_VIEWS)[number]

/** Navigation-only mirror of RDJB_TITLE_CODES for the /current-enterprises entry.
 * It never decides qualification; the existing current-enterprises reader does. */
export const RECOGNIZED_TITLE_CODE_BY_RDJB: Record<string, string> = {
  '1': 'innovative_sme',
  '2': 'specialized_sme',
  '3': 'little_giant',
}

export const recognizedDirectoryFilterSchema = z.strictObject({
  view: z.enum(RECOGNIZED_DIRECTORY_VIEWS).default('records'),
  /** Enterprise name or USCC keyword; matched only through an assigned observation. */
  q: z.string().trim().min(1).max(200).optional(),
  enterpriseId: z.number().int().positive().optional(),
  /** Exact directory business id (platform_business_record.platform_key); never merged across interfaces. */
  platformKey: z.string().trim().min(1).max(200).optional(),
  /** Explicit query title scope (rdjb 1/2/3) from the source query, never a per-row title fact. */
  rdjb: z.enum(['1', '2', '3']).optional(),
  /** Raw rddqrq (有效期原值) matched by exact string equality; never parsed into a date. */
  rddqrq: z.string().trim().min(1).max(200).optional(),
  /** Explicit positive integer source whpcyear only. */
  whpcyear: z.number().int().positive().optional(),
  /** Raw whpc (维护批次) matched by exact string equality. */
  whpc: z.string().trim().min(1).max(200).optional(),
  /** Raw szq (属地) matched by exact string equality. */
  szq: z.string().trim().min(1).max(200).optional(),
  page: z.number().int().positive().default(1),
  pageSize: z.number().int().min(1).max(MAX_PAGE_SIZE).default(25),
})
export type RecognizedDirectoryFilter = z.infer<typeof recognizedDirectoryFilterSchema>

const QUERY_KEYS = new Set([
  'view', 'q', 'enterpriseId', 'platformKey', 'rdjb', 'rddqrq', 'whpcyear', 'whpc', 'szq', 'page', 'pageSize',
])

/** HTTP query strings are converted once, then validated by the same strict schema as MCP. */
export function recognizedDirectoryFilterFromQuery(raw: Record<string, unknown>): RecognizedDirectoryFilter {
  const invalid = (message: string): never => {
    throw Object.assign(new Error(message), { statusCode: 400, code: 'invalid_recognized_directory_filter' })
  }
  const unknown = Object.keys(raw).filter(key => !QUERY_KEYS.has(key))
  if (unknown.length) invalid(`Unknown recognized directory query parameters: ${unknown.sort().join(', ')}`)
  const text = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : undefined
  const positive = (value: unknown, name: string) => {
    if (value === undefined || value === '') return undefined
    const parsed = Number(value)
    if (!Number.isSafeInteger(parsed) || parsed < 1) invalid(`${name} must be a positive integer`)
    return parsed
  }
  const enterpriseId = positive(raw.enterpriseId, 'enterpriseId')
  const whpcyear = positive(raw.whpcyear, 'whpcyear')
  const page = positive(raw.page, 'page')
  const pageSize = positive(raw.pageSize, 'pageSize')
  const input: Record<string, unknown> = {}
  const view = text(raw.view)
  if (view) input.view = view
  if (text(raw.q)) input.q = text(raw.q)
  if (enterpriseId != null) input.enterpriseId = enterpriseId
  if (text(raw.platformKey)) input.platformKey = text(raw.platformKey)
  const rdjb = text(raw.rdjb)
  if (rdjb) input.rdjb = rdjb
  if (text(raw.rddqrq)) input.rddqrq = text(raw.rddqrq)
  if (whpcyear != null) input.whpcyear = whpcyear
  if (text(raw.whpc)) input.whpc = text(raw.whpc)
  if (text(raw.szq)) input.szq = text(raw.szq)
  if (page != null) input.page = page
  if (pageSize != null) input.pageSize = pageSize
  const parsed = recognizedDirectoryFilterSchema.safeParse(input)
  if (parsed.success) return parsed.data
  return invalid('Invalid recognized directory query parameters')
}

export interface RecognizedDirectoryVersionFields {
  versionId: number
  /** Raw rddqrq (有效期原值); never parsed into a date or year. */
  validityDateRaw: string | null
  /** Explicit positive integer source whpcyear only. */
  maintenanceYear: number | null
  /** Raw whpc (维护批次). */
  maintenanceBatch: string | null
  /** Raw szq (属地原值/代码). */
  district: string | null
  /** Raw rdxx (平台认定说明). */
  awardNote: string | null
  /** Raw row-level rdjb; the query title scope is a separate fact. */
  titleRaw: string | null
  nameRaw: string | null
  usccRaw: string | null
  ruleVersion: string | null
}

export interface RecognizedDirectoryRecordRow {
  kind: 'record'
  record: { id: number; platformKey: string; interface: 'recognized_list' }
  matchedVersion: RecognizedDirectoryVersionFields
  /** Number of content versions matching the current validity/year/batch/district/title conditions. */
  matchedVersionCount: number
  /** All content versions for this directory business identity, including non-matching history. */
  versionCount: number
  observationCount: number
  latestObservationAt: string | null
  enterpriseIds: number[]
  enterpriseNames: string[]
  /** Explicit query title scopes observed for this record; never a per-row title fact. */
  titleScopes: string[]
  conflicts: string[]
}

export interface RecognizedDirectoryIsolatedRow {
  kind: 'observation'
  relationId: number
  queryId: number
  queriedAt: string
  queryKey: string
  queryStatus: string
  sequenceNo: number
  identityState: 'resolved' | 'missing_key' | 'conflict'
  contentState: 'verified' | 'unverifiable'
  nameRaw: string | null
  usccRaw: string | null
  titleScopes: string[]
  enterpriseId: number | null
  enterpriseName: string | null
}

export type RecognizedDirectoryRow = RecognizedDirectoryRecordRow | RecognizedDirectoryIsolatedRow

export interface RecognizedDirectoryListResult {
  view: RecognizedDirectoryView
  rows: RecognizedDirectoryRow[]
  total: number
  page: number
  pageSize: number
}

/** Observation-scoped decision reference. Never copies a decision to other observations. */
export interface RecognizedDirectoryCorrespondenceRef {
  id: number
  status: string
  revision: number
}

export interface RecognizedDirectoryObservation {
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
  /** True only when a known row-level rdjb contradicts the explicit query scope. */
  titleConflict: boolean
  /** Original correspondence decisions for this exact observation only; IDs/status, no content. */
  correspondenceRefs: RecognizedDirectoryCorrespondenceRef[]
  version: RecognizedDirectoryVersionFields | null
}

export interface RecognizedDirectoryVersion extends RecognizedDirectoryVersionFields {
  hashAlgorithm: string
  contentHash: string
  createdAt: string
  observationCount: number
  firstObservedAt: string | null
  lastObservedAt: string | null
  titleScopes: string[]
}

export interface RecognizedDirectoryDetail {
  record: { id: number; platformKey: string; interface: 'recognized_list'; identityRuleVersion: string; createdAt: string }
  versions: RecognizedDirectoryVersion[]
  observations: RecognizedDirectoryObservation[]
  counts: { versions: number; observations: number; versionsTruncated: boolean; observationsTruncated: boolean }
  /** Record-level structured conflicts; never a qualification decision. */
  conflicts: string[]
}

export const RECOGNIZED_DIRECTORY_VERSION_LIMIT = 100
export const RECOGNIZED_DIRECTORY_OBSERVATION_LIMIT = 200
