import { z } from 'zod'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { useDb } from '@db'
import { decisionHistory102, historyDecision102 } from '../../utils/decision-lifecycle-102'
import { historyPostgresDecision102 } from '../../utils/decision-lifecycle-102/postgres-reads'
import { decisionReadMcp102 } from '../../utils/decision-lifecycle-102-output'
export default defineMcpTool({ name: 'list_difference_decision_history', title: '分页读取差异决定历史', description: '给稳定 id 或完整 enterpriseId/titleCode/direction，按登记时间倒序分页 pageSize<=50；不含平台原文。', annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, inputSchema: { id: z.number().int().positive().optional(), enterpriseId: z.number().int().positive().optional(), titleCode: z.enum(['little_giant','specialized_sme','innovative_sme']).optional(), direction: z.enum(['missing_in_miit','extra_in_miit']).optional(), page: z.number().int().positive().optional(), pageSize: z.number().int().positive().max(50).optional() }, handler: async input => decisionReadMcp102(useDb, tx => historyDecision102(tx, decisionHistory102.parse(input)), tx => historyPostgresDecision102(tx, decisionHistory102.parse(input))) })
