/** Bounded, byte-exact archive access. No JSON archive is decoded just to return a slice. */
import { z } from 'zod'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../../../../db/schema'
import { readTargetPlatformEvidence } from './target-evidence-read'
import { MAX_EVIDENCE_CHUNK_BYTES, type PlatformEvidenceInput, type PlatformEvidenceResult } from './evidence-contract'
export { MAX_EVIDENCE_CHUNK_BYTES, type PlatformEvidenceInput } from './evidence-contract'

type Db = BetterSQLite3Database<typeof schema>
export const platformEvidenceInputSchema = z.object({
  queryId: z.number().int().positive(), field: z.enum(['rawResponse', 'collectionEvidence', 'legacyProvenance', 'relations', 'relation']),
  relationId: z.number().int().positive().optional(), offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - MAX_EVIDENCE_CHUNK_BYTES).optional(),
  length: z.number().int().min(1).max(MAX_EVIDENCE_CHUNK_BYTES).optional(), page: z.number().int().positive().optional(), pageSize: z.number().int().min(1).max(200).optional(),
}).strict().refine(input => input.field !== 'relation' || input.relationId != null)
export function readPlatformQueryEvidence(db: Db, input: PlatformEvidenceInput): PlatformEvidenceResult {
  return readTargetPlatformEvidence(db, input)
}
