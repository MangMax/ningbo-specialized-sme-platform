import { annualScopeRecordIds, projectAnnualWriteScope } from './annual-correspondence-projection'
import type Database from 'better-sqlite3'
import type { EventAnnualProcessRead } from '../../lib/roster/annual-process'
import { qualifyAnnualFinal, readAnnualDecisionRefs, type AnnualDb } from './annual-correspondence'
import { type AnnualWriteScope } from './annual-correspondence-contract'
import { readTargetAnnualHistory } from './annual-process-target-sources'
import { readAnnualComparisonBatch, readAnnualProcessBatch, readEventAnnualProcess } from './event-annual-process-read'
function writeScope(db: AnnualDb, read: EventAnnualProcessRead) {
  const history = readTargetAnnualHistory(db, annualScopeRecordIds(read))
  return projectAnnualWriteScope(read, ids => ids.flatMap(id => history.get(id) ?? []))
}
export function readAnnualWriteScope(db: AnnualDb, eventId: number): AnnualWriteScope | null {
  return readAnnualWriteScopes(db, [eventId]).get(eventId) ?? null
}
export function readAnnualWriteScopes(db: AnnualDb, eventIds: readonly number[]) {
  return db.transaction(() => {
    const reads = readAnnualProcessBatch(db, eventIds)
    const records = [...reads.values()].flatMap(entry => annualScopeRecordIds(entry.read))
    const history = readTargetAnnualHistory(db, records)
    return new Map([...reads].map(([id, entry]) => [id, projectAnnualWriteScope(entry.read, ids => ids.flatMap(id => history.get(id) ?? []))]))
  })
}
readAnnualWriteScope.batch = readAnnualWriteScopes
function qualifyRead(db: AnnualDb, read: EventAnnualProcessRead, scope: AnnualWriteScope): EventAnnualProcessRead {
  const qualification = qualifyAnnualFinal(db, scope)
  const actual = readAnnualDecisionRefs(db, qualification.decisionRefs.map(ref => ref.relationId), scope)
  const ids = new Set(qualification.decisionRefs.map(ref => ref.id))
  return { ...read, process: { ...read.process, finalQualification: { ...qualification, decisionRefs: actual.filter(ref => ids.has(ref.id)) } } }
}
/** The public read owns the source snapshot, so final qualification shares it. */
export function readQualifiedAnnualProcess(db: AnnualDb, eventId: number) {
  return db.transaction(() => {
    const read = readEventAnnualProcess(db, eventId)
    return read ? qualifyRead(db, read, writeScope(db, read)) : null
  })
}
/** Independent callers may have read before another source commit. Recheck the
 * generation in this read snapshot rather than attach a new final to old facts.
 * Root's read adapter can keep read+enrich in one outer read-only transaction. */
export function enrichAnnualProcessFinalQualification(db: AnnualDb, read: EventAnnualProcessRead): EventAnnualProcessRead {
  return db.transaction(() => {
    const fresh = readEventAnnualProcess(db,read.process.event.id)
    if (!fresh || fresh.sourceGeneration !== read.sourceGeneration) return {...read,process:{...read.process,finalQualification:{stepId:null,status:'blocked',decisionRefs:[],reasons:[fresh?'source_generation_changed':'event_unavailable']}}}
    const scope = writeScope(db,fresh)
    return qualifyRead(db, read, scope)
  })
}
/** Internal ID-only port. Sources and protective history are read here; callers
 * cannot supply facts, eligibility, a history map or a loader. */
export function readAnnualComparisonInputs(sqlite: Database.Database, db: AnnualDb, request: Parameters<typeof readAnnualComparisonBatch>[2]) {
  const batch = readAnnualComparisonBatch(sqlite, db, request)
  if (batch.kind === 'absent') return { processes: [], admission: batch.admission }
  const historyFor = (ids: number[]) => ids.flatMap(id => {
    const rows = batch.history.get(id)
    if (!rows) throw new Error('platform_comparison_scope_unavailable')
    return rows
  })
  const processes = batch.entries.map(({ input, read }) => {
    const scope = projectAnnualWriteScope(read, historyFor)
    const currentDecisionRefs = readAnnualDecisionRefs(db, [...new Set(scope.steps.flatMap(step => [...step.protectionRelationIds, ...step.currentRelationIds]))], scope)
    const final = qualifyAnnualFinal(db, scope)
    const used = new Set(final.decisionRefs.map(ref => ref.id))
    return { input, sourceRefs: read.sourceRefs, sourceGeneration: read.sourceGeneration, currentDecisionRefs,
      finalQualification: { ...final, decisionRefs: currentDecisionRefs.filter(ref => used.has(ref.id)) } }
  })
  return { processes, admission: batch.admission }
}
export { projectAnnualWriteScope, annualScopeRecordIds, annualTaskContext } from './annual-correspondence-projection'
