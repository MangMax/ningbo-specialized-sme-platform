import type Database from 'better-sqlite3'
import type { CurrentTitle } from './current-titles'

/** One enumeration in the caller-owned snapshot; release before hydration SAVEPOINTs. */
export interface CurrentCandidateReader {
  readonly connection: Database.Database
  iterate(title: CurrentTitle, sort?: 'id_asc' | 'name_asc' | 'name_desc'): Iterable<{ id: number }>
}
