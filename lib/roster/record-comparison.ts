import { z } from 'zod'
import { TITLE_ORDER } from '../labels'

export const recordComparisonInput = z.object({
  queryIds: z.array(z.number().int().positive()).min(1).max(500),
  exportBatchIds: z.array(z.number().int().positive()).max(100),
  officialSourceDocumentIds: z.array(z.number().int().positive()).min(1).max(500),
  asOf: z.iso.datetime({ offset: true }).optional(),
  enterpriseId: z.number().int().positive().optional(),
  titleCode: z.enum(TITLE_ORDER as [string, ...string[]]).optional(),
  classification: z.enum(['historical_aligned', 'historical_conflict', 'official_without_correspondence', 'unresolved']).optional(),
  page: z.number().int().positive().default(1),
  pageSize: z.number().int().min(1).max(200).default(50),
}).strict()
export type RecordComparisonInput = z.infer<typeof recordComparisonInput>
export type HistoricalClassification = NonNullable<RecordComparisonInput['classification']>
export const comparisonSourceCatalogInput = z.object({
  kind: z.enum(['query', 'export_batch', 'official_document']).optional(),
  page: z.number().int().positive().default(1),
  pageSize: z.number().int().min(1).max(200).default(50),
}).strict()
export type ComparisonSourceCatalogInput = z.infer<typeof comparisonSourceCatalogInput>

/** Query parameters are repeated or CSV IDs; never silently select every persisted source. */
export function parseRecordComparisonQuery(query: Record<string, unknown>): RecordComparisonInput {
  const ids = (value: unknown): number[] | undefined => {
    if (value === undefined) return undefined
    if (value === '') return []
    const parts = (Array.isArray(value) ? value : [value]).flatMap(item => String(item).split(','))
    if (parts.some(part => !/^\d+$/.test(part.trim()))) return [NaN]
    return parts.map(part => Number(part.trim()))
  }
  const integer = (value: unknown): number | undefined => value === undefined ? undefined : /^\d+$/.test(String(value)) ? Number(value) : NaN
  return recordComparisonInput.parse({
    queryIds: ids(query.queryIds), exportBatchIds: ids(query.exportBatchIds),
    officialSourceDocumentIds: ids(query.officialSourceDocumentIds),
    asOf: query.asOf, enterpriseId: integer(query.enterpriseId), titleCode: query.titleCode,
    classification: query.classification, page: integer(query.page), pageSize: integer(query.pageSize),
  })
}
