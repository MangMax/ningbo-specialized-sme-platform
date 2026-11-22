import type { record, recordEvent } from '../../../../db/postgresql/ledger-tables'
import type { FormalValidity } from '../../../../db/record-event-formal-validity'

export type OfficialEventRow = Omit<typeof recordEvent.$inferSelect, 'formalValidity'> & { formalValidity: FormalValidity | null }
export type RosterRecordRow = Omit<typeof record.$inferSelect, 'qualityFlags'> & { qualityFlags: string[] | null }

/** Revision 1 preserves fingerprints saved before migration0016; later revisions prevent ABA revival. */
export function versionedOfficialEvent(event: OfficialEventRow) {
  // Freeze the published provenance shape. Formal-fact corrections already
  // advance revision; a nullable schema addition must not invalidate old edges.
  const { formalValidity, ...versioned } = event
  const { revision, ...legacy } = versioned
  const projected = revision <= 1 ? legacy : versioned
  return formalValidity == null ? projected : { ...projected, formalValidity }
}
