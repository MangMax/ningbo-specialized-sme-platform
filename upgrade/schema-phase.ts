/** Historical expand admission, confined to offline tools and fixed legacy oracles. */
import type Database from 'better-sqlite3'
import { assertFinalPlatformRuntime } from '../db/schema-phase'
export * from '../db/schema-phase'

/** Explicit offline target version; never selected by an environment switch. */
export const FINAL_OBSERVATION_VERSION=71605
export const FINAL_COLLECTION_SCOPE_VERSION=71606
export const FINGERPRINT_BASIS_VERSION=71607
export const APPLY_STORED_VERSION=71608
/** #731 A candidate-only capture successor. */
export const CANDIDATE_SCOPE_VERSION=71609
/** #734 A1 explicit offline capture; runtime guard remains unchanged. */
export const PROCESS_STORED_VERSION=71610


export function assertExpandRuntime(sqlite: Database.Database) {
  if (sqlite.pragma('user_version', { simple: true }) !== 0) throw new Error('Expected historical expand schema')
}

export function assertApplicationRuntime(sqlite: Database.Database) {
  if (sqlite.pragma('user_version', { simple: true }) === 0) return
  assertFinalPlatformRuntime(sqlite)
}
