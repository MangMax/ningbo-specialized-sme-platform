import type Database from 'better-sqlite3'
/** Explicit offline target version; never selected by an environment switch. */
export const FINAL_OBSERVATION_VERSION=71605
export const FINAL_COLLECTION_SCOPE_VERSION=71606
export const FINGERPRINT_BASIS_VERSION=71607
export const APPLY_STORED_VERSION=71608
/** #731 A candidate-only capture successor. */
export const CANDIDATE_SCOPE_VERSION=71609
export function assertExpandRuntime(sqlite:Database.Database) {
  if(sqlite.pragma('user_version',{simple:true})!==0)throw new Error('Finalized/offline target schema cannot be opened by the current expand runtime; W/R cutover required')
}
