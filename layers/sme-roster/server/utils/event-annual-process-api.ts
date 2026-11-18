import { z } from 'zod'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../../../../db/schema'
import { readQualifiedAnnualProcess } from './annual-correspondence-read'

const id = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const pagination = z.strictObject({ page: id.default(1), pageSize: id.max(200).default(50) })
const headers = { 'cache-control': 'no-store' }
/** Sole public read application boundary. No preflight, token-dependent write or task submission. */
export function handleEventAnnualProcessRequest(request: { method: string; id: unknown; query?: unknown }, context: { db: BetterSQLite3Database<typeof schema> }) {
  const error = (status: number, code: string, message: string) => ({ status, headers, body: { error: { code, message } } })
  if (request.method !== 'GET') return error(405, 'method_not_allowed', 'Only GET is supported')
  // Explicit scalar shapes reject arrays/booleans rather than JS coercion accepting them.
  const scalar = (value: unknown) => (typeof value === 'string' && /^\d+$/.test(value)) || (typeof value === 'number' && Number.isSafeInteger(value))
  const query = request.query ?? {}
  if (!scalar(request.id) || !query || typeof query !== 'object' || Array.isArray(query) || Object.values(query).some(value => value !== undefined && !scalar(value))) return error(400, 'invalid_request', 'Invalid event or pagination')
  const parsedId = id.safeParse(request.id), parsedPage = pagination.safeParse(query)
  if (!parsedId.success || !parsedPage.success) return error(400, 'invalid_request', 'Invalid event or pagination')
  try {
    const db = context.db
    const result = readQualifiedAnnualProcess(db, parsedId.data)
    if (!result) return error(404, 'not_found', 'Official award/review event not found')
    const { page, pageSize } = parsedPage.data
    const total = result.process.steps.length
    const start = Math.min(Number.MAX_SAFE_INTEGER, (page - 1) * pageSize)
    return { status: 200, headers, body: { ...result, process: { ...result.process, steps: result.process.steps.slice(start, start + pageSize) }, total, page, pageSize } }
  } catch {
    return error(500, 'internal_error', 'Annual process read failed')
  }
}
export function dispatchEventAnnualProcessMcp(args: { eventId: unknown; page?: unknown; pageSize?: unknown }, context: { db: BetterSQLite3Database<typeof schema> }) {
  try {
    const { eventId, ...query } = args
    const output = handleEventAnnualProcessRequest({ method: 'GET', id: eventId, query }, context)
    if (output.status === 200) return output.body
    return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify(output.body) }] }
  } catch {
    return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ error: { code: 'internal_error', message: 'Annual process read failed' } }) }] }
  }
}
