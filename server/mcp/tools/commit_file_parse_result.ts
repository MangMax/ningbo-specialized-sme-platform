import type { LogContext } from '../../../lib/logging'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { useDb } from '@db'
import { parseCommitMcp310, commitParse310 } from '../../utils/parse-maintenance-105'
import { writeGuard } from '../../utils/mcp-guard'
export default defineMcpTool({
  name: 'commit_file_parse_result', title: '提交冻结输入的名单解析',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  enabled: writeGuard,
  description: '当前推荐写口:必须带preflight_file_parse_result原inputRef、独立expectedVersion、全部parts、idempotencyKey/actor/reason。禁止缺输入依据后降级旧口。新提交输入变更或输出CAS冲突拒绝并要求重读/重新预检,不换最新OCR;同键同输入先恢复原回执,异载荷409。段/状态/血缘/审计原子提交;保留正式出处页码/人工分节及确认。回执{receiptId,replayed,state},缺失历史血缘unknown。仅改状态走原save_parse_result,保留原输入依据。需NUXT_MCP_TOKEN。',
  inputSchema: parseCommitMcp310.shape,
  handler: ({ fileId, ...input }, extra) => commitParse310(useDb(), fileId, input, useRuntimeConfig().filesDir, (extra as { logContext?: LogContext } | undefined)?.logContext),
})
