import { z } from 'zod'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { useDb } from '@db'
import { dispatchComparisonScopeProofMcp } from '../../utils/mcp-comparison-scope-proof'
import { writeGuard } from '../../../layers/core/server/utils/mcp-guard'
export default defineMcpTool({ name: 'get_comparison_scope_proof_batch', title: '恢复范围证明提交回执', description: '等价 GET /api/roster/comparison-scope-proofs/batches/:idempotencyKey；需要 MCP token。', annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, enabled: writeGuard, inputSchema: { idempotencyKey: z.string().min(1) }, handler: async input => dispatchComparisonScopeProofMcp('batch', input, { db: useDb(), authorized: true }) })
