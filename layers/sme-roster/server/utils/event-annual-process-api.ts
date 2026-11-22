import { type AnnualRequest, parseAnnualRequest, annualResponse, error, annualMcpResult } from './event-annual-process-runtime'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type * as schema from '../../../../db/schema'
import { readQualifiedAnnualProcess } from './annual-correspondence-read'
type AnnualContext = { db: BetterSQLite3Database<typeof schema> }
export function handleEventAnnualProcessRequest(request: AnnualRequest, context: AnnualContext) {
  const parsed = parseAnnualRequest(request)
  if ('status' in parsed) return parsed
  try {
    return annualResponse(readQualifiedAnnualProcess(context.db, parsed.id), parsed)
  } catch {
    return error(500, 'internal_error', 'Annual process read failed')
  }
}
export function dispatchEventAnnualProcessMcp(args: { eventId: unknown; page?: unknown; pageSize?: unknown }, context: { db: BetterSQLite3Database<typeof schema> }) {
  const { eventId, ...query } = args
  return annualMcpResult(handleEventAnnualProcessRequest({ method: 'GET', id: eventId, query }, context))
}
export { handleRuntimeEventAnnualProcessRequest, dispatchRuntimeEventAnnualProcessMcp } from './event-annual-process-runtime'
