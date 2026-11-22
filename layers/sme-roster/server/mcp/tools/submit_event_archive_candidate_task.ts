import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { candidateJobInput } from '../../utils/jobs/candidate-discovery-contract'
import { dispatchPostgresCandidateJobMcp } from '../../utils/candidate-job-runtime'
import { writeGuard } from '../../../../core/server/utils/mcp-guard'
export default defineMcpTool({
  name: 'submit_event_archive_candidate_task',
  title: '异步生成归档候选任务',
  description:
    '等价 POST /api/roster/correspondences/tasks，范围 eventIds/titleCode/queryId 恰选一种，clientRequestId 幂等；仅生成候选，不确认；复用统一任务队列、断点与领域预检提交。',
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  enabled: writeGuard,
  inputSchema: candidateJobInput.shape,
  handler: async (input) =>
    dispatchPostgresCandidateJobMcp('submit', input, {
      filesDir: useRuntimeConfig().filesDir,
      authorized: true,
    }),
})
