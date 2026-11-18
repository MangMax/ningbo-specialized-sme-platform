import { z } from 'zod'
import type { FormalValidity } from '../../../../db/record-event-formal-validity'

const date = z.iso.date()
/** Explicit announcement facts only. Missing dates never acquire year-derived precision. */
export const formalValiditySchema = z.strictObject({
  evidenceId: z.number().int().positive(),
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  statementPages: z.array(z.number().int().positive()).min(1).max(20),
  publishedOn: date.optional(),
  originAwardEventId: z.number().int().positive().optional(),
  interval: z.strictObject({ validFrom: date, validThrough: date }).refine(v => v.validFrom <= v.validThrough, 'Invalid interval').optional(),
  continuation: z.enum(['until_next_review_results', 'until_this_review_results']).optional(),
}).refine(v => v.interval !== undefined || v.continuation !== undefined, 'Explicit validity fact required') satisfies z.ZodType<FormalValidity>
