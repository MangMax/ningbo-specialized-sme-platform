import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { credentialState, storageError } from '../../../core/server/utils/credential-resolution'
import { serviceCredential } from '../../../../db/schema'

export function readRosterFixtureCredentials(db: BetterSQLite3Database<typeof import('../../../../db/schema')>) {
  try {
    return credentialState(db.select().from(serviceCredential).all())
  } catch {
    throw storageError()
  }
}
