import { z } from 'zod'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { useDb } from '@db'
import { dispatchRecordCorrespondenceMcp } from '../../../layers/sme-roster/server/utils/mcp-record-correspondence'
export default defineMcpTool({
  name: 'discover_event_archive_candidates', title: '从公布事件自动查找平台归档候选',
  description: '等价 POST /api/roster/correspondences/discover。只需正式认定/复核eventId，无需归档ID；候选与查询覆盖独立有界分页。保留三接口全部历史查询状态、缺失和冲突，不写关系、不自动确认。错误为 isError=true 的 JSON error.code/message。',
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inputSchema: { eventId: z.number().int().positive(), page: z.number().int().positive().optional(), pageSize: z.number().int().min(1).max(200).optional(), queryPage: z.number().int().positive().optional(), queryPageSize: z.number().int().min(1).max(200).optional() },
  handler: async input => dispatchRecordCorrespondenceMcp('discover', input, { get db() { return useDb() } }),
})
