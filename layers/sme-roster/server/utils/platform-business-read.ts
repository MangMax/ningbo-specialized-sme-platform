import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type * as schema from '../../../../db/schema'
/** Shared read seams for source-specific platform business projections. */
export type Db = BetterSQLite3Database<typeof schema>
export { fail, pageOf, orderedScopes } from './platform-business-projection'
