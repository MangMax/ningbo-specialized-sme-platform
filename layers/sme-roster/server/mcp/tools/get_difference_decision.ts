import { z } from 'zod'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { readPostgresDecision102 } from '../../utils/decision-lifecycle/postgres-reads'
import { decisionReadMcp102 } from '../../utils/decision-lifecycle-output'
export default defineMcpTool({ name: 'get_difference_decision', title: '读取差异决定版本', description: '按稳定 id 读取历史决定及 isCurrent；不含平台原文。', annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, inputSchema: { id: z.number().int().positive() }, handler: async input => decisionReadMcp102(tx => readPostgresDecision102(tx, input.id)) })
