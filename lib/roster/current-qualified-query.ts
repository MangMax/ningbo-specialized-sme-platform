import type Database from 'better-sqlite3'
import { normalizeName, normalizeUscc } from '../domain'
import { CURRENT_RULE_VERSION, prepareCurrentReader, createCurrentCandidateReader, type CurrentRow, type CurrentTitle } from './current-qualification'
import { currentCandidateBindings, currentCandidateSqlFor } from './current-candidates'
import { readIdentityKeyVariants } from './current-identity-keys'

export interface CurrentQualifiedFilter {
  titleCode: CurrentTitle
  q?: string
  district?: string
  recognitionFrom?: string
  recognitionTo?: string
  validYear?: number
  maintenanceYear?: number
  maintenanceBatch?: number
  sort?: 'id_asc' | 'name_asc' | 'name_desc'
  page?: number
  pageSize?: number
}
export interface CurrentQualifiedResult {
  rows: CurrentRow[]
  total: number
  uncertainTotal: number
  options: { recognitionYears: number[]; validYears: number[]; maintenanceYears: number[]; maintenanceBatchesByYear: Record<string, number[]> }
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
    const readCandidate = createCurrentCandidateReader(db)
    const keys = { queries: readIdentityKeyVariants(db, 'queries'), relations: readIdentityKeyVariants(db, 'unassignedRelations') }
    const order = filter.sort === 'name_asc' ? 'e.name collate nocase asc, c.id asc'
      : filter.sort === 'name_desc' ? 'e.name collate nocase desc, c.id asc' : 'c.id asc'
    const candidates = db.prepare(`select c.id from (${currentCandidateSqlFor(db)}) c join enterprise e on e.id=c.id order by ${order}`)
    const qName = normalizeName(filter.q ?? ''), qUscc = normalizeUscc(filter.q ?? '')
    let total = 0
    let uncertainTotal = 0
    const rows: CurrentRow[] = []
    const recognitionYears = new Set<number>(), validYears = new Set<number>(), maintenanceYears = new Set<number>()
    const maintenanceBatchesByYear = new Map<number, Set<number>>()
    for (const { id } of candidates.iterate(currentCandidateBindings(filter.titleCode)) as Iterable<{ id: number }>) {
      let row = readCandidate(id, filter.titleCode, year, at, keys, true, false)
      if (row.group !== 'eligible') continue
      for (const witness of row.qualificationWitnesses ?? []) {
        recognitionYears.add(witness.recognition.year)
        if (witness.matchedValidYear != null) validYears.add(witness.matchedValidYear)
        if (witness.matchedMaintenance) {
          maintenanceYears.add(witness.matchedMaintenance.year)
          if (witness.matchedMaintenance.batch != null) {
            const batches=maintenanceBatchesByYear.get(witness.matchedMaintenance.year) ?? new Set<number>()
            batches.add(witness.matchedMaintenance.batch); maintenanceBatchesByYear.set(witness.matchedMaintenance.year,batches)
          }
        }
      }
      if (filter.district && row.district !== filter.district) continue
      if (filter.q && !(qName && [row.name, ...row.aliases].some(name => normalizeName(name).includes(qName)))
        && !(qUscc && normalizeUscc(row.uscc).includes(qUscc))) continue
      const related = (row.qualificationWitnesses ?? []).filter(witness =>
        (filter.validYear == null || witness.matchedValidYear === filter.validYear)
        && (filter.maintenanceYear == null || witness.matchedMaintenance?.year === filter.maintenanceYear)
        && (filter.maintenanceBatch == null || witness.matchedMaintenance?.batch === filter.maintenanceBatch))
      if (!related.length && (filter.recognitionFrom || filter.validYear != null || filter.maintenanceYear != null)) {
        if (filter.recognitionFrom && filter.validYear == null && filter.maintenanceYear == null && !(row.qualificationWitnesses ?? []).length) uncertainTotal++
        continue
      }
      const matching = filter.recognitionFrom && filter.recognitionTo
        ? related.filter(witness => filter.recognitionFrom! <= `${witness.recognition.year}-01-01` && filter.recognitionTo! >= `${witness.recognition.year}-12-31`)
        : related
      if (filter.recognitionFrom && filter.recognitionTo) {
        if (!matching.length) {
          if (related.some(witness => filter.recognitionFrom! <= `${witness.recognition.year}-12-31` && filter.recognitionTo! >= `${witness.recognition.year}-01-01`)) uncertainTotal++
          continue
        }
      }
      if (total >= (page - 1) * pageSize && rows.length < pageSize) {
        // Display references never affect qualification or filters. Hydrate only
        // the retained page, inside this transaction and at the same execution time.
        row = readCandidate(id, filter.titleCode, year, at, keys, true)
        if (filter.recognitionFrom || filter.validYear != null || filter.maintenanceYear != null) {
          row.qualificationWitnesses = matching
          row.recognition = matching[0]?.recognition ?? null
          row.matchedValidYears = [...new Set(matching.flatMap(w => w.matchedValidYear == null ? [] : [w.matchedValidYear]))].sort((a,b) => a-b)
          row.matchedMaintenance = matching.flatMap(w => w.matchedMaintenance ? [w.matchedMaintenance] : []).filter((fact,index,all) => all.findIndex(other => other.year === fact.year && other.batch === fact.batch) === index).sort((a,b) => a.year-b.year || (a.batch ?? 0)-(b.batch ?? 0))
        }
        rows.push(row)
      }
      total++
    }
    db.exec('COMMIT')
    const ascending = (values: Set<number>) => [...values].sort((a,b) => a-b)
    return { rows, total, uncertainTotal, options: { recognitionYears: ascending(recognitionYears), validYears: ascending(validYears), maintenanceYears: ascending(maintenanceYears), maintenanceBatchesByYear: Object.fromEntries([...maintenanceBatchesByYear].map(([year,batches]) => [year,ascending(batches)])) }, page, pageSize, titleCode: filter.titleCode, ruleVersion: CURRENT_RULE_VERSION, snapshotStartedAt }
  } catch (error) { if (db.inTransaction) db.exec('ROLLBACK'); throw error }
}
