import type { CandidateComparisonInput } from '../../lib/roster/platform-comparison'
import type { projectAnnualProcess } from './event-annual-process-model'

type AnnualComparisonProcess = Omit<CandidateComparisonInput['processes'][number], 'input'> & { input: ReturnType<typeof projectAnnualProcess>['input'] }

export function projectPlatformComparisonProcesses(processes: AnnualComparisonProcess[]): CandidateComparisonInput['processes'] {
  return processes.map(p => ({ ...p, input: { ...p.input, groups: p.input.groups.map(group => ({ ...group, observationRefs: group.observationRefs.map(ref => {
    // Source generation was computed from the original full annual projection.
    // Core receives only its established evidence allowlist, without rebuilding it.
    const process = ref.evidence.process as CandidateComparisonInput['processes'][number]['input']['groups'][number]['observationRefs'][number]['evidence']['process']
    const temporal = ref.evidence.temporal as CandidateComparisonInput['processes'][number]['input']['groups'][number]['observationRefs'][number]['evidence']['temporal']
    const source = ref.evidence.source as { identityOnly: boolean }
    return { ...ref, evidence: { process, temporal, source: { identityOnly: source.identityOnly } } }
  }) })) } }))
}
