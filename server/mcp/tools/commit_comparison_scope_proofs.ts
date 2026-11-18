import { z } from 'zod'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { useDb } from '@db'
import { proofRequest } from '../../../layers/sme-roster/server/utils/comparison-scope-proof'
import { dispatchComparisonScopeProofMcp } from '../../../layers/sme-roster/server/utils/mcp-comparison-scope-proof'
import { writeGuard } from '../../../layers/core/server/utils/mcp-guard'
export default defineMcpTool({ name: 'commit_comparison_scope_proofs', title: '原子提交来源范围证明', description: '等价 POST /api/roster/comparison-scope-proofs/commit；提交预检请求和 planHash，需要 MCP token。', annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }, enabled: writeGuard, inputSchema: { request: proofRequest, planHash: z.string().regex(/^[0-9a-f]{64}$/) }, handler: async input => dispatchComparisonScopeProofMcp('commit', input, { db: useDb(), authorized: true }) })
