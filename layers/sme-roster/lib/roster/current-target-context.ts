import type Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import type { ReceiptRuntimeContext } from '../../server/utils/receipt-runtime-context'
import { targetSchema } from '../platform/target-schema'
import { createTargetCurrentCandidateReader } from './current-candidates-target'
import { createCurrentQualificationAssessmentReaderWithWitnesses } from './current-qualification'
import { readTargetIdentityKeyVariants } from './current-identity-keys'
import { createTargetRecognizedWitnessReader } from './recognized-witness-target'
import { createPlatformQualificationFactsReader } from './platform-qualification-sqlite'

/** Compose accepted readers only inside the consumer-owned transaction. This
 * context owns no transaction and never encloses a Promise in withinSnapshot.
 * The same connection stays pinned through each sync read and async drain. */
export function createCurrentTargetContext(db: Database.Database, receiptRuntime?: ReceiptRuntimeContext) {
  if (!db.inTransaction) throw new Error('Current target context requires the caller snapshot')
  const reader = drizzle(db, { schema: targetSchema })
  const candidates = createTargetCurrentCandidateReader(reader)
  const witnesses = createTargetRecognizedWitnessReader(reader)
  const assessment = createCurrentQualificationAssessmentReaderWithWitnesses(db, witnesses, receiptRuntime, createPlatformQualificationFactsReader(reader))
  const keys = {
    queries: readTargetIdentityKeyVariants(db, 'queries'),
    relations: readTargetIdentityKeyVariants(db, 'unassignedRelations'),
  }
  return { candidates, witnesses, assessment, keys }
}
