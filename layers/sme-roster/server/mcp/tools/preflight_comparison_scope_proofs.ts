import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { useDb } from '@db'
import { proofRequest } from '../../utils/comparison-scope-proof'
import { dispatchComparisonScopeProofMcp } from '../../utils/mcp-comparison-scope-proof'
import { writeGuard } from '../../../../core/server/utils/mcp-guard'
export default defineMcpTool({ name: 'preflight_comparison_scope_proofs', title: '预检正式覆盖或当前来源等价证明', description: '等价 POST /api/roster/comparison-scope-proofs/preflight；需要 MCP token。只接受已归档来源引用和明确依据，写入幂等计划。', annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }, enabled: writeGuard, inputSchema: proofRequest.shape, handler: async input => dispatchComparisonScopeProofMcp('preflight', input, { db: useDb(), authorized: true }) })
