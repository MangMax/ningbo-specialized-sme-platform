import { z } from 'zod'
import { MAX_EVIDENCE_CHUNK_BYTES } from './evidence-contract'

export const platformEvidenceInputSchema = z.object({
  queryId: z.number().int().positive(), field: z.enum(['rawResponse', 'collectionEvidence', 'legacyProvenance', 'relations', 'relation']),
  relationId: z.number().int().positive().optional(), offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - MAX_EVIDENCE_CHUNK_BYTES).optional(),
  length: z.number().int().min(1).max(MAX_EVIDENCE_CHUNK_BYTES).optional(), page: z.number().int().positive().optional(), pageSize: z.number().int().min(1).max(200).optional(),
}).strict().refine(input => input.field !== 'relation' || input.relationId != null)
