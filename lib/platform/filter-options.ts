import { z } from 'zod'

export type PlatformFilterOptions = {
  titles: string[]
  declareKinds: string[]
  years: number[]
  statuses: string[]
  batches: string[]
  districts: string[]
  validityDates: string[]
}

export const platformFilterOptionsQuerySchema = z.strictObject({
  source: z.enum(['declarations', 'business-processes', 'recognized-directory']),
  view: z.enum(['records', 'isolated']).default('records'),
})
export type PlatformFilterOptionsQuery = z.infer<typeof platformFilterOptionsQuerySchema>

export function platformFilterOptionsQueryFromQuery(input: unknown): PlatformFilterOptionsQuery {
  const parsed = platformFilterOptionsQuerySchema.safeParse(input)
  if (!parsed.success) throw Object.assign(new Error('Invalid platform filter options query parameters'), { statusCode: 400 })
  return parsed.data
}
