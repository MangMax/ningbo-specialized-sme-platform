import { clientRequestReference } from '../client-logging/request-reference'
import { randomUUID } from 'node:crypto'
import {
  LOG_LEVELS, LOG_OUTCOMES, LOG_SOURCES, LOG_SUPPORTED_INTEGRATIONS,
  MCP_CLIENT_CLASSES, MCP_PROTOCOL_VERSIONS, MCP_RPC_METHODS,
  TUS_UPLOAD_METHODS, TUS_UPLOAD_PHASES,
  type LogEvent, type LogInput, type McpClientMetadata, type McpLogContext, type TusLogContext,
} from './contract'
import { safeHttpMethod, safeHttpRoute } from './http'
const identifier = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/
const operation = /^[a-z][a-z0-9_.:-]{0,95}$/
const finite = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= Number.MAX_SAFE_INTEGER
const safeInteger = (n: unknown) => finite(n) && Number.isInteger(n)
const mcpRpcMethods = new Set<string>(MCP_RPC_METHODS)
const mcpProtocolVersions = new Set<string>(MCP_PROTOCOL_VERSIONS)
const tusUploadMethods = new Set<string>(TUS_UPLOAD_METHODS)
const tusUploadPhases = new Set<string>(TUS_UPLOAD_PHASES)
const semanticVersion = /^\d{1,4}(?:\.\d{1,4}){0,3}(?:-[0-9A-Za-z.-]{1,24})?$/
/** Default @tus/utils Uid.rand(): 16 random bytes rendered as 32 lowercase hex. */
const tusUploadId = /^[a-f0-9]{32}$/
const toolIdentifier = /^[a-z][a-z0-9_]{0,63}$/
/**
 * Exact client-family aliases only. A substring such as "codex" inside an
 * arbitrary self-report is not enough to claim the client is Codex.
 */
const MCP_CLIENT_ALIASES: Readonly<Record<string, (typeof MCP_CLIENT_CLASSES)[number]>> = {
  'claude': 'claude', 'claude-ai': 'claude', 'claude-code': 'claude', 'claude-desktop': 'claude',
  'cursor': 'cursor', 'cursor-vscode': 'cursor', 'cursor-agent': 'cursor',
  'codex': 'codex', 'openai-codex': 'codex',
  'vscode': 'vscode', 'visual studio code': 'vscode', 'visual-studio-code': 'vscode',
  'cline': 'cline', 'continue': 'continue',
  'inspector': 'inspector', 'mcp-inspector': 'inspector', '@modelcontextprotocol/inspector': 'inspector',
}
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
function mcpClientMetadata(value: unknown): McpClientMetadata | undefined {
  const raw = record(value)
  if (typeof raw.name !== 'string' || raw.name.trim() === '') return undefined
  const alias = raw.name.trim().toLowerCase()
  const name = Object.hasOwn(MCP_CLIENT_ALIASES, alias) ? MCP_CLIENT_ALIASES[alias]! : 'other'
  const client: McpClientMetadata = { name, trust: 'self-reported', capturedAt: 'initialize' }
  if (typeof raw.version === 'string' && semanticVersion.test(raw.version)) client.version = raw.version
  return client
}
function mcpRpcMethod(value: unknown): McpLogContext['rpcMethod'] {
  if (typeof value === 'string') return mcpRpcMethods.has(value) ? value as McpLogContext['rpcMethod'] : value ? 'unknown' : undefined
  if (!Array.isArray(value)) return undefined
  if (value.length > 1) return 'batch'
  return value.length === 1 && typeof value[0] === 'string'
    ? (mcpRpcMethods.has(value[0]) ? value[0] as McpLogContext['rpcMethod'] : 'unknown') : undefined
}
/**
 * The app entry's `applicationLogMcp` is authoritative. The evlog request
 * logger's own `mcp` object contains client input (tool names, request ids,
 * session ids) and may only fill transport/method. It is never copied whole.
 */
