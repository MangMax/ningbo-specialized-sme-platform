import { getTableColumns, inArray, sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../../db/schema'
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

/** Bounded metadata read; callers must keep this distinct from collectionEvidence. */
export function readLegacyPlatformProvenance(db: Pick<BetterSQLite3Database<typeof schema>, 'select'>, queryIds: readonly number[]) {
  const { collection: _collection, ...columns } = getTableColumns(schema.platformQueryLegacyProvenance)
  const ids = [...new Set(queryIds)]
  const result = new Map<number, { kind: 'legacy_pagination' } & Omit<typeof schema.platformQueryLegacyProvenance.$inferSelect, 'collection'> & { collection: Omit<LegacyPlatformCollection, 'rows'> }>()
  for (let start = 0; start < ids.length; start += 400) {
    const rows = db.select({ ...columns, collection: sql<string>`json_remove(${schema.platformQueryLegacyProvenance.collection}, '$.rows')` })
      .from(schema.platformQueryLegacyProvenance).where(inArray(schema.platformQueryLegacyProvenance.queryId, ids.slice(start, start + 400))).all()
    for (const row of rows) result.set(row.queryId, { ...row, kind: 'legacy_pagination', collection: JSON.parse(row.collection) })
  }
  return result
}
