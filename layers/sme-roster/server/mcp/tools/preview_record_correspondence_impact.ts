import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { useDb } from '@db'
import { recordComparisonInput } from '#sme-roster/lib/roster/record-comparison'
import { previewRecordCorrespondenceImpact } from '../../utils/record-comparison'
import { previewPostgresRecordCorrespondenceImpact } from '../../utils/record-comparison-postgres'
import { usePostgresRosterDb } from '../../utils/postgres-roster-db'
const legacyImpactInput = recordComparisonInput.omit({ proofIds: true })
export default defineMcpTool({ name: 'preview_record_correspondence_impact', title: '旧结论只读影响预览', description: '等价 GET /api/roster/record-comparison/legacy-impact；沿用旧结论预览口径，不接受 proofIds，不写业务库或旧结论。', annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, inputSchema: legacyImpactInput.shape, handler: async (input, extra) => {
  const parsed = legacyImpactInput.parse(input), pg = usePostgresRosterDb()
  return pg ? previewPostgresRecordCorrespondenceImpact(pg, parsed, extra?.signal) : previewRecordCorrespondenceImpact(useDb(), parsed)
} })
