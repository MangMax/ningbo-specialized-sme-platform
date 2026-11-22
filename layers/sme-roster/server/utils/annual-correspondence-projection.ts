import type { EventAnnualProcessRead } from '../../lib/roster/annual-process'
import type { AnnualWriteScope } from './annual-correspondence-contract'

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

export function annualScopeRecordIds(read: EventAnnualProcessRead) {
  return [...new Set(read.process.steps.flatMap(step => step.groups.flatMap(g => g.observationRefs.flatMap(ref => ref.businessRecord.recordId === null ? [] : [ref.businessRecord.recordId]))))]
}

/** No database access until an authorized command or actual read needs it. */
export function annualTaskContext() {
  const config = useRuntimeConfig()
  return { filesDir: config.filesDir, config }
}
