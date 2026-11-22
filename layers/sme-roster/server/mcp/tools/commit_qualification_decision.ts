import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { qualificationCommit102 } from '../../utils/decision-lifecycle/contract'
import { writeGuard } from '../../../../core/server/utils/mcp-guard'
import { decisionWriteMcp102 } from '../../utils/decision-lifecycle-output'
import { commitPostgresQualification102 } from '../../utils/decision-lifecycle/postgres-writes'
export default defineMcpTool({ name: 'commit_qualification_decision', title: '迁入资格commit', description: '等价 POST /api/roster/decision-lifecycle/qualification-commit；仅有 currentQualification 的 replace；来源、事实和 head 版本绑定。', annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }, enabled: writeGuard, inputSchema: qualificationCommit102.shape, handler: async input => decisionWriteMcp102(db => commitPostgresQualification102(db, input)) })
