import { z } from 'zod'

const date = z.iso.date()
/** Explicit announcement facts only. Missing dates never acquire year-derived precision. */
export const formalValiditySchema = z.strictObject({
  evidenceId: z.number().int().positive(),
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  statementPages: z.array(z.number().int().positive()).min(1).max(20),
  publishedOn: date.optional(),
  originAwardEventId: z.number().int().positive().optional(),
  interval: z.strictObject({ validFrom: date, validThrough: date }).refine(v => v.validFrom <= v.validThrough, 'Invalid interval').optional(),
  continuation: z.literal('until_next_review_results').optional(),
}).refine(v => v.interval !== undefined || v.continuation !== undefined, 'Explicit validity fact required')
export type FormalValidity = z.infer<typeof formalValiditySchema>
