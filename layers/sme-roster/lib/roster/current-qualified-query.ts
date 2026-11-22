import type { RecognizedWitnessReader } from './recognized-witness-reader'
import type Database from 'better-sqlite3'
import { createCurrentQualificationAssessmentReaderWithWitnesses, prepareCurrentReader } from './current-qualification'
import { currentCandidateIdBlocks, type CurrentCandidateReader } from './current-candidate-reader'
import { createCurrentTargetContext } from './current-target-context'
import { createCurrentQualifiedPage, projectCurrentQualifiedRow, type CurrentQualifiedFilter, type CurrentQualifiedResult } from './current-qualified-page'

export * from './current-qualified-page'

/** Count all candidates in one snapshot; hydrate only the requested page. */
export function listCurrentQualified(db: Database.Database, filter: CurrentQualifiedFilter): CurrentQualifiedResult {
  return listCurrentQualifiedBody(db, filter, undefined )
}

/** Explicit candidate dependency for offline comparisons and bounded oracles. */
export function listCurrentQualifiedWithCandidates(db: Database.Database, filter: CurrentQualifiedFilter, candidateReader: CurrentCandidateReader): CurrentQualifiedResult {
  return listCurrentQualifiedBody(db,filter,candidateReader)
}
/** Explicit same-connection candidate and witness dependencies. */
export function listCurrentQualifiedWithCandidatesAndWitnesses(db:Database.Database,filter:CurrentQualifiedFilter,candidateReader:CurrentCandidateReader,witnesses:RecognizedWitnessReader):CurrentQualifiedResult {
  if(witnesses.connection!==db)throw new Error('Witness reader must use the caller connection')
  return listCurrentQualifiedBody(db,filter,candidateReader,witnesses)
}
function listCurrentQualifiedBody(db:Database.Database,filter:CurrentQualifiedFilter,candidateReader:CurrentCandidateReader|undefined,witnesses?:RecognizedWitnessReader):CurrentQualifiedResult {
  if(candidateReader && candidateReader.connection!==db)throw new Error('Candidate reader must use the caller connection')
  const snapshotStartedAt = new Date().toISOString()
  const at = Date.parse(snapshotStartedAt)
  prepareCurrentReader(db)
  db.exec('BEGIN')
  try {
    const target = createCurrentTargetContext(db)
    const read=():CurrentQualifiedResult=>{
    const candidates = candidateReader ?? target.candidates
    const assessmentReader = witnesses ? createCurrentQualificationAssessmentReaderWithWitnesses(db,witnesses)
      : target.assessment
    const keys = target.keys
    const page = createCurrentQualifiedPage(filter, snapshotStartedAt)
    const hydratedPage = new Map<number, ReturnType<typeof assessmentReader.readCurrent>>()
    const hydrate = (id: number) => projectCurrentQualifiedRow(
      hydratedPage.get(id) ?? assessmentReader.readCurrent(id, at, filter.titleCode, keys.queries), filter.titleCode)
    function* candidateIds() {
      for (const { id } of candidates.iterate(filter.titleCode, filter.sort)) yield id
    }
    for (const ids of currentCandidateIdBlocks(candidateIds())) {
      const assessed = candidateReader === undefined
        ? assessmentReader.readFilterCandidates(ids, filter.titleCode, at, keys, filter.status ?? 'effective')
        : ids.map(id => ({ id, ...assessmentReader.readFilterCandidate(id, filter.titleCode, at, keys) }))
      for (const { id, row, effectiveStatus } of assessed) page.observe(id, row, effectiveStatus)
    }
    // Exhausting the candidate iterator releases its active SQLite statement
    // before read() opens a nested SAVEPOINT. The outer BEGIN is still active:
    // Counts, witnesses and full T2 hydration share the same read snapshot/time.
    if (candidateReader === undefined) for (const ids of currentCandidateIdBlocks(page.selectedIds())) {
      const reads = assessmentReader.readCurrentBatch(ids, at, filter.titleCode, keys.queries)
      ids.forEach((id, index) => hydratedPage.set(id, reads[index]!))
    }
    return page.result(hydrate)
    }
    const snapshotWitnesses = witnesses ?? target.witnesses
    const result = snapshotWitnesses.withinSnapshot(read)
    db.exec('COMMIT')
    return result
  } catch (error) { if (db.inTransaction) db.exec('ROLLBACK'); throw error }
}
