import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type * as schema from '../../../../db/schema'
import type { PlatformFactInterface, PlatformObservationFact } from '../../lib/platform/observation-facts'
import type { PlatformStoredRelation } from '../../lib/platform/read'
import type { RosterPlatformQueryRow } from '../../lib/roster/enterprise-roster'
import { readCandidateTargetPositions } from './candidate-target-sources'
import { readTargetBusinessProcessFacts } from './platform-business-processes-target'
import { readPlatformBusinessGroups } from './platform-business-record-read'
import { readTargetDeclarationFacts } from './platform-declarations-target'
import { readTargetRecognizedFacts } from './platform-recognized-target'
import { archiveFactFieldOrder, archiveObservations, groupBusinessDetails } from './platform-business-detail-postgres'

type Db = BetterSQLite3Database<typeof schema>

/** Source-owned typed facts only. This function never reads projection tables directly:
 * each source module owns its projection layout and captured archive facts. */
export function readPlatformDetailFacts(db: Db, queries: RosterPlatformQueryRow[], relations: PlatformStoredRelation[]) {
  const byQuery = new Map(queries.map(query => [query.id, query]))
  const byInterface = new Map<PlatformFactInterface, number[]>()
  for (const relation of relations) {
    const interfaceName = byQuery.get(relation.queryId)?.interface as PlatformFactInterface | undefined
    if (!interfaceName) continue
    const ids = byInterface.get(interfaceName) ?? []
    ids.push(relation.id); byInterface.set(interfaceName, ids)
  }
  const result = new Map<number, PlatformObservationFact>()
  for (const [interfaceName, ids] of byInterface) {
    const facts = interfaceName === 'apply_list' ? readTargetDeclarationFacts(db, ids)
      : interfaceName === 'business_list' ? readTargetBusinessProcessFacts(db, ids, { scope: 'selected' })
      : readTargetRecognizedFacts(db, ids)
    for (const [relationId, fact] of facts) {
      // Preserve the enterprise DTO's historical identity-first field order.
      // The accepted source owner still defines field membership and values.
      result.set(relationId, archiveFactFieldOrder(fact))
    }
  }
  return result
}

/** Caller supplies only displayed enterprise-scoped archives, inside its existing read transaction. */
export function readPlatformBusinessDetails(db: Db, enterpriseId: number, queries: RosterPlatformQueryRow[],
  relations: PlatformStoredRelation[], typedFields = readPlatformDetailFacts(db, queries, relations)) {
  const positions = readCandidateTargetPositions(db, relations.map(row => row.id))
  return groupBusinessDetails(readPlatformBusinessGroups(db, archiveObservations(enterpriseId,queries,relations,positions,typedFields)),typedFields)
}
