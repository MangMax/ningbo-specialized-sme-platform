import type { LogInput } from './contract'

/** App-owned categories, never SQL text, database filenames or parameters. */
export const DRIZZLE_CONNECTIONS = ['primary', 'enterprise_read', 'import_execution', 'current_qualification', 'record_comparison', 'evidence_review', 'platform_summary'] as const
export const DRIZZLE_QUERY_OPERATIONS = ['db.query.select', 'db.query.insert', 'db.query.update', 'db.query.delete', 'db.query.other'] as const

/** Native pre-execution facts only. Counts on persisted summaries remain attempts. */
export function isDrizzleQueryAttempt(event: LogInput): boolean {
  return event.source === 'system' && event.level === 'debug' && event.outcome === 'started'
    && event.origin?.runtime === 'node' && event.origin.integration === 'drizzle' && event.origin.capture === 'hook'
    && event.resourceType === 'database_connection' && DRIZZLE_CONNECTIONS.includes(event.resourceId as never)
    && DRIZZLE_QUERY_OPERATIONS.includes(event.operation as never)
    && event.errorCode === undefined && event.durationMs === undefined && event.statusCode === undefined
}
