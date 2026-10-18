import { z } from 'zod'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { useDb } from '@db'
import { PLATFORM_INTERFACE_VALUES, TITLE_ORDER } from '../../../lib/labels'
import { listPlatformQueries } from '../../../lib/platform/read'

export default defineMcpTool({
  name: 'list_platform_queries', title: '读取已存平台证据历史',
  description: '等价 GET /api/platform/queries。按来源、查询键、统代、企业、称号和状态分页，保留每次查询的全部关系及原始采集页范围。recognized_list 唯一对应 queryBusList。只读，不查询外部平台。',
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inputSchema: {
    interface: z.enum(PLATFORM_INTERFACE_VALUES).optional(), queryKey: z.string().optional(), uscc: z.string().optional(),
    enterpriseId: z.number().int().positive().optional(), titleCode: z.enum(TITLE_ORDER as [string, ...string[]]).optional(),
    status: z.enum(['success', 'failed', 'no_record', 'not_queried', 'partial']).optional(),
    page: z.number().int().positive().optional(), pageSize: z.number().int().min(1).max(200).optional(), includeRawResponse: z.boolean().optional(),
  },
  handler: async input => ({ ...listPlatformQueries(useDb(), input) }),
})
