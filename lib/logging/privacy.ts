import { clientRequestReference } from '../client-logging/request-reference'
import { randomUUID } from 'node:crypto'
import { LOG_LEVELS, LOG_OUTCOMES, LOG_SOURCES, type LogEvent, type LogInput } from './contract'
const identifier = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/
const operation = /^[a-z][a-z0-9_.:-]{0,95}$/
const finite = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= Number.MAX_SAFE_INTEGER
/** No free text, objects, headers, URL/query, errors or host paths cross this boundary. */
export function safeLogEvent(input: LogInput): LogEvent {
  const event: LogEvent = {
    id: randomUUID(), timestamp: new Date().toISOString(),
    source: LOG_SOURCES.includes(input.source) ? input.source : 'system',
    operation: typeof input.operation === 'string' && operation.test(input.operation) ? input.operation : 'invalid.operation',
    outcome: LOG_OUTCOMES.includes(input.outcome) ? input.outcome : 'unknown',
    level: LOG_LEVELS.includes(input.level!) ? input.level! : (['failure', 'timeout'].includes(input.outcome) || input.error ? 'error' : 'info'),
  }
  for (const key of ['requestId', 'traceId', 'taskId', 'resourceType', 'parentEventId'] as const) {
    const value = input[key]
    if (typeof value === 'string' && identifier.test(value)) event[key] = value
  }
  for (const key of ['batchId', 'resourceId', 'auditId', 'receiptId'] as const) {
    const value = input[key]
    if ((typeof value === 'string' && identifier.test(value)) || (finite(value) && Number.isInteger(value))) event[key] = value
  }
  for (const key of ['fileId', 'page'] as const) {
    const value = input[key]
    if (finite(value) && Number.isInteger(value) && value! > 0) event[key] = value
  }
  if (event.source === 'client') {
    const reference = clientRequestReference(input.untrustedRelatedRequestId)
    if (reference) event.untrustedRelatedRequestId = reference
  }
  if (finite(input.durationMs)) event.durationMs = input.durationMs
  if (Number.isInteger(input.statusCode) && input.statusCode! >= 100 && input.statusCode! <= 599) event.statusCode = input.statusCode
  // Application-owned codes only; never copy error.code/message/stack from third parties.
  if (typeof input.errorCode === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(input.errorCode)) event.errorCode = input.errorCode
  if (input.counts && typeof input.counts === 'object') {
    const counts: NonNullable<LogEvent['counts']> = {}
    for (const key of ['done', 'total', 'failed', 'dropped'] as const) if (finite(input.counts[key])) counts[key] = input.counts[key]
    if (Object.keys(counts).length) event.counts = counts
  }
  return event
}

/** Replace evlog's raw event before any output. Request completion uses only status + fixed route family. */
export function projectEvlog(input: Record<string, unknown>): LogInput {
  if (input.applicationLog && typeof input.applicationLog === 'object') return input.applicationLog as LogInput
  const status = typeof input.status === 'number' ? input.status : 200
  const path = typeof input.path === 'string' ? input.path.split('?')[0]! : ''
  return {
    source: path === '/mcp' ? 'mcp' : 'http',
    operation: path === '/mcp' ? 'mcp.request' : 'http.request',
    outcome: status >= 500 ? 'failure' : status >= 400 ? 'denied' : 'success',
    level: status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info',
    statusCode: status,
    durationMs: typeof input.durationMs === 'number' ? input.durationMs : typeof input.duration === 'number' ? input.duration : undefined,
    // Generated server-side in the request hook; incoming x-request-id is never trusted.
    requestId: typeof input.requestId === 'string' ? input.requestId : undefined,
    traceId: typeof input.traceId === 'string' ? input.traceId : undefined,
  }
}

/** Allowlist redaction before evlog output: generic PII regexes can corrupt generated UUIDs. */
export const applicationLogRedaction = {
  builtins: false as const,
  transform(event: Record<string, unknown>) {
    const safe = safeLogEvent(projectEvlog(event))
    for (const key of Object.keys(event)) delete event[key]
    event.applicationLog = safe
  },
}