export function safeMcpContext(trusted: unknown, raw: unknown, trustedTools?: ReadonlySet<string> | true): McpLogContext | undefined {
  const own = record(trusted), upstream = record(raw)
  const rpcMethod = mcpRpcMethod(own.rpcMethod) ?? mcpRpcMethod(upstream.method) ?? mcpRpcMethod(upstream.methods)
  const tool = typeof own.tool === 'string' && toolIdentifier.test(own.tool) && (trustedTools === true || trustedTools?.has(own.tool))
    ? own.tool : undefined
  const client = mcpClientMetadata(own.client)
  const protocolVersionRequested = typeof own.protocolVersionRequested === 'string' && mcpProtocolVersions.has(own.protocolVersionRequested)
    ? own.protocolVersionRequested as McpLogContext['protocolVersionRequested'] : undefined
  if (!rpcMethod && !tool && !client && !protocolVersionRequested && !Object.keys(own).length && !Object.keys(upstream).length) return undefined
  return {
    transport: 'streamable-http',
    sessionMode: 'stateless',
    ...(rpcMethod ? { rpcMethod } : {}),
    ...(tool ? { tool } : {}),
    ...(client ? { client } : {}),
    ...(protocolVersionRequested ? { protocolVersionRequested } : {}),
  }
}
export function safeTusContext(value: unknown): TusLogContext | undefined {
  const raw = record(value)
  if (typeof raw.uploadId !== 'string' || !tusUploadId.test(raw.uploadId)) return undefined
  const phase = typeof raw.phase === 'string' && tusUploadPhases.has(raw.phase)
    ? raw.phase as TusLogContext['phase'] : 'request-failed'
  const method = typeof raw.method === 'string' && tusUploadMethods.has(raw.method.toUpperCase())
    ? raw.method.toUpperCase() as TusLogContext['method'] : undefined
  const size = safeInteger(raw.size) ? raw.size as number : undefined
  const offset = safeInteger(raw.offset) ? raw.offset as number : undefined
  return {
    uploadId: raw.uploadId,
    phase,
    ...(method ? { method } : {}),
    ...(size !== undefined ? { size } : {}),
    ...(offset !== undefined ? { offset } : {}),
  }
}
/** No free text, objects, headers, URL/query, errors or host paths cross this boundary. */
export function safeLogEvent(input: LogInput): LogEvent {
  const event: LogEvent = {
    id: randomUUID(), timestamp: new Date().toISOString(),
    source: LOG_SOURCES.includes(input.source) ? input.source : 'system',
    operation: typeof input.operation === 'string' && operation.test(input.operation) ? input.operation : 'invalid.operation',
    outcome: LOG_OUTCOMES.includes(input.outcome) ? input.outcome : 'unknown',
    level: LOG_LEVELS.includes(input.level!) ? input.level! : (['failure', 'timeout'].includes(input.outcome) || input.error ? 'error' : 'info'),
  }
  const origin = record(input.origin)
  if (['node', 'browser'].includes(origin.runtime as string) && LOG_SUPPORTED_INTEGRATIONS.includes(origin.integration as never) && ['framework', 'hook', 'manual'].includes(origin.capture as string)) {
    event.origin = { runtime: origin.runtime, integration: origin.integration, capture: origin.capture } as NonNullable<LogEvent['origin']>
    if (['request', 'background', 'worker', 'page'].includes(origin.execution as string)) event.origin.execution = origin.execution as NonNullable<LogEvent['origin']>['execution']
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
  // Request transport facts belong only to HTTP/MCP diagnostics; a route must be a safe template.
  if (event.source === 'http' || event.source === 'mcp') {
    const method = safeHttpMethod(input.httpMethod)
    if (method) event.httpMethod = method
    const route = safeHttpRoute(input.httpRoute)
    if (route) event.httpRoute = route
  }
  // Application-owned codes only; never copy error.code/message/stack from third parties.
  if (typeof input.errorCode === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(input.errorCode)) event.errorCode = input.errorCode
  if (input.counts && typeof input.counts === 'object') {
    const counts: NonNullable<LogEvent['counts']> = {}
    for (const key of ['done', 'total', 'failed', 'dropped'] as const) if (finite(input.counts[key])) counts[key] = input.counts[key]
    if (Object.keys(counts).length) event.counts = counts
  }
  // Source-specific metadata is rebuilt from bounded fields, never copied as an object.
  if (event.source === 'mcp') {
    const mcp = safeMcpContext(input.mcp, undefined, true)
    if (mcp) event.mcp = mcp
  }
  if (event.source === 'file') {
    const tus = safeTusContext(input.tus)
    if (tus) event.tus = tus
  }
  return event
}

/** Replace evlog's raw event before any output. Request completion uses only status + fixed route family. */
export function projectEvlog(input: Record<string, unknown>): LogInput {
  if (input.applicationLog && typeof input.applicationLog === 'object') return input.applicationLog as LogInput
  const status = typeof input.status === 'number' ? input.status : 200
  const path = typeof input.path === 'string' ? input.path.split('?')[0]! : ''
  return {
    origin: { runtime: 'node', integration: input.applicationLogMcp ? 'mcp-toolkit' : 'nuxt-nitro', capture: 'framework', execution: 'request' },
    source: path === '/mcp' ? 'mcp' : 'http',
    operation: path === '/mcp' ? 'mcp.request' : 'http.request',
    outcome: status >= 500 ? 'failure' : status >= 400 ? 'denied' : 'success',
    level: status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info',
    statusCode: status,
    durationMs: typeof input.durationMs === 'number' ? input.durationMs : typeof input.duration === 'number' ? input.duration : undefined,
    // The request hook copies a framework-matched template here; the concrete path is never used.
    httpMethod: safeHttpMethod(input.method) ?? safeHttpMethod(input.httpMethod),
    httpRoute: safeHttpRoute(input.httpRoute),
    // Generated server-side in the request hook; incoming x-request-id is never trusted.
    requestId: typeof input.requestId === 'string' ? input.requestId : undefined,
    traceId: typeof input.traceId === 'string' ? input.traceId : undefined,
    // App entry metadata wins; toolkit's own `mcp` object can only fill method.
    mcp: safeMcpContext(input.applicationLogMcp, input.mcp, true),
    tus: safeTusContext(input.applicationLogTus),
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
