import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { useDb } from '@db'
import { currentDecision102, decisionScope102 } from '../../../layers/sme-roster/server/utils/decision-lifecycle-102'
import { decisionMcp102 } from '../../../layers/sme-roster/server/utils/decision-lifecycle-102-output'
export default defineMcpTool({ name: 'get_current_difference_decision', title: '读取当前差异决定', description: '按企业称号方向精确读当前决定及用于下次命令的 versionId；撤回后 current=null，versionId 仍指撤回版本。', annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, inputSchema: decisionScope102.shape, handler: async input => decisionMcp102(useDb(), () => useDb().transaction(tx => currentDecision102(tx, input))) as Record<string, unknown> })
