import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { useDb } from '@db'
import { recordComparisonInput } from '~~/lib/roster/record-comparison'
import { getRecordComparison } from '../../utils/record-comparison'
import { resolveVerifiedComparisonEvidence } from '../../utils/comparison-scope-proof'
export default defineMcpTool({ name: 'list_record_comparison', title: '记录级对比', description: '等价 GET /api/roster/record-comparison；显式来源 ID 和可选已确认 proofIds，逐正式事件分类。只读。', annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, inputSchema: recordComparisonInput.shape, handler: async input => { const db = useDb(); const parsed = recordComparisonInput.parse(input); return getRecordComparison(db, parsed, resolveVerifiedComparisonEvidence(db, parsed.proofIds ?? [])) } })
