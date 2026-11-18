import { z } from 'zod'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { useDb } from '@db'
import { dispatchCandidateJobMcp } from '../../../layers/sme-roster/server/utils/candidate-job-api'
import { readMcpToken, resolveMcpAuth } from '../../../layers/core/server/utils/mcp-auth'
export default defineMcpTool({
  name: 'get_event_archive_candidate_task',
  title: '读取公布事件候选任务',
  description:
    '复用任务中心 detail，保留已完成结果，失败/取消从断点续跑，最多10次执行；原行从结果事件入口读取。',
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: { id: z.string().length(26) },
  handler: async (input, extra) => {
    const header = (name: string) => {
      const value = extra.requestInfo?.headers[name]
      return Array.isArray(value) ? value[0] : value
    }
    const authorized = resolveMcpAuth({
      given: readMcpToken({
        authorization: header('authorization'),
        'x-mcp-token': header('x-mcp-token'),
      }),
      configured: useRuntimeConfig().mcpToken,
    }).writeAuthorized
    return dispatchCandidateJobMcp('detail', input, {
      get db() {
        return useDb()
      },
      filesDir: useRuntimeConfig().filesDir,
      authorized,
    })
  },
})
