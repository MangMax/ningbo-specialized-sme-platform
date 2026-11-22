import type { CandidateComparisonInput } from '../../lib/roster/platform-comparison'
import type { readAnnualComparisonInputs } from './annual-correspondence-read'

export function projectPlatformComparisonProcesses(processes: ReturnType<typeof readAnnualComparisonInputs>['processes']): CandidateComparisonInput['processes'] {
  return processes.map(p => ({ ...p, input: { ...p.input, groups: p.input.groups.map(group => ({ ...group, observationRefs: group.observationRefs.map(ref => {
    // Source generation was computed from the original full annual projection.
    // Core receives only its established evidence allowlist, without rebuilding it.
    const process = ref.evidence.process as CandidateComparisonInput['processes'][number]['input']['groups'][number]['observationRefs'][number]['evidence']['process']
    const temporal = ref.evidence.temporal as CandidateComparisonInput['processes'][number]['input']['groups'][number]['observationRefs'][number]['evidence']['temporal']
    const source = ref.evidence.source as { identityOnly: boolean }
    return { ...ref, evidence: { process, temporal, source: { identityOnly: source.identityOnly } } }
  }) })) } }))
}
