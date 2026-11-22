import type * as schema from '../../../../db/schema'

/** Revision 1 preserves fingerprints saved before migration0016; later revisions prevent ABA revival. */
export function versionedOfficialEvent(event: typeof schema.recordEvent.$inferSelect) {
  // Freeze the published provenance shape. Formal-fact corrections already
  // advance revision; a nullable schema addition must not invalidate old edges.
  const { formalValidity, ...versioned } = event
  const { revision, ...legacy } = versioned
  const projected = revision <= 1 ? legacy : versioned
  return formalValidity == null ? projected : { ...projected, formalValidity }
}
