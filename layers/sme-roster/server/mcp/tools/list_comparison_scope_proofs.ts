import { z } from 'zod'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { useDb } from '@db'
import { dispatchComparisonScopeProofMcp } from '../../utils/mcp-comparison-scope-proof'
export default defineMcpTool({ name: 'list_comparison_scope_proofs', title: '列出来源范围证明', description: '等价 GET /api/roster/comparison-scope-proofs；显示候选、已确认、撤销及来源漂移。', annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, inputSchema: { kind: z.enum(['official_coverage', 'current_source_equivalence']).optional(), status: z.enum(['candidate', 'confirmed', 'revoked']).optional(), page: z.number().int().positive().optional(), pageSize: z.number().int().positive().max(200).optional() }, handler: async input => dispatchComparisonScopeProofMcp('list', input, { get db() { return useDb() } }) })
