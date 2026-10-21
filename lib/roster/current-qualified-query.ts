import type Database from 'better-sqlite3'
import { normalizeName, normalizeUscc } from '../domain'
import { CURRENT_RULE_VERSION, prepareCurrentReader, readCurrentCandidate, type CurrentRow, type CurrentTitle } from './current-qualification'
import { currentCandidateBindings, currentCandidateSql } from './current-candidates'
import { readIdentityKeyVariants } from './current-identity-keys'

export interface CurrentQualifiedFilter {
  titleCode: CurrentTitle
  q?: string
  district?: string
  sort?: 'id_asc' | 'name_asc' | 'name_desc'
  page?: number
  pageSize?: number
}
export interface CurrentQualifiedResult {
  rows: CurrentRow[]
  total: number
  page: number
  pageSize: number
  titleCode: CurrentTitle
  ruleVersion: string
  snapshotStartedAt: string
}

/** Complete eligible count, retaining only the requested page in the worker. */
export function listCurrentQualified(db: Database.Database, filter: CurrentQualifiedFilter): CurrentQualifiedResult {
  const page = filter.page ?? 1, pageSize = filter.pageSize ?? 25
  const snapshotStartedAt = new Date().toISOString()
  const year = new Date(snapshotStartedAt).getFullYear(), at = Date.parse(snapshotStartedAt)
  prepareCurrentReader(db)
  db.exec('BEGIN')
  try {
    const keys = { queries: readIdentityKeyVariants(db, 'queries'), relations: readIdentityKeyVariants(db, 'unassignedRelations') }
    const order = filter.sort === 'name_asc' ? 'e.name collate nocase asc, c.id asc'
      : filter.sort === 'name_desc' ? 'e.name collate nocase desc, c.id asc' : 'c.id asc'
    const candidates = db.prepare(`select c.id from (${currentCandidateSql}) c join enterprise e on e.id=c.id order by ${order}`)
    const qName = normalizeName(filter.q ?? ''), qUscc = normalizeUscc(filter.q ?? '')
    let total = 0
    const rows: CurrentRow[] = []
    for (const { id } of candidates.iterate(currentCandidateBindings(filter.titleCode)) as Iterable<{ id: number }>) {
      const row = readCurrentCandidate(db, id, filter.titleCode, year, at, keys)
      if (row.group !== 'eligible' || filter.district && row.district !== filter.district) continue
      if (filter.q && !(qName && [row.name, ...row.aliases].some(name => normalizeName(name).includes(qName)))
        && !(qUscc && normalizeUscc(row.uscc).includes(qUscc))) continue
      if (total >= (page - 1) * pageSize && rows.length < pageSize) rows.push(row)
      total++
    }
    db.exec('COMMIT')
    return { rows, total, page, pageSize, titleCode: filter.titleCode, ruleVersion: CURRENT_RULE_VERSION, snapshotStartedAt }
  } catch (error) { if (db.inTransaction) db.exec('ROLLBACK'); throw error }
}
