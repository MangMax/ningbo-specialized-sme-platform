import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { useDb } from '@db'
import { candidateJobInput } from '../../utils/jobs/candidate-discovery'
import { dispatchCandidateJobMcp } from '../../utils/candidate-job-api'
import { writeGuard } from '../../../layers/core/server/utils/mcp-guard'
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
    dispatchCandidateJobMcp('submit', input, {
      get db() {
        return useDb()
      },
      filesDir: useRuntimeConfig().filesDir,
      authorized: true,
    }),
})
