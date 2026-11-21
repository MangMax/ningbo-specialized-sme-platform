import type Database from 'better-sqlite3'
import { useDb } from '../../../../db'
import type { EventAnnualProcessRead } from '../../lib/roster/annual-process'
import { qualifyAnnualFinal,readAnnualDecisionRefs,type AnnualDb,type AnnualWriteScope } from './annual-correspondence'
import { readTargetAnnualHistory } from './annual-process-target-sources'
import { readAnnualComparisonBatch,readAnnualProcessBatch,readEventAnnualProcess } from './event-annual-process-read'

export function projectAnnualWriteScope(read: EventAnnualProcessRead, historyFor: (recordIds: number[]) => number[]): AnnualWriteScope {
  const process = read.process
  return {
    eventId: process.event.id, enterpriseId: process.event.record.enterpriseId, titleCode: process.event.record.titleCode,
    declareKind: process.declareKind, generation: read.sourceGeneration, sourceRefs: read.sourceRefs,
    finalCandidateStepId: process.finalCandidateStepId, reasons: process.reasons,
    steps: process.steps.map(step => {
      const observations = step.groups.flatMap(group => group.observationRefs)
      const currentRelationIds = observations.filter(ref => {
        const facts = ref.evidence.process as {status?:unknown; normalizationConflicts?:unknown[]} | undefined
        return facts?.status === step.status && !facts.normalizationConflicts?.length && step.latestVersionRefs.some(version =>
          version.interface === ref.interface && version.recordId === ref.businessRecord.recordId && version.versionId === ref.businessRecord.versionId)
      }).map(ref => ref.relationId)
      const recordIds = [...new Set(observations.filter(ref => ref.businessRecord.groupState === 'verified' && ref.businessRecord.recordId != null).map(ref => ref.businessRecord.recordId!))]
      const history = historyFor(recordIds)
      // Indexed identity history is protective only. It never expands annual
      // facts, selected versions, generation, or borrowed proof eligibility.
      return {stepId:step.id,currentRelationIds:[...new Set(currentRelationIds)],protectionRelationIds:[...new Set([...observations.map(ref => ref.relationId),...history])],
        preferredRelationId:step.preferredWriteRelationId,eligible:step.annualEligible,reasons:step.reasons}
    }),
  }
}
function writeScope(db: AnnualDb, read: EventAnnualProcessRead) {
  const history = readTargetAnnualHistory(db, annualScopeRecordIds(read))
  return projectAnnualWriteScope(read, ids => ids.flatMap(id => history.get(id) ?? []))
}

export function annualScopeRecordIds(read: EventAnnualProcessRead) {
  return [...new Set(read.process.steps.flatMap(step => step.groups.flatMap(g => g.observationRefs.flatMap(ref => ref.businessRecord.recordId === null ? [] : [ref.businessRecord.recordId]))))]
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
/** No database access until an authorized command or actual read needs it. */
export function annualTaskContext() {
  const config = useRuntimeConfig()
  return {get db(){return useDb()},readScope:readAnnualWriteScope,filesDir:config.filesDir,config}
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
