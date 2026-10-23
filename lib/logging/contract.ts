/** Runtime diagnostics, never business audit. Identifiers must be facts known to the caller. */
export const LOG_SOURCES = ['http', 'mcp', 'task', 'worker', 'platform', 'file', 'ocr', 'import', 'export', 'client', 'system'] as const
export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const
export const LOG_OUTCOMES = ['started', 'success', 'failure', 'denied', 'timeout', 'cancelled', 'unknown', 'partial', 'no_record', 'skipped'] as const
/**
 * JSON-RPC methods this server actually exposes. `batch` means the request
 * carried more than one method; it never stands in for one of them.
 */
export const MCP_RPC_METHODS = [
  'initialize', 'notifications/initialized', 'ping',
  'tools/list', 'tools/call',
  'resources/list', 'resources/templates/list', 'resources/read',
  'prompts/list', 'prompts/get',
  'logging/setLevel', 'completion/complete', 'batch', 'unknown',
] as const
/** Coarse client families only; exact aliases are mapped in privacy.ts. */
export const MCP_CLIENT_CLASSES = ['claude', 'cursor', 'codex', 'vscode', 'cline', 'continue', 'inspector', 'other'] as const
/** Protocol versions this SDK version accepts as of @modelcontextprotocol/sdk 1.32.1. */
export const MCP_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05', '2024-10-07'] as const
export const TUS_UPLOAD_PHASES = ['created', 'completed', 'request-failed'] as const
export const TUS_UPLOAD_METHODS = ['POST', 'PATCH', 'HEAD', 'DELETE', 'OPTIONS'] as const

export interface McpClientMetadata {
  /** Exact alias mapped to a coarse family; never the raw client-supplied name. */
  name: (typeof MCP_CLIENT_CLASSES)[number]
  /** Strict semantic version only; omitted when the self-report is not one. */
  version?: string
  /** Always a self-report; never an authenticated identity. */
  trust: 'self-reported'
  /** Stateless mode only knows this at initialize. */
  capturedAt: 'initialize'
}
export interface McpLogContext {
  transport: 'streamable-http'
  /** One fixed method or `batch`; unknown/multi-method requests stay unattributed. */
  rpcMethod?: (typeof MCP_RPC_METHODS)[number]
  /** Only a statically registered tool name, resolved by the app entry. */
  tool?: string
  /** Current toolkit default is stateless; recorded as an explicit fact. */
  sessionMode: 'stateless'
  /** Present only on the initialize request. Later stateless calls cannot inherit it. */
  client?: McpClientMetadata
  /** The initialize request's declared protocol version; not the negotiated result. */
  protocolVersionRequested?: (typeof MCP_PROTOCOL_VERSIONS)[number]
}
export interface TusLogContext {
  /** Server-generated tus id (default generator is 32 hex chars); omitted if unexpected. */
  uploadId: string
  /** `created`/`completed` are terminal upload facts; `request-failed` is an observation. */
  phase: (typeof TUS_UPLOAD_PHASES)[number]
  method?: (typeof TUS_UPLOAD_METHODS)[number]
  /** Declared upload length when the library knows it; never inferred from other counters. */
  size?: number
  /** Actual bytes accepted so far, as reported by the library callback. */
  offset?: number
}

