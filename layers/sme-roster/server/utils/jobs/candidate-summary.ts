import { type CandidateRead, projectCandidateSummary } from './candidate-summary-postgres'
import { CANDIDATE_JOB_KIND } from './candidate-discovery-contract'
import type { ProjectedTask } from './task-summary'
export function readCandidateSummary(row: ProjectedTask, detail: boolean) {
  const discovery = row.kind === CANDIDATE_JOB_KIND ? JSON.parse(row.discoveryMeta || '{}') as CandidateRead : null
  return projectCandidateSummary(row.state, discovery, detail)
}
export { candidateTaskLinks, summarizePostgresCandidateJobs } from './candidate-summary-postgres'
