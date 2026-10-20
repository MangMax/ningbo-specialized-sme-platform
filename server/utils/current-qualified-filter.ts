import { z } from 'zod'
import { CURRENT_TITLES } from '../../lib/roster/current-titles'

export const currentQualifiedFilterSchema = z.strictObject({
  titleCode: z.enum(CURRENT_TITLES),
  q: z.string().trim().min(1).max(120).optional(),
  district: z.string().trim().min(1).max(40).optional(),
  sort: z.enum(['id_asc', 'name_asc', 'name_desc']).optional(),
  page: z.number().int().min(1).max(1_000_000).optional(),
  pageSize: z.number().int().min(1).max(200).optional(),
})

export function parseCurrentQualifiedQuery(query: Record<string, unknown>) {
  const raw: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(query)) {
    raw[key] = key === 'page' || key === 'pageSize' ? typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value : value
  }
  return currentQualifiedFilterSchema.safeParse(raw)
}
