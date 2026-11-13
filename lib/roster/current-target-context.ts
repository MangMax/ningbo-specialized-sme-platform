import type Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import type { ReceiptRuntimeContext } from '../../server/utils/receipt-runtime-context'
import { targetSchema } from '../platform/target-schema'
import { createTargetCurrentCandidateReader } from './current-candidates-target'
import { createCurrentQualificationAssessmentReaderWithWitnesses } from './current-qualification'
import { readTargetIdentityKeyVariants } from './current-identity-keys'
import { resolveRecognizedFactSource, type RecognizedFactSource } from './recognized-filter-source'
import { createTargetRecognizedWitnessReader } from './recognized-witness-target'

/** Compose accepted readers only inside the consumer-owned transaction. This
 * context owns no transaction and never encloses a Promise in withinSnapshot.
 * The same connection stays pinned through each sync read and async drain. */
export function createCurrentTargetContext(db: Database.Database, source?: RecognizedFactSource, receiptRuntime?: ReceiptRuntimeContext) {
  if (Number(db.pragma('user_version', { simple: true })) !== 71613 || resolveRecognizedFactSource(source) !== 'typed') return
  if (!db.inTransaction) throw new Error('Current target context requires the caller snapshot')
  const reader = drizzle(db, { schema: targetSchema })
  const candidates = createTargetCurrentCandidateReader(reader)
  const witnesses = createTargetRecognizedWitnessReader(reader)
  const assessment = createCurrentQualificationAssessmentReaderWithWitnesses(db, witnesses, receiptRuntime)
  const keys = {
    queries: readTargetIdentityKeyVariants(db, 'queries'),
    relations: readTargetIdentityKeyVariants(db, 'unassignedRelations'),
  }
  return { candidates, witnesses, assessment, keys }
}
