import type Database from 'better-sqlite3'
/** Explicit offline target version; never selected by an environment switch. */
export const FINAL_OBSERVATION_VERSION=71605
export function assertExpandRuntime(sqlite:Database.Database) {
  if(sqlite.pragma('user_version',{simple:true})!==0)throw new Error('Finalized/offline target schema cannot be opened by the current expand runtime; W/R cutover required')
}
