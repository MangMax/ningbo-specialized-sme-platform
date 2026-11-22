import { sql, type SQLWrapper } from 'drizzle-orm'

// Only the snapshot's exact raw_fields cell may come from its sealed same-owner archive.
export function postgresObservationSnapshot(owner: SQLWrapper, storedBytes: SQLWrapper) {
  return sql<Buffer | null>`business.platform_observation_snapshot(${owner}, ${storedBytes})`
}
