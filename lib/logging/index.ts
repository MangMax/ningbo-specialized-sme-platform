import { createLogger, initLogger } from 'evlog'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createLogService, type LogService } from './service'
import { projectEvlog, safeLogEvent } from './privacy'
import { LOG_DEFAULTS, type LogContext, type LogInput } from './contract'
export * from './contract'
export { createLogService } from './service'
let service: LogService | undefined
const numberEnv = (name: string, fallback: number) => {
  const value = Number(process.env[name]); return Number.isInteger(value) && value > 0 ? value : fallback
}
/** Server and each worker own one bounded drain to the SAME independent directory. SQLite serializes writes. */
export function applicationLogs(): LogService {
  return service ??= createLogService({
    directory: resolve(process.env.NUXT_LOG_DIR || './.runtime-logs'),
    retentionDays: Math.min(365, numberEnv('NUXT_LOG_RETENTION_DAYS', LOG_DEFAULTS.retentionDays)),
    maxBytes: Math.max(1048576, Math.min(4294967296, numberEnv('NUXT_LOG_MAX_BYTES', LOG_DEFAULTS.maxBytes))),
    stdout: true,
  })
}
/** evlog custom drain. Never throws into the evlog/business pipeline. */
export function drainApplicationEvent(event: Record<string, unknown>) {
  try { applicationLogs().emit(projectEvlog(event)) } catch { /* Only fixed diagnostics, never original error. */ }
}
/** Worker entry points call once, before emitting. Nuxt is initialized by evlog/nuxt instead. */
export function initializeWorkerLogging() {
  initLogger({ enabled: true, silent: true, pretty: false, sampling: { rates: { info: 100, warn: 100, error: 100, debug: 100 } }, drain: ctx => drainApplicationEvent(ctx.event) })
}
/** Use this API for explicit lifecycle events in main/worker processes, through evlog's pipeline. */
export function appLog(input: LogInput, context: LogContext = {}): void {
  try {
    const safe = safeLogEvent({ ...context, ...input })
    const logger = createLogger({ applicationLog: safe })
    logger.emit({ _forceKeep: true })
  } catch { /* Runtime logging must not change business outcome. */ }
}
/** Request handlers pass this context into task/subprocess payloads explicitly. No inferred actor. */
export function requestLogContext(event: { context: Record<string, any> }): LogContext {
  return { ...event.context.applicationLogContext }
}
export function newLogContext(): LogContext { return { requestId: randomUUID(), traceId: randomUUID() } }
export async function closeApplicationLogging() { await service?.close(); service = undefined }
