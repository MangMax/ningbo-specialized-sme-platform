import { z } from 'zod'

const text = z.string().nullable()

const relationShape = z.object({
  id: z.number(), queryId: z.number(), sequenceNo: z.number(), relationKey: text,
  enterpriseId: z.number().nullable(), sourceText: text, usccRaw: text, nameRaw: text, aliasNameRaw: text,
  province: text, status: text, batch: text, declareKind: text, appliedAt: text, awardBatchLabel: text,
  year: z.number().nullable(), matchBasis: z.string(), verificationStatus: z.string(),
  // Validate the object without projecting away source-owned keys such as __proto__.
  rawFields: z.custom<Record<string, unknown>>(value => value !== null && typeof value === 'object' && !Array.isArray(value)).nullable(),
  sourceRdjb: z.unknown().optional(), sourcePage: z.unknown().optional(),
  normalizationConflicts: z.array(z.union([z.object({field:z.literal('status'),storedValue:z.string(),rawValue:z.string()}),z.object({
    field: z.enum(['province', 'batch', 'declareKind', 'appliedAt', 'awardBatchLabel', 'year']),
    storedValue: z.union([z.string(), z.number()]), rawValue: z.union([z.string(), z.number()]),
  })])).optional(),
})

const businessRelationShape = relationShape.extend({
  status: z.union([text, z.custom<Buffer>(Buffer.isBuffer)]),
  normalizationConflicts: z.array(z.union([
    z.object({field:z.literal('status'),storedValue:z.union([z.string(),z.custom<Buffer>(Buffer.isBuffer)]),rawValue:z.string()}),
    z.object({field:z.enum(['province','batch','declareKind','appliedAt','awardBatchLabel','year']),storedValue:z.union([z.string(),z.number()]),rawValue:z.union([z.string(),z.number()])}),
  ])).optional(),
})

export function parsePlatformRelationDisplay(interfaceName: string | undefined, value: unknown) {
  return (interfaceName === 'business_list' ? businessRelationShape : relationShape).parse(value)
}
