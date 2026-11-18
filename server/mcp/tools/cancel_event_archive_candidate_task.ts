import { z } from 'zod'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { useDb } from '@db'
import { dispatchCandidateJobMcp } from '../../utils/candidate-job-api'
import { writeGuard } from '../../../layers/core/server/utils/mcp-guard'
export default defineMcpTool({
  name: 'cancel_event_archive_candidate_task',
  title: '取消公布事件候选任务',
  description:
    '复用任务中心 cancel，保留已完成结果，失败/取消从断点续跑，最多10次执行；原行从结果事件入口读取。',
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  enabled: writeGuard,
  inputSchema: { id: z.string().length(26) },
  handler: async (input) =>
    dispatchCandidateJobMcp('cancel', input, {
      get db() {
        return useDb()
      },
      filesDir: useRuntimeConfig().filesDir,
      authorized: true,
    }),
})
