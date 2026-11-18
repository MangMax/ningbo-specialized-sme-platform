import type Database from 'better-sqlite3'
import type { CurrentTitle } from './current-titles'

/** One enumeration in the caller-owned snapshot; release before hydration SAVEPOINTs. */
export interface CurrentCandidateReader {
  readonly connection: Database.Database
  iterate(title: CurrentTitle, sort?: 'id_asc' | 'name_asc' | 'name_desc'): Iterable<{ id: number }>
}

/** Bound source rows and complete assessments to one disposable block. */
export function* currentCandidateIdBlocks(ids: Iterable<number>, size = 128): Generator<number[]> {
  let block: number[] = []
  for (const id of ids) {
    block.push(id)
    if (block.length === size) { yield block; block = [] }
  }
  if (block.length) yield block
}
