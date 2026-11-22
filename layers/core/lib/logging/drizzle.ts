import type { Logger } from 'drizzle-orm/logger'
import { appLog } from './index'
import type { LogContext, LogOrigin } from './contract'
import { DRIZZLE_CONNECTIONS } from './drizzle-query'

/** Connection purposes are app-owned categories, never a filename or path. */
type DrizzleConnection = typeof DRIZZLE_CONNECTIONS[number]

/**
 * Drizzle calls logQuery after preparation/parameter binding, BEFORE execution.
 * This is only an attempt: preparation failures may never reach this hook.
 * Inspect only a bounded SQL prefix to choose a fixed first-verb category;
 * comments/CTEs/other statements stay `other`. Never retain SQL or params.
 * The independent runtime log connection omits this hook to avoid recursion.
 */
export function createDrizzleLogger(options: { connection: DrizzleConnection; context?: LogContext; execution?: LogOrigin['execution'] }): Logger {
  return {
    logQuery(query) {
      try {
        const verb = /^\s*(select|insert|update|delete)\b/i.exec(query.slice(0, 32))?.[1]?.toLowerCase() ?? 'other'
        appLog({
          source: 'system', operation: `db.query.${verb}`, outcome: 'started', level: 'debug',
          resourceType: 'database_connection', resourceId: options.connection,
          origin: {
            runtime: 'node', integration: 'drizzle', capture: 'hook',
            ...(options.execution ? { execution: options.execution } : {}),
          },
        }, options.context)
      } catch { /* A diagnostic callback must never prevent native execution. */ }
    },
  }
}
