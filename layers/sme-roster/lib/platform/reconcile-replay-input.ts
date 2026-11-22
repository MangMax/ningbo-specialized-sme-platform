import type { RosterImportPlatformQuery } from '../roster-import-client'

export interface StoredReplayInput {
  encode(query: RosterImportPlatformQuery): RosterImportPlatformQuery
}
