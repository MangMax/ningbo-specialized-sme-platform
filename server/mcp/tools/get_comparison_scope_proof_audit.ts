import { z } from 'zod'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { useDb } from '@db'
import { dispatchComparisonScopeProofMcp } from '../../utils/mcp-comparison-scope-proof'
export default defineMcpTool({ name: 'get_comparison_scope_proof_audit', title: '读取范围证明决定审计', description: '等价 GET /api/roster/comparison-scope-proofs/:id/audit。', annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, inputSchema: { id: z.number().int().positive(), page: z.number().int().positive().optional(), pageSize: z.number().int().positive().max(200).optional() }, handler: async input => dispatchComparisonScopeProofMcp('audit', input, { db: useDb() }) })
