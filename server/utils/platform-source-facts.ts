import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type * as schema from '../../db/schema'
import type { PlatformObservationFact } from '../../lib/platform/observation-facts'
import { readPlatformDeclarationFacts } from './platform-declarations'
import { readPlatformBusinessProcessFacts } from './platform-business-processes'
import { readPlatformRecognizedFacts } from './platform-recognized-directory'

type Db = BetterSQLite3Database<typeof schema>

/**
 * Source-specific observation fact seam. The candidate and annual readers call this with
 * relations they have already scoped; they never read projection tables or raw JSON directly.
 * Each source module owns its own typed fields and legacy fallback; this function only
 * selects the source. It is deliberately not a field adapter.
 */
export function readPlatformObservationFacts(db: Db, interfaceName: string, relationIds: number[]): Map<number, PlatformObservationFact> {
  if (!relationIds.length) return new Map()
  switch (interfaceName) {
    case 'apply_list': return readPlatformDeclarationFacts(db, relationIds)
    case 'business_list': return readPlatformBusinessProcessFacts(db, relationIds)
    case 'recognized_list': return readPlatformRecognizedFacts(db, relationIds)
    default: return new Map()
  }
}
