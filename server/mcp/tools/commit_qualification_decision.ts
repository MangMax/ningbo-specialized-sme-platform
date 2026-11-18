import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { useDb } from '@db'
import { commitQualification102, qualificationCommit102 } from '../../../layers/sme-roster/server/utils/decision-lifecycle-102'
import { writeGuard } from '../../../layers/core/server/utils/mcp-guard'
import { decisionMcp102 } from '../../../layers/sme-roster/server/utils/decision-lifecycle-102-output'
export default defineMcpTool({ name: 'commit_qualification_decision', title: '迁入资格commit', description: '等价 POST /api/roster/decision-lifecycle/qualification-commit；仅有 currentQualification 的 replace；来源、事实和 head 版本绑定。', annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }, enabled: writeGuard, inputSchema: qualificationCommit102.shape, handler: async input => decisionMcp102(useDb(), () => commitQualification102(useDb(), input)) as Record<string, unknown> })