export interface LogContext {
  requestId?: string; traceId?: string; taskId?: string; fileId?: number; page?: number
  batchId?: string | number; resourceType?: string; resourceId?: string | number
  auditId?: string | number; receiptId?: string | number; parentEventId?: string
  /** Source-specific metadata, only meaningful for source `mcp`. */
  mcp?: McpLogContext
  /** Source-specific metadata, only meaningful for source `file` uploads. */
  tus?: TusLogContext
}
export const LOG_SUPPORTED_INTEGRATIONS = ['nuxt-nitro', 'mcp-toolkit', 'tus', 'application', 'browser', 'vue', 'tus-client', 'drizzle', 'embedpdf', 'pinia-colada', 'vue-router'] as const
export const LOG_INTEGRATIONS = [
  { key: 'nuxt-nitro', label: 'Nuxt / Nitro 请求', state: 'supported', configurable: true, category: 'technical', runtimes: ['node'] },
  { key: 'mcp-toolkit', label: 'MCP Toolkit 模块上下文', state: 'supported', configurable: true, category: 'technical', runtimes: ['node'] },
  { key: 'tus', label: 'tus 服务端回调', state: 'supported', configurable: true, category: 'technical', runtimes: ['node'] },
  { key: 'application', label: '应用手动埋点', state: 'supported', configurable: true, category: 'business', runtimes: ['node', 'browser'] },
  { key: 'browser', label: '浏览器原生异常（客户端自报）', state: 'supported', configurable: true, category: 'technical', runtimes: ['browser'] },
  { key: 'vue', label: 'Vue 异常（客户端自报）', state: 'supported', configurable: true, category: 'technical', runtimes: ['browser'] },
  { key: 'tus-client', label: 'tus 客户端', state: 'supported', configurable: true, category: 'technical', runtimes: ['browser'] },
  { key: 'drizzle', label: 'Drizzle 数据库', state: 'supported', configurable: true, category: 'technical', runtimes: ['node'] },
  { key: 'embedpdf', label: 'EmbedPDF', state: 'supported', configurable: true, category: 'technical', runtimes: ['browser'] },
  { key: 'pinia-colada', label: 'Colada 查询', state: 'supported', configurable: true, category: 'technical', runtimes: ['browser'] },
  { key: 'vue-router', label: 'Vue Router', state: 'supported', configurable: true, category: 'technical', runtimes: ['browser'] },
] as const
export interface LogOrigin {
  runtime: 'node' | 'browser'
  integration: typeof LOG_SUPPORTED_INTEGRATIONS[number]
  capture: 'framework' | 'hook' | 'manual'
  execution?: 'request' | 'background' | 'worker' | 'page'
}
export interface LogInput extends LogContext {
  /** Actual collector attribution; absent on unmarked historical events. Browser claims remain untrusted. */
  origin?: LogOrigin
  source: typeof LOG_SOURCES[number]
  operation: string
  outcome: typeof LOG_OUTCOMES[number]
  level?: typeof LOG_LEVELS[number]
  durationMs?: number
  statusCode?: number
  /** Trusted server request fact (never an incoming header). */
  httpMethod?: string
  /** Framework-matched route template or an app-owned fixed template; never a concrete URL/path. */
  httpRoute?: string
  errorCode?: string
  /** Accepted only to classify a failure. Message, stack, cause and properties are discarded. */
  error?: unknown
  /** Bounded browser claim; never an execution identity or filter. */
  untrustedRelatedRequestId?: string
  counts?: { done?: number; total?: number; failed?: number; dropped?: number }
}
export interface LogEvent extends Omit<LogInput, 'error'> {
  id: string; timestamp: string; level: typeof LOG_LEVELS[number]
}
/** Implemented profiles only. Extend this mapping when another projector is implemented. */
export interface LogProfileFields {
  http: 'httpMethod' | 'httpRoute' | 'statusCode' | 'durationMs'
}
export type LogFieldControls = {
  [P in keyof LogProfileFields]: { [L in typeof LOG_LEVELS[number]]: { [F in LogProfileFields[P]]: boolean } }
}
export type LogFieldControlsPatch = {
  [P in keyof LogProfileFields]?: { [L in typeof LOG_LEVELS[number]]?: { [F in LogProfileFields[P]]?: boolean } }
}
/** Internal output fact, never accepted through LogInput. No original values are implied. */
export type FieldCapture = {
  [P in keyof LogProfileFields]: { profile: P; revision: number; disabled: LogProfileFields[P][] }
}[keyof LogProfileFields]
export type FieldCapturedLogEvent = LogEvent & { fieldCapture?: FieldCapture }
export interface LogFilter {
  from?: string; to?: string; level?: string; source?: string; operation?: string; outcome?: string
  requestId?: string; traceId?: string; taskId?: string; fileId?: number; batchId?: string | number
  resourceId?: string | number; limit?: number; cursor?: string
}
/** List projection keeps bounded outcome facts but not single-event references. */
export type LogSummary = Omit<FieldCapturedLogEvent, 'auditId' | 'receiptId' | 'parentEventId'>
export interface LogPolicy { retentionDays: number; maxBytes: number }
export interface LogCollectionRule { enabled: boolean; minLevel: typeof LOG_LEVELS[number] }
export interface LogCollection {
  sources: Record<typeof LOG_SOURCES[number], LogCollectionRule>
  integrations: Record<typeof LOG_SUPPORTED_INTEGRATIONS[number], LogCollectionRule>
}
export interface LogPolicyPatch extends LogPolicy {
  fieldControls?: LogFieldControlsPatch
  collection?: { sources?: Partial<LogCollection['sources']>; integrations?: Partial<LogCollection['integrations']> }
}
export interface EffectiveLogPolicy extends LogPolicy { collection: LogCollection; fieldControls: LogFieldControls; revision: number }
export const LOG_DEFAULTS = Object.freeze({
  retentionDays: 7, maxBytes: 512 * 1024 * 1024,
  maxEventBytes: 8192, maxQueueEntries: 1024, maxQueueBytes: 4 * 1024 * 1024,
  batchEntries: 64, batchBytes: 256 * 1024, flushIntervalMs: 100,
  drainTimeoutMs: 2000, closeTimeoutMs: 3000, maxPendingQueries: 32,
  maxPageSize: 100, clearBatchSize: 1000,
})
