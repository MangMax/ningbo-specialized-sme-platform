import { z } from 'zod'
import { CURRENT_TITLES } from '../../lib/roster/current-titles'

export const currentQualifiedFilterSchema = z.strictObject({
  titleCode: z.enum(CURRENT_TITLES),
  q: z.string().trim().min(1).max(120).optional(),
  district: z.string().trim().min(1).max(40).optional(),
  recognitionFrom: z.string().regex(/^[1-9]\d{3}-\d{2}-\d{2}$/).refine(realDate).optional(),
  recognitionTo: z.string().regex(/^[1-9]\d{3}-\d{2}-\d{2}$/).refine(realDate).optional(),
  validYear: z.number().int().min(1000).max(9999).optional(),
  maintenanceYear: z.number().int().min(1000).max(9999).optional(),
  maintenanceBatch: z.number().int().min(1).max(15).optional(),
  sort: z.enum(['id_asc', 'name_asc', 'name_desc']).optional(),
  page: z.number().int().min(1).max(1_000_000).optional(),
  pageSize: z.number().int().min(1).max(200).optional(),
}).refine(value => Boolean(value.recognitionFrom) === Boolean(value.recognitionTo) && (!value.recognitionFrom || value.recognitionFrom <= value.recognitionTo!), { message: 'Recognition date range requires ordered endpoints' })
  .refine(value => value.maintenanceBatch == null || value.maintenanceYear != null, { message: 'Maintenance batch requires maintenance year' })

function realDate(value: string) {
  const date=new Date(value + 'T00:00:00Z')
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0,10) === value
}

export function parseCurrentQualifiedQuery(query: Record<string, unknown>) {
  const raw: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(query)) {
    raw[key] = ['page','pageSize','validYear','maintenanceYear','maintenanceBatch'].includes(key) ? typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value : value
  }
  return currentQualifiedFilterSchema.safeParse(raw)
}

/** Validate original RPC arguments before the toolkit's raw-shape SDK strips keys. */
export function currentQualifiedRpcError(body: unknown): Response | null {
  for (const entry of Array.isArray(body) ? body : [body]) {
    if (!entry || typeof entry !== 'object') continue
    const rpc = entry as { method?: string; params?: { name?: string; arguments?: unknown }; id?: unknown }
    if (rpc.method !== 'tools/call' || rpc.params?.name !== 'list_current_qualified_enterprises') continue
    if (!currentQualifiedFilterSchema.safeParse(rpc.params.arguments).success) {
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: typeof rpc.id === 'number' || typeof rpc.id === 'string' ? rpc.id : null, error: { code: -32602, message: 'Invalid or unsupported current qualified enterprise query parameters' } }), { status: 400, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
    }
  }
  return null
}
