/** Public, source-specific live-query contract. No stored identity or business mutations. */
import { z } from 'zod'
import type { PlatformRow, PlatformRawRow, PlatformJsonValue } from './adapter'

export const PLATFORM_QUERY_SOURCES = ['queryList', 'businessList', 'queryBusList'] as const
export type PlatformQuerySource = typeof PLATFORM_QUERY_SOURCES[number]
const year = z.string().regex(/^\d{4}$/)
const dateRange = z.string().regex(/^\d{4}\/\d{2}\/\d{2} - \d{4}\/\d{2}\/\d{2}$/).refine(value => {
  const dates = value.split(' - ')
  return dates.length === 2 && dates.every(date => {
    const [y, m, d] = date.split('/').map(Number)
    const parsed = new Date(0)
    parsed.setUTCFullYear(y!, m! - 1, d!)
    return parsed.getUTCFullYear() === y && parsed.getUTCMonth() === m! - 1 && parsed.getUTCDate() === d
  }) && dates[0]! <= dates[1]!
})
export const recognizedConditionShape = {
  sqsj: dateRange.optional(), rddqrq: year.optional(), whpcyear: year.optional(),
  whpc: z.string().regex(/^(?:[1-9]|1[0-5])$/).optional(),
  // Filter codes are distinct from returned row szq values. No global dictionary implied.
  szq: z.string().regex(/^\d{8}$/).optional(),
  orderField: z.literal('qymc').optional(), orderDirection: z.enum(['asc', 'desc']).optional(),
}
export const platformQueryInputShape = {
  source: z.enum(PLATFORM_QUERY_SOURCES),
  /** Explicit expand-compat opt-in; existing consumers retain their payload. */
  rawDataVersion: z.literal(1).optional(),
  ...recognizedConditionShape,
  name: z.string().trim().min(1).max(200).optional(),
  uscc: z.string().trim().regex(/^[0-9A-Z]{18}$/).optional(),
  rdjb: z.union([z.enum(['1', '2', '3', 'all']), z.array(z.enum(['1', '2', '3'])).min(1).max(3).refine(values => new Set(values).size === values.length)]).optional(),
  pageSize: z.number().int().min(1).max(50).default(50),
  startPage: z.number().int().min(1).max(100000).default(1),
  maxRequests: z.number().int().min(1).max(100).default(100),
  maxRows: z.number().int().min(1).max(5000).default(5000),
  maxDurationMs: z.number().int().min(1).max(60000).default(60000),
}
/** Source conditions are checked both here and on original MCP arguments before SDK stripping. */
const queryInputObject = z.strictObject(platformQueryInputShape)
export function validRecognizedConditionPairing(q: { whpc?: string; whpcyear?: string; orderField?: string; orderDirection?: string }): boolean {
  return (!q.whpc || !!q.whpcyear) && Boolean(q.orderField) === Boolean(q.orderDirection)
}
export function validPlatformQueryConditions(q: z.infer<typeof queryInputObject>): boolean {
  const hasRecognizedConditions = Object.keys(recognizedConditionShape).some(key => q[key as keyof typeof q] !== undefined)
  if (q.source === 'businessList') return !!q.uscc && q.name === undefined && typeof q.rdjb === 'string' && !hasRecognizedConditions && (q.rdjb !== 'all' || q.startPage === 1)
  if (!q.name && !q.uscc) return false
  if (q.source === 'queryList') return q.rdjb === undefined && !hasRecognizedConditions
  return (q.rdjb === undefined || Array.isArray(q.rdjb)) && validRecognizedConditionPairing(q)
}
export const platformQueryInputSchema = queryInputObject.refine(validPlatformQueryConditions, { message: 'Invalid conditions for platform source' })
export type PlatformLiveQueryInput = z.infer<typeof platformQueryInputSchema>
/** One source of truth for selected title traversal, including unqueried batches. */
export function platformQueryTitles(q: PlatformLiveQueryInput): (string | null)[] {
  if (q.source === 'businessList') return q.rdjb === 'all' ? ['1', '2', '3'] : [q.rdjb as string]
  if (q.source === 'queryBusList') return (q.rdjb as string[] | undefined) ?? ['1', '2', '3']
  return [null]
}

