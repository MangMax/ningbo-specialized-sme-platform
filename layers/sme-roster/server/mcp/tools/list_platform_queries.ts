import { z } from 'zod'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { PLATFORM_INTERFACE_VALUES, TITLE_ORDER } from '../../../lib/labels'
import { readPostgresPlatformQueries } from '../../../lib/platform/postgres-query-read'
import { usePostgresDirectoryDb } from '../../../../../db/postgresql/client'

export default defineMcpTool({
  name: 'list_platform_queries', title: '读取平台查询历史',
  description: '等价 GET /api/platform/queries。按ID、来源、查询键、统代、企业、称号和状态SQL分页，同范围状态计数。默认返回提取后的记录与来源定位；view=summary 仅返回查询元数据与记录数，以 relationsIncluded:false 标记。recognized_list 唯一对应 queryBusList。只读，不查询外部平台。',
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inputSchema: {
    interface: z.enum(PLATFORM_INTERFACE_VALUES).optional(), queryKey: z.string().optional(), uscc: z.string().optional(),
    queryId: z.number().int().positive().optional(), view: z.enum(['full', 'summary']).optional(),
    enterpriseId: z.number().int().positive().optional(), titleCode: z.enum(TITLE_ORDER as [string, ...string[]]).optional(),
    status: z.enum(['success', 'failed', 'no_record', 'not_queried', 'partial']).optional(),
    page: z.number().int().positive().optional(), pageSize: z.number().int().min(1).max(200).optional(),
  },
  handler: async input => {
    const postgres = usePostgresDirectoryDb()
    return { ...await readPostgresPlatformQueries(postgres, input) }
  },
})
