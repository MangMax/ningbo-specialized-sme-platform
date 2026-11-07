import { z } from 'zod'
import { platformQueryResultShape } from './live-query'
import type { PlatformLiveQueryResult } from './live-query'
import { legacyBusinessProvenanceError, sourcePositionForSequence } from './recognized-evidence'

/** Original legacy string projection; its types remain unknown. */
export type LegacyPlatformCollection = Omit<PlatformLiveQueryResult, 'source' | 'dataRows' | 'rawData'> & { source: 'businessList' }
const { rawData: _rawData, dataRows: _dataRows, ...legacyShape } = platformQueryResultShape
export const legacyPlatformProvenanceSchema = z.strictObject({
  queryId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  interface: z.literal('business_list'), queryKey: z.string().min(1), rdjb: z.string().min(1), queriedAt: z.string(),
  sourceIdentity: z.string().min(1).max(2000),
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  segmentIndex: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  collection: z.strictObject({ ...legacyShape, source: z.literal('businessList') }),
  relations: z.array(z.strictObject({ sequenceNo: z.number().int().positive(), relationKey: z.string().nullable(), rawFields: z.record(z.string(), z.string()) })).max(5000),
}).superRefine((item, context) => {
  const error = legacyBusinessProvenanceError(item.collection)
  if (error) context.addIssue({ code: 'custom', message: error, path: ['collection'] })
})
export const legacyPlatformProvenanceItemsSchema = z.array(legacyPlatformProvenanceSchema).min(1).max(100)
  .refine(items => new Set(items.map(item => item.queryId)).size === items.length, 'queryId must be unique per request')
  .refine(items => new Set(items.map(item => `${item.sourceSha256}:${item.segmentIndex}`)).size === items.length, 'sourceSha256/segmentIndex must be unique per request')
export type LegacyPlatformProvenanceInput = z.infer<typeof legacyPlatformProvenanceSchema>

export function legacySourcePositionForSequence(collection: Pick<LegacyPlatformCollection, 'pages'> | null | undefined, sequenceNo: number) {
  return sourcePositionForSequence(collection, sequenceNo)
}