export type PlatformQueryStatus = 'success' | 'no_record' | 'auth_failed' | 'failed' | 'partial' | 'not_queried'
export interface PlatformQueryError {
  code: 'invalid_input' | 'unsupported_source' | 'credential_unavailable' | 'auth_failed' | 'upstream_failed' | 'timeout' | 'rate_limited' | 'safety_limit' | 'invalid_response' | 'sensitive_response'
  message: string
}
export interface PlatformQueryPosition { source: PlatformQuerySource; rdjb: string | null; page: number }
export interface PlatformRawData {
  version: 1
  rows: PlatformRawRow[]
  pages: (PlatformQueryPosition & { format: 'json' | 'html-script' | 'html-table'; body: string })[]
}
export interface PlatformQueryPage extends PlatformQueryPosition {
  /** 原响应声明的末页；旧归档可缺省，未知留 null。 */
  maxPage?: number | null
  status: 'success' | 'auth_failed' | 'failed'
  fetchedCount: number
  declaredTotal: number | null
  error: PlatformQueryError | null
}
export interface PlatformLiveQueryResult {
  source: PlatformQuerySource
  status: PlatformQueryStatus
  effectiveConditions: { name?: string; uscc?: string; combination: 'and' } & Partial<Record<keyof typeof recognizedConditionShape, string>>
  titleScope: { mode: 'source_default' | 'selected'; rdjb: string[] }
  queriedAt: string
  completedAt: string
  rows: PlatformRow[]
  /** Additive raw observation v1. Absent on historical string-only results. */
  dataRows?: PlatformRawRow[]
  rawData?: PlatformRawData
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
  version: 3,
  rawData: { scope: 'single_query', request: { rawDataVersion: 1 }, version: 1, rows: 'typed_json', pages: 'unmodified_accepted_responses', legacyRows: 'string_projection', historicalAbsent: 'unknown', maxSingleResultBytes: 8388608, archiveRelationHash: 'rawData_v1_or_explicit_legacy_rows' },
  batch: { available: true, rawPageBodies: false, typedBusinessRows: true, submit: '/api/platform/batches', status: '/api/platform/batches/{batchId}', item: '/api/platform/batches/{batchId}/items/{itemId}', retry: '/api/platform/batches/{batchId}/retry', maxItems: 50, maxAttempts: 10, maxRequests: 200, maxRows: 5000, maxDurationMs: 120000, maxResultBytes: 8388608, defaultResultBytes: 2097152, submissionAuth: 'task_token', restart: 'failed_no_auto_resume', cache: 'no-store' },
  sources: {
    queryList: { available: true, meaning: '申报记录', conditions: ['name', 'uscc'], combination: 'and', nameMatch: 'platform_keyword', titleSelection: false, defaultRestrictions: [], pagination: true },
    businessList: { available: true, meaning: '关联记录', conditions: ['uscc'], titleSelection: true, rdjb: ['1', '2', '3', 'all'], titleMeaning: { '1': '创新型中小企业', '2': '专精特新中小企业', '3': '小巨人' }, defaultRestrictions: [], pagination: true },
    queryBusList: { available: true, meaning: '已认定企业列表', conditions: ['name', 'uscc', 'rdjb', 'sqsj', 'rddqrq', 'whpcyear', 'whpc', 'szq', 'orderField', 'orderDirection'], combination: 'and', nameMatch: 'platform_keyword', titleSelection: true, titles: ['1', '2', '3'], defaultTitles: ['1', '2', '3'], filters: { sqsj: 'YYYY/MM/DD - YYYY/MM/DD; boundary inclusion and timezone unverified', rddqrq: 'effective year YYYY', whpcyear: 'maintenance year YYYY', whpc: '1-15; requires whpcyear', szq: 'account-scoped 8-digit filter code; differs from row szq' }, sorts: { qymc: ['asc', 'desc'] }, visibility: 'server_session_scope', defaultRestrictions: [], pagination: true },
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
function isJsonValue(value: unknown): value is PlatformJsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return Array.from(value).every(isJsonValue)
  return typeof value === 'object' && value !== null
    && [Object.prototype, null].includes(Object.getPrototypeOf(value))
    && Object.values(value).every(isJsonValue)
}
// Zod record/json parsers rebuild objects and drop own __proto__ keys. Validate
// JSON without replacing the observed object; metadata keeps tools/list explicit.
const rawRowSchema = z.unknown().refine(value => value !== null && typeof value === 'object' && !Array.isArray(value) && isJsonValue(value))
  .meta({ type: 'object', additionalProperties: {} }) as z.ZodType<PlatformRawRow>
/** Toolkit output schema is discoverable in tools/list; REST mirrors this in static route metadata. */
export const platformQueryResultShape = {
  source: z.enum(PLATFORM_QUERY_SOURCES), status: z.enum(['success', 'no_record', 'auth_failed', 'failed', 'partial', 'not_queried']),
  effectiveConditions: z.object({ name: z.string().optional(), uscc: z.string().optional(), combination: z.literal('and'), sqsj: z.string().optional(), rddqrq: z.string().optional(), whpcyear: z.string().optional(), whpc: z.string().optional(), szq: z.string().optional(), orderField: z.string().optional(), orderDirection: z.string().optional() }),
  titleScope: z.object({ mode: z.enum(['source_default', 'selected']), rdjb: z.array(z.string()) }),
  queriedAt: z.string(), completedAt: z.string(), rows: z.array(z.record(z.string(), z.string())),
  dataRows: z.array(rawRowSchema).optional(),
  rawData: z.strictObject({ version: z.literal(1), rows: z.array(rawRowSchema), pages: z.array(z.strictObject({ ...positionShape, format: z.enum(['json', 'html-script', 'html-table']), body: z.string() })) }).optional(),
  pages: z.array(z.object({ ...positionShape, maxPage: z.number().int().positive().nullable().optional(), status: z.enum(['success', 'auth_failed', 'failed']), fetchedCount: z.number().int().nonnegative(), declaredTotal: z.number().int().nonnegative().nullable(), error: queryErrorSchema })),
  fetchedCount: z.number().int().nonnegative(), declaredTotal: z.number().int().nonnegative().nullable(),
  completeness: z.enum(['complete', 'partial', 'not_queried']), fullRange: z.boolean(),
  unfinished: z.array(z.object(positionShape)), error: queryErrorSchema,
  limits: z.object({ maxRequests: z.number(), maxRows: z.number(), maxDurationMs: z.number(), pageSize: z.number() }),
}
