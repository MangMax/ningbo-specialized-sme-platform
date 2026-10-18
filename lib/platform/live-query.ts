/** Public, source-specific live-query contract. No stored identity or business mutations. */
import { z } from 'zod'
import type { PlatformRow } from './adapter'

export const PLATFORM_QUERY_SOURCES = ['queryList', 'businessList', 'queryBusList'] as const
export type PlatformQuerySource = typeof PLATFORM_QUERY_SOURCES[number]
export const platformQueryInputShape = {
  source: z.enum(PLATFORM_QUERY_SOURCES),
  name: z.string().trim().min(1).max(200).optional(),
  uscc: z.string().trim().regex(/^[0-9A-Z]{18}$/).optional(),
  pageSize: z.number().int().min(1).max(50).default(50),
  startPage: z.number().int().min(1).max(100000).default(1),
  maxRequests: z.number().int().min(1).max(100).default(100),
  maxRows: z.number().int().min(1).max(5000).default(5000),
  maxDurationMs: z.number().int().min(1).max(60000).default(60000),
}
export const platformQueryInputSchema = z.strictObject(platformQueryInputShape)
export type PlatformLiveQueryInput = z.infer<typeof platformQueryInputSchema>
export type PlatformQueryStatus = 'success' | 'no_record' | 'auth_failed' | 'failed' | 'partial' | 'not_queried'
export interface PlatformQueryError {
  code: 'invalid_input' | 'unsupported_source' | 'credential_unavailable' | 'auth_failed' | 'upstream_failed' | 'timeout' | 'rate_limited' | 'safety_limit' | 'invalid_response' | 'sensitive_response'
  message: string
}
export interface PlatformQueryPosition { source: PlatformQuerySource; rdjb: string | null; page: number }
export interface PlatformQueryPage extends PlatformQueryPosition {
  status: 'success' | 'auth_failed' | 'failed'
  fetchedCount: number
  declaredTotal: number | null
  error: PlatformQueryError | null
}
export interface PlatformLiveQueryResult {
  source: PlatformQuerySource
  status: PlatformQueryStatus
  effectiveConditions: { name?: string; uscc?: string; combination: 'and' }
  titleScope: { mode: 'source_default' | 'selected'; rdjb: string[] }
  queriedAt: string
  completedAt: string
  rows: PlatformRow[]
  pages: PlatformQueryPage[]
  fetchedCount: number
  declaredTotal: number | null
  completeness: 'complete' | 'partial' | 'not_queried'
  /** False for a continuation starting after page one; completion is for requested range only. */
  fullRange: boolean
  unfinished: PlatformQueryPosition[]
  error: PlatformQueryError | null
  limits: { maxRequests: number; maxRows: number; maxDurationMs: number; pageSize: number }
}
export const platformQueryCapabilities = {
  version: 1,
  sources: {
    queryList: { available: true, meaning: '申报记录', conditions: ['name', 'uscc'], combination: 'and', nameMatch: 'platform_keyword', titleSelection: false, defaultRestrictions: [], pagination: true },
    businessList: { available: false, meaning: '关联记录', conditions: ['uscc'], titleSelection: true },
    queryBusList: { available: false, meaning: '已认定企业列表', conditions: [], titleSelection: false },
  },
  limits: { maxConcurrentRequests: 2, maxRequests: 100, maxRows: 5000, maxDurationMs: 60000, maxPageSize: 50 },
  cache: 'disabled',
  credentialInput: false,
} as const

const queryErrorSchema = z.object({
  code: z.enum(['invalid_input', 'unsupported_source', 'credential_unavailable', 'auth_failed', 'upstream_failed', 'timeout', 'rate_limited', 'safety_limit', 'invalid_response', 'sensitive_response']),
  message: z.string(),
}).nullable()
const positionShape = { source: z.enum(PLATFORM_QUERY_SOURCES), rdjb: z.string().nullable(), page: z.number().int().positive() }
/** Toolkit output schema is discoverable in tools/list; REST mirrors this in static route metadata. */
export const platformQueryResultShape = {
  source: z.enum(PLATFORM_QUERY_SOURCES), status: z.enum(['success', 'no_record', 'auth_failed', 'failed', 'partial', 'not_queried']),
  effectiveConditions: z.object({ name: z.string().optional(), uscc: z.string().optional(), combination: z.literal('and') }),
  titleScope: z.object({ mode: z.enum(['source_default', 'selected']), rdjb: z.array(z.string()) }),
  queriedAt: z.string(), completedAt: z.string(), rows: z.array(z.record(z.string(), z.string())),
  pages: z.array(z.object({ ...positionShape, status: z.enum(['success', 'auth_failed', 'failed']), fetchedCount: z.number().int().nonnegative(), declaredTotal: z.number().int().nonnegative().nullable(), error: queryErrorSchema })),
  fetchedCount: z.number().int().nonnegative(), declaredTotal: z.number().int().nonnegative().nullable(),
  completeness: z.enum(['complete', 'partial', 'not_queried']), fullRange: z.boolean(),
  unfinished: z.array(z.object(positionShape)), error: queryErrorSchema,
  limits: z.object({ maxRequests: z.number(), maxRows: z.number(), maxDurationMs: z.number(), pageSize: z.number() }),
}
