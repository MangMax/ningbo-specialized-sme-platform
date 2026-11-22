import { z } from 'zod'
import type { EventAnnualProcessRead } from '../../lib/roster/annual-process'
import { readPostgresQualifiedAnnualProcess } from './event-annual-process-postgres'
import { usePostgresRosterDb } from './postgres-roster-db'

const id = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER)

const pagination = z.strictObject({ page: id.default(1), pageSize: id.max(200).default(50) })

const headers = { 'cache-control': 'no-store' }

/** Sole public read application boundary. No preflight, token-dependent write or task submission. */
export type AnnualRequest = { method: string; id: unknown; query?: unknown }

export const error = (status: number, code: string, message: string) => ({ status, headers, body: { error: { code, message } } })

export function parseAnnualRequest(request: AnnualRequest) {
  if (request.method !== 'GET') return error(405, 'method_not_allowed', 'Only GET is supported')
  // Explicit scalar shapes reject arrays/booleans rather than JS coercion accepting them.
  const scalar = (value: unknown) => (typeof value === 'string' && /^\d+$/.test(value)) || (typeof value === 'number' && Number.isSafeInteger(value))
  const query = request.query ?? {}
  if (!scalar(request.id) || !query || typeof query !== 'object' || Array.isArray(query) || Object.values(query).some(value => value !== undefined && !scalar(value))) return error(400, 'invalid_request', 'Invalid event or pagination')
  const parsedId = id.safeParse(request.id), parsedPage = pagination.safeParse(query)
  if (!parsedId.success || !parsedPage.success) return error(400, 'invalid_request', 'Invalid event or pagination')
  return { id: parsedId.data, ...parsedPage.data }
}

export function annualResponse(result: EventAnnualProcessRead | null, { page, pageSize }: { page: number; pageSize: number }) {
  if (!result) return error(404, 'not_found', 'Official award/review event not found')
  const total = result.process.steps.length
  const start = Math.min(Number.MAX_SAFE_INTEGER, (page - 1) * pageSize)
  return { status: 200, headers, body: { ...result, process: { ...result.process, steps: result.process.steps.slice(start, start + pageSize) }, total, page, pageSize } }
}

export async function handleRuntimeEventAnnualProcessRequest(request: AnnualRequest) {
  const db = usePostgresRosterDb()
  const parsed = parseAnnualRequest(request)
  if ('status' in parsed) return parsed
  try {
    const result = await db.transaction(tx => readPostgresQualifiedAnnualProcess(tx, parsed.id), { isolationLevel: 'repeatable read', accessMode: 'read only' })
    return annualResponse(result, parsed)
  } catch {
    return error(500, 'internal_error', 'Annual process read failed')
  }
}

export async function dispatchRuntimeEventAnnualProcessMcp(args: { eventId: unknown; page?: unknown; pageSize?: unknown }) {
  const { eventId, ...query } = args
  return annualMcpResult(await handleRuntimeEventAnnualProcessRequest({ method: 'GET', id: eventId, query }))
}

export function annualMcpResult(output: ReturnType<typeof annualResponse> | ReturnType<typeof error>) {
  if (output.status === 200) return output.body
  return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify(output.body) }] }
}
