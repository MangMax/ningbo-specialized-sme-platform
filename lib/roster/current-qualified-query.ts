import type { RecognizedWitnessReader } from './recognized-witness-reader'
import { createCurrentQualificationAssessmentReaderWithWitnesses } from './current-qualification'
import type { PublishedPresentation } from './correspondence-view'
import type Database from 'better-sqlite3'
import { normalizeName, normalizeUscc } from '../domain'
import { CURRENT_RULE_VERSION, prepareCurrentReader, createCurrentQualificationAssessmentReader, type CurrentQualificationSnapshot, type CurrentQualificationWitness, type CurrentRow, type CurrentTitle } from './current-qualification'
import { resolveRecognizedFactSource, type RecognizedFactSource } from './recognized-filter-source'
import { currentCandidateBindings, currentCandidateReadSqlFor } from './current-candidates'
import { readIdentityKeyVariants } from './current-identity-keys'
import { currentCandidateIdBlocks, type CurrentCandidateReader } from './current-candidate-reader'
import { createCurrentTargetContext } from './current-target-context'

export interface CurrentQualifiedFilter {
  titleCode: CurrentTitle
  status?: import('./current-status').CurrentStatus
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
export type CurrentQualifiedRow = CurrentRow & { publishedPresentation: PublishedPresentation; qualificationAssessment: CurrentQualificationSnapshot }
export type CurrentFilterMatchStatus = 'matched' | 'not_matched' | 'not_established'
export interface CurrentFilterMatch {
  status: CurrentFilterMatchStatus
  checks: { field: 'recognitionRange' | 'validYear' | 'maintenanceYear' | 'maintenanceBatch'; status: CurrentFilterMatchStatus }[]
}
export type CurrentPublishedPendingRow = CurrentQualifiedRow & { filterMatch: CurrentFilterMatch }
export interface CurrentQualifiedResult {
  responseVersion: 'current-qualified-478-v2' | 'current-qualified-408-v1'
  rows: CurrentQualifiedRow[]
  publishedPending: { requested: boolean; rows: CurrentPublishedPendingRow[]; total: number; page: number; pageSize: number }
  total: number
  uncertainTotal: number
  options: { recognitionYears: number[]; validYears: number[]; maintenanceYears: number[]; maintenanceBatchesByYear: Record<string, number[]> }
  page: number
  pageSize: number
  titleCode: CurrentTitle
  ruleVersion: string
  snapshotStartedAt: string
}

/** Match filters against the same grant and source row; unknown facts do not prove a hit. */
function selectFilterWitnesses(witnesses: CurrentQualificationWitness[], filter: CurrentQualifiedFilter) {
  type Check = { field: CurrentFilterMatch['checks'][number]['field']; test: (witness: CurrentQualificationWitness) => CurrentFilterMatchStatus }
  const equals = (actual: number | null | undefined, expected: number): CurrentFilterMatchStatus => actual == null ? 'not_established' : actual === expected ? 'matched' : 'not_matched'
  const checks: Check[] = []
  if (filter.recognitionFrom && filter.recognitionTo) checks.push({ field: 'recognitionRange', test: witness => {
    const from = `${witness.recognition.year}-01-01`, to = `${witness.recognition.year}-12-31`
    return filter.recognitionFrom! <= from && filter.recognitionTo! >= to ? 'matched'
      : filter.recognitionFrom! > to || filter.recognitionTo! < from ? 'not_matched' : 'not_established'
  } })
  if (filter.validYear != null) checks.push({ field: 'validYear', test: witness => equals(witness.matchedValidYear, filter.validYear!) })
  if (filter.maintenanceYear != null) checks.push({ field: 'maintenanceYear', test: witness => equals(witness.matchedMaintenance?.year, filter.maintenanceYear!) })
  if (filter.maintenanceBatch != null) checks.push({ field: 'maintenanceBatch', test: witness => equals(witness.matchedMaintenance?.batch, filter.maintenanceBatch!) })
  const anyWitness = (statuses: CurrentFilterMatchStatus[]): CurrentFilterMatchStatus => statuses.includes('matched') ? 'matched'
    : !statuses.length || statuses.includes('not_established') ? 'not_established' : 'not_matched'
  const perWitness = witnesses.map(witness => checks.map(check => check.test(witness)))
  const filterMatch: CurrentFilterMatch = {
    status: !checks.length ? 'matched' : anyWitness(perWitness.map(statuses => statuses.includes('not_matched') ? 'not_matched'
      : statuses.includes('not_established') ? 'not_established' : 'matched')),
    checks: checks.map((check, index) => ({ field: check.field, status: anyWitness(perWitness.map(statuses => statuses[index]!)) })),
  }
  const related = witnesses.filter(witness =>
    (filter.validYear == null || witness.matchedValidYear === filter.validYear)
    && (filter.maintenanceYear == null || witness.matchedMaintenance?.year === filter.maintenanceYear)
    && (filter.maintenanceBatch == null || witness.matchedMaintenance?.batch === filter.maintenanceBatch))
  const matching = filter.recognitionFrom && filter.recognitionTo ? related.filter(witness =>
    filter.recognitionFrom! <= `${witness.recognition.year}-01-01` && filter.recognitionTo! >= `${witness.recognition.year}-12-31`) : related
  // Retain the legacy meaning: uncertainty in the recognition date window,
  // never the number of enterprises whose qualification itself is pending.
  const uncertain = Boolean(filter.recognitionFrom && (
    !related.length && filter.validYear == null && filter.maintenanceYear == null && !witnesses.length
    || related.length && !matching.length && related.some(witness => filter.recognitionFrom! <= `${witness.recognition.year}-12-31` && filter.recognitionTo! >= `${witness.recognition.year}-01-01`)))
  return { matching, uncertain, filterMatch }
}

function retainFilterWitnesses(row: CurrentRow, matching: CurrentQualificationWitness[]) {
  row.qualificationWitnesses = matching
  row.recognition = matching[0]?.recognition ?? null
  row.matchedValidYears = [...new Set(matching.flatMap(w => w.matchedValidYear == null ? [] : [w.matchedValidYear]))].sort((a,b) => a-b)
  row.matchedMaintenance = matching.flatMap(w => w.matchedMaintenance ? [w.matchedMaintenance] : []).filter((fact,index,all) => all.findIndex(other => other.year === fact.year && other.batch === fact.batch) === index).sort((a,b) => a.year-b.year || (a.batch ?? 0)-(b.batch ?? 0))
}

export interface CurrentQualifiedReadOptions {
  /** Explicit #468 rollback seam; absent follows the operational default. */
  recognizedFactSource?: RecognizedFactSource
}
/** Count all candidates in one snapshot; hydrate only the requested page. */
export function listCurrentQualified(db: Database.Database, filter: CurrentQualifiedFilter, readOptions: CurrentQualifiedReadOptions = {}): CurrentQualifiedResult {
  return listCurrentQualifiedBody(db, filter, undefined, readOptions)
}

function legacyCandidates(db: Database.Database, readOptions: CurrentQualifiedReadOptions): CurrentCandidateReader {
  return {
    connection:db,
    iterate(title, sort) {
      const order = sort === 'name_asc' ? 'e.name collate nocase asc, c.id asc'
        : sort === 'name_desc' ? 'e.name collate nocase desc, c.id asc' : 'c.id asc'
      return db.prepare(`select c.id from (${currentCandidateReadSqlFor(db, readOptions.recognizedFactSource)}) c join enterprise e on e.id=c.id order by ${order}`)
        .iterate(currentCandidateBindings(title)) as Iterable<{ id: number }>
    },
  }
}

/** Explicit candidate dependency for offline comparisons and bounded oracles. */
export function listCurrentQualifiedWithCandidates(db: Database.Database, filter: CurrentQualifiedFilter, candidateReader: CurrentCandidateReader, readOptions: CurrentQualifiedReadOptions = {}): CurrentQualifiedResult {
  return listCurrentQualifiedBody(db,filter,candidateReader,readOptions)
}
/** Explicit same-connection candidate and witness dependencies. */
export function listCurrentQualifiedWithCandidatesAndWitnesses(db:Database.Database,filter:CurrentQualifiedFilter,candidateReader:CurrentCandidateReader,witnesses:RecognizedWitnessReader):CurrentQualifiedResult {
  if(witnesses.connection!==db)throw new Error('Witness reader must use the caller connection')
  return listCurrentQualifiedBody(db,filter,candidateReader,{},witnesses)
}
function listCurrentQualifiedBody(db:Database.Database,filter:CurrentQualifiedFilter,candidateReader:CurrentCandidateReader|undefined,readOptions:CurrentQualifiedReadOptions,witnesses?:RecognizedWitnessReader):CurrentQualifiedResult {
  if(candidateReader && candidateReader.connection!==db)throw new Error('Candidate reader must use the caller connection')
  const page = filter.page ?? 1, pageSize = filter.pageSize ?? 25
  const snapshotStartedAt = new Date().toISOString()
  const at = Date.parse(snapshotStartedAt)
  prepareCurrentReader(db)
  db.exec('BEGIN')
  try {
    const target = createCurrentTargetContext(db, readOptions.recognizedFactSource)
    const read=():CurrentQualifiedResult=>{
    const candidates = candidateReader ?? target?.candidates ?? legacyCandidates(db, readOptions)
    const assessmentReader = witnesses ? createCurrentQualificationAssessmentReaderWithWitnesses(db,witnesses)
      : target?.assessment ?? createCurrentQualificationAssessmentReader(db,undefined,{recognizedFactSource:resolveRecognizedFactSource(readOptions.recognizedFactSource)})
    const keys = target?.keys ?? { queries: readIdentityKeyVariants(db, 'queries'), relations: readIdentityKeyVariants(db, 'unassignedRelations') }
    const qName = normalizeName(filter.q ?? ''), qUscc = normalizeUscc(filter.q ?? '')
    const requested = Boolean(qName || qUscc)
    let total = 0
    let uncertainTotal = 0
    const selected: { id: number; matching: CurrentQualificationWitness[] }[] = []
    const hydratedPage = new Map<number, ReturnType<typeof assessmentReader.readCurrent>>()
    const hydrate = (id: number): CurrentQualifiedRow => {
      const { rows: titleRows, snapshot, publishedPresentation } = hydratedPage.get(id) ?? assessmentReader.readCurrent(id, at, filter.titleCode, keys.queries)
      const row = titleRows.find(item => item.assessment!.titleCode === filter.titleCode)!
      const { assessment, ...publicRow } = row
      // Preserve the public-name budget and the complete shared assessment.
      return { ...publicRow, group: assessment!.group, qualificationAssessment: snapshot,
        publishedPresentation }
    }
    const recognitionYears = new Set<number>(), validYears = new Set<number>(), maintenanceYears = new Set<number>()
    const maintenanceBatchesByYear = new Map<number, Set<number>>()
    function* candidateIds() {
      for (const { id } of candidates.iterate(filter.titleCode, filter.sort)) yield id
    }
    for (const ids of currentCandidateIdBlocks(candidateIds())) {
      const assessed = target && candidateReader === undefined
        ? assessmentReader.readFilterCandidates(ids, filter.titleCode, at, keys, filter.status ?? 'effective')
        : ids.map(id => ({ id, ...assessmentReader.readFilterCandidate(id, filter.titleCode, at, keys) }))
      for (const { id, row, effectiveStatus } of assessed) {
        const identityMatch = (!filter.district || row.district === filter.district) && (!filter.q
          || Boolean(qName && [row.name, ...row.aliases].some(name => normalizeName(name).includes(qName)))
          || Boolean(qUscc && normalizeUscc(row.uscc).includes(qUscc)))
        for (const witness of (effectiveStatus === 'effective' ? row.qualificationWitnesses : []) ?? []) {
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
        if (effectiveStatus !== (filter.status ?? 'effective')) continue
        if (!identityMatch) continue
        const { matching, uncertain, filterMatch } = selectFilterWitnesses(row.qualificationWitnesses ?? [], filter)
        if (filterMatch.status !== 'matched') { if (uncertain) uncertainTotal++; continue }
        if (total >= (page - 1) * pageSize && selected.length < pageSize) selected.push({ id, matching })
        total++
      }
    }
    // Exhausting the candidate iterator releases its active SQLite statement
    // before read() opens a nested SAVEPOINT. The outer BEGIN is still active:
    // Counts, witnesses and full T2 hydration share the same read snapshot/time.
    if (target && candidateReader === undefined) for (const ids of currentCandidateIdBlocks(selected.map(row => row.id))) {
      const reads = assessmentReader.readCurrentBatch(ids, at, filter.titleCode, keys.queries)
      ids.forEach((id, index) => hydratedPage.set(id, reads[index]!))
    }
    const rows = selected.map(({ id, matching }) => {
      const hydrated = hydrate(id)
      if (filter.recognitionFrom || filter.validYear != null || filter.maintenanceYear != null) {
        retainFilterWitnesses(hydrated, matching)
      }
      return hydrated
    })
    const ascending = (values: Set<number>) => [...values].sort((a,b) => a-b)
    // Keep the old response field; the five-state reader has no pending bucket.
    return { responseVersion: 'current-qualified-478-v2', rows, publishedPending: { requested, rows: [], total: 0, page, pageSize }, total, uncertainTotal, options: { recognitionYears: ascending(recognitionYears), validYears: ascending(validYears), maintenanceYears: ascending(maintenanceYears), maintenanceBatchesByYear: Object.fromEntries([...maintenanceBatchesByYear].map(([year,batches]) => [year,ascending(batches)])) }, page, pageSize, titleCode: filter.titleCode, ruleVersion: CURRENT_RULE_VERSION, snapshotStartedAt }
    }
    const snapshotWitnesses = witnesses ?? target?.witnesses
    const result = snapshotWitnesses?snapshotWitnesses.withinSnapshot(read):read()
    db.exec('COMMIT')
    return result
  } catch (error) { if (db.inTransaction) db.exec('ROLLBACK'); throw error }
}
