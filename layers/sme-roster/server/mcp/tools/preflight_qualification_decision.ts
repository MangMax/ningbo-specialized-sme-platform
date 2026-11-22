import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { qualificationPreflight102 } from '../../utils/decision-lifecycle/contract'
import { writeGuard } from '../../../../core/server/utils/mcp-guard'
import { decisionWriteMcp102 } from '../../utils/decision-lifecycle-output'
import { preflightPostgresQualification102 } from '../../utils/decision-lifecycle/postgres-writes'
export default defineMcpTool({ name: 'preflight_qualification_decision', title: '迁入资格preflight', description: '等价 POST /api/roster/decision-lifecycle/qualification-preflight；仅有 currentQualification 的 replace；来源、事实和 head 版本绑定。', annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, enabled: writeGuard, inputSchema: qualificationPreflight102.shape, handler: async input => decisionWriteMcp102(db => preflightPostgresQualification102(db, input), false) })
