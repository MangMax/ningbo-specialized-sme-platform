import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../../../db/schema'
import { writeNewCollectionTarget } from '../../../layers/sme-roster/lib/platform/collection-target-command'
import type { RosterImportPlatformQuery } from '../../../layers/sme-roster/lib/roster-import-client'

/** Seed a native collection using the supplied original command and explicit row ownership.
 * The caller owns source evidence: this helper never invents pages, raw rows or capture state. */
export function submitNativePlatformQuery(
  db: BetterSQLite3Database<typeof schema>,
  query: RosterImportPlatformQuery,
  createdAt = query.queriedAt,
) {
  if (!createdAt) throw new Error('Native fixture requires an explicit collection time')
  const result = writeNewCollectionTarget(db, {
    queryText: JSON.stringify(query),
    evidenceText: query.collectionEvidence == null ? null : JSON.stringify(query.collectionEvidence),
    createdAt,
    assignments: (query.relations ?? []).map(row => ({
      enterpriseId: row.enterpriseId ?? null,
      nameRaw: row.nameRaw ?? null,
      usccRaw: row.usccRaw ?? null,
      aliasNameRaw: row.aliasNameRaw ?? null,
      matchBasis: row.matchBasis ?? 'none',
      verificationStatus: row.verificationStatus ?? 'pending',
      origin: 'command' as const,
      actor: { type: 'agent', id: 'native-test-fixture' },
      basis: 'Explicit synthetic test source command',
      recordedAt: createdAt,
    })),
  })
  return { ...result, queryId: result.queryAlias, relationIds: result.observations.map(row => row.relationAlias) }
}
