import { createLogger, initLogger } from 'evlog'
import { isMainThread } from 'node:worker_threads'
import { randomUUID } from 'node:crypto'
import type { LogService } from './service'
import { createPostgresLogService } from './postgres-service'
import { applicationLogRedaction, projectEvlog, safeLogEvent } from './privacy'
import { LOG_DEFAULTS, type LogContext, type LogInput } from './contract'
import { isSuccessfulProbe } from './http'
import { httpLogModule, mcpLogModule } from './module'
export * from './contract'
let service: LogService | undefined
let loggingClosed = false
let workerExecution = !isMainThread
const numberEnv = (name: string, fallback: number) => {
  const value = Number(process.env[name]); return Number.isInteger(value) && value > 0 ? value : fallback
}
export function applicationLogs(): LogService {
  if (loggingClosed) throw new Error('Application logging is closed')
  const postgresUrl = process.env.NUXT_POSTGRES_LOG_URL ?? process.env.NUXT_POSTGRES_DIRECTORY_URL
  if (!postgresUrl) throw new Error('PostgreSQL logging connection is required')
  return service ??= createPostgresLogService({
    postgresUrl,
    postgresSchema: process.env.NUXT_POSTGRES_LOG_SCHEMA || undefined,
    retentionDays: Math.min(365, numberEnv('NUXT_LOG_RETENTION_DAYS', LOG_DEFAULTS.retentionDays)),
    maxBytes: Math.max(1048576, Math.min(4294967296, numberEnv('NUXT_LOG_MAX_BYTES', LOG_DEFAULTS.maxBytes))),
    stdout: true,
  })
}
/** evlog custom drain. Never throws into the evlog/business pipeline. */
export function drainApplicationEvent(event: Record<string, unknown>) {
  try {
    const projected = projectEvlog(event)
    if (!isSuccessfulProbe(projected)) applicationLogs().emit(projected)
  } catch { /* Only fixed diagnostics, never original error. */ }
}
/** Worker entry points call once, before emitting. Nuxt is initialized by evlog/nuxt instead. */
export function initializeWorkerLogging() {
  loggingClosed = false
  workerExecution = true
  initLogger({ enabled: true, silent: true, pretty: false, redact: applicationLogRedaction, sampling: { rates: { info: 100, warn: 100, error: 100, debug: 100 } }, drain: ctx => drainApplicationEvent(ctx.event) })
}
/** Use this API for explicit lifecycle events in main/worker processes, through evlog's pipeline. */
export function appLog(input: LogInput, context: LogContext = {}): void {
  try {
    const safe = safeLogEvent({ ...context, ...input, origin: input.origin ?? { runtime: 'node', integration: 'application', capture: 'manual', ...(workerExecution ? { execution: 'worker' as const } : {}) } })
    const logger = createLogger({ applicationLog: safe })
    logger.emit({ _forceKeep: true })
  } catch { /* Runtime logging must not change business outcome. */ }
}
/** Request-scoped context also carries the transport facts once the router has matched a route. */
export function matchedHttpRoute(context?: { matchedRoute?: { path?: unknown; route?: unknown } }) {
  const matched = context?.matchedRoute
  const route = matched?.path ?? matched?.route
  return typeof route === 'string' ? route.replace(/\/:([a-zA-Z_][a-zA-Z_0-9]*)\(\.\*\)$/, '/**:$1') : undefined
}
export type RequestLogContext = LogContext & { httpMethod?: string; httpRoute?: string }
/** Request handlers pass this context into task/subprocess payloads explicitly. No inferred actor. */
export function requestLogContext(event: { context?: Record<string, any>; method?: string }): RequestLogContext {
  // Plain route adapters may omit H3 context; only carry metadata actually present.
  const context = event.context ?? {}
  const route = matchedHttpRoute(context)
  const request: LogContext | undefined = context.applicationLogContext
  const module = request?.mcp ? mcpLogModule(request.mcp)
    : route ? httpLogModule(route) ?? request?.module
    : request?.module
  return {
    ...request,
    ...(module !== undefined ? { module } : {}),
    ...(typeof event.method === 'string' ? { httpMethod: event.method } : {}),
    ...(route ? { httpRoute: route } : {}),
  }
}
/**
 * One module-entry enrichment for fields the framework/library already knows.
 * `appLog` events later reuse it through `requestLogContext`; evlog's request
 * completion reads the same `applicationLog*` keys in `projectEvlog`.
 * This is request-local (`event.context`), not a process-global cache.
 */
export function setRequestLogMetadata(
  event: { context: Record<string, any>; log?: { set?: (context: Record<string, unknown>) => void } | null },
  patch: Pick<LogContext, 'mcp' | 'tus' | 'module'>,
): void {
  try {
    const current: LogContext = event.context.applicationLogContext ?? {}
    const next: LogContext = {
      ...current,
      ...(patch.module !== undefined ? { module: patch.module } : {}),
      ...(patch.mcp ? { mcp: { ...current.mcp, ...patch.mcp } } : {}),
      ...(patch.tus ? { tus: { ...current.tus, ...patch.tus } } : {}),
    }
    event.context.applicationLogContext = next
    // evlog's native request logger keeps its own context. These namespaced
    // keys are the only raw metadata the custom drain will project.
    event.context.log?.set?.({
      ...(next.module !== undefined ? { applicationLogModule: next.module } : {}),
      ...(next.mcp ? { applicationLogMcp: next.mcp } : {}),
      ...(next.tus ? { applicationLogTus: next.tus } : {}),
    })
  } catch { /* Metadata collection must never change the response. */ }
}
export function newLogContext(): LogContext { return { requestId: randomUUID(), traceId: randomUUID() } }
export async function closeApplicationLogging() {
  loggingClosed = true
  await service?.close()
  service = undefined
}
