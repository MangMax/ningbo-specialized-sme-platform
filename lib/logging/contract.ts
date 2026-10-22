/** Runtime diagnostics, never business audit. Identifiers must be facts known to the caller. */
export const LOG_SOURCES = ['http', 'mcp', 'task', 'worker', 'platform', 'file', 'ocr', 'import', 'export', 'client', 'system'] as const
export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const
export const LOG_OUTCOMES = ['started', 'success', 'failure', 'denied', 'timeout', 'cancelled', 'unknown', 'partial', 'no_record', 'skipped'] as const
export interface LogContext {
  requestId?: string; traceId?: string; taskId?: string; fileId?: number; page?: number
  batchId?: string | number; resourceType?: string; resourceId?: string | number
  auditId?: string | number; receiptId?: string | number; parentEventId?: string
}
export interface LogInput extends LogContext {
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
export interface LogFilter {
  from?: string; to?: string; level?: string; source?: string; operation?: string; outcome?: string
  requestId?: string; traceId?: string; taskId?: string; fileId?: number; batchId?: string | number
  resourceId?: string | number; limit?: number; cursor?: string
}
/** List projection keeps bounded outcome facts but not single-event references. */
export type LogSummary = Omit<LogEvent, 'auditId' | 'receiptId' | 'parentEventId'>
export interface LogPolicy { retentionDays: number; maxBytes: number }
export const LOG_DEFAULTS = Object.freeze({
  retentionDays: 7, maxBytes: 512 * 1024 * 1024,
  maxEventBytes: 8192, maxQueueEntries: 1024, maxQueueBytes: 4 * 1024 * 1024,
  batchEntries: 64, batchBytes: 256 * 1024, flushIntervalMs: 100,
  drainTimeoutMs: 2000, closeTimeoutMs: 3000, maxPendingQueries: 32,
  maxPageSize: 100, clearBatchSize: 1000,
})
