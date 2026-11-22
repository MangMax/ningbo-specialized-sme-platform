import type * as s from '../../../../db/postgresql/platform-tables'
import type { RosterImportRelation } from '../roster-import-client'
import type { PlatformStoredRelation } from './read'

type Assignment = Omit<typeof s.platformObservationAssignment.$inferInsert,
  'observationId' | 'revision' | 'actor' | 'matchBasis' | 'verificationStatus' | 'origin'>
  & Pick<PlatformStoredRelation, 'matchBasis' | 'verificationStatus'> & {
    actor?: { type: 'user' | 'agent'; id: string } | null
    origin: 'migrated_current' | 'command'
  }
export type ApplyTargetInput = {
  collectionId: number
  /** Existing import ledger provenance, supplied only by the caller coordinator. */
  batchId?: number
  position: Pick<typeof s.platformBusinessObservation.$inferInsert, 'sequenceNo' | 'pageId' | 'pageRowNo'> & { positionState: 'verified' | 'unknown' | 'conflict' }
  /** Already validated by the current import contract. Raw JSON is serialized once here. */
  row: RosterImportRelation
  /** Explicit decision provenance; no inferred owner or historical confirmation time. */
  assignment: Assignment
}
