import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { useDb } from '@db'
import { writeGuard } from '../../../../core/server/utils/mcp-guard'
import { evidenceCorrectionRequestSchema } from '../../utils/roster-evidence-correction'
import { dispatchEvidenceCorrectionMcp } from '../../utils/mcp-roster-evidence-correction'
export default defineMcpTool({ name: 'preflight_roster_evidence_corrections', title: '预检正式出处精确更正', description: '等价POST /api/roster/evidence/corrections/preflight。先get_roster_evidence取得版本，最多100条；精确证据/事件/所属记录/企业ID、全坐标、actor/basis。只读预检仍需MCP token。', annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, enabled: writeGuard, inputSchema: evidenceCorrectionRequestSchema.shape, handler: async input => dispatchEvidenceCorrectionMcp('preflight', input, { get db() { return useDb() }, filesDir: useRuntimeConfig().filesDir, authorized: true }) })
