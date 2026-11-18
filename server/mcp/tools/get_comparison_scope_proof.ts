import { z } from 'zod'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { useDb } from '@db'
import { dispatchComparisonScopeProofMcp } from '../../../layers/sme-roster/server/utils/mcp-comparison-scope-proof'
export default defineMcpTool({ name: 'get_comparison_scope_proof', title: '读取来源范围证明', description: '等价 GET /api/roster/comparison-scope-proofs/:id。', annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, inputSchema: { id: z.number().int().positive() }, handler: async input => dispatchComparisonScopeProofMcp('get', input, { db: useDb() }) })
