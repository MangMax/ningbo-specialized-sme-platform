import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { useDb } from '@db'
import { recordComparisonInput } from '~~/lib/roster/record-comparison'
import { readRecordComparison } from '../../utils/record-comparison-read'
export default defineMcpTool({ name: 'list_record_comparison', title: '记录级对比', description: '等价 GET /api/roster/record-comparison；显式来源 ID 和可选已确认 proofIds，逐正式事件分类，保留原观察资格与计数；附加scoped业务/版本/观察分组与businessCounts。businessPage/businessPageSize独立分页，未索引/缺编号/冲突/内容不可核实观察独立unknown。只读。', annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, inputSchema: recordComparisonInput.shape, handler: async (input, extra) => { const db = useDb(); const parsed = recordComparisonInput.parse(input); return readRecordComparison(db, parsed, extra?.signal) } })
