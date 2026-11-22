import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type * as schema from '../../../../db/schema'
import { readTargetPlatformEvidence } from './target-evidence-read'
import type { PlatformEvidenceInput, PlatformEvidenceResult } from './evidence-contract'
export { MAX_EVIDENCE_CHUNK_BYTES, type PlatformEvidenceInput } from './evidence-contract'
type Db = BetterSQLite3Database<typeof schema>
export function readPlatformQueryEvidence(db: Db, input: PlatformEvidenceInput): PlatformEvidenceResult {
  return readTargetPlatformEvidence(db, input)
}
export { platformEvidenceInputSchema } from './evidence-input'
