import type { JobSpec } from '../../../../core/server/public'
import { CANDIDATE_JOB_KIND, candidateJobParams } from './candidate-discovery-contract'
import { runPostgresCandidateDiscovery, retryPostgresCandidateDiscovery } from './candidate-discovery-postgres'
import { summarizePostgresCandidateJobs } from './candidate-summary-postgres'

export const postgresCandidateDiscoverySpec: JobSpec = {
  kind: CANDIDATE_JOB_KIND,
  status: 'ready',
  summary: '公布事件归档候选发现',
  deduplicateRequest: true,
  paramsHint:
    '{clientRequestId,eventIds?:1..200个正式事件ID,titleCode?:称号,queryId?:归档ID,afterEventId?:0,throughEventId?:上界} 三种范围恰选一种；每片最多200事件，每页25原行，按页保存进度，最多10次执行。',
  parse: (raw) => {
    const p = candidateJobParams.safeParse(raw)
    return p.success
      ? {
          ok: true,
          params: {
            ...p.data,
            eventIds: p.data.eventIds
              ? [...new Set(p.data.eventIds)].sort((a, b) => a - b)
              : undefined,
          },
        }
      : { ok: false, message: '候选任务范围或请求标识无效' }
  },
  postgres: {
    run: runPostgresCandidateDiscovery,
    allowBrowserCancel: true,
    taskCenter: { summaries: summarizePostgresCandidateJobs, retry: (db, task) => retryPostgresCandidateDiscovery(db, task.id) },
  },
}
