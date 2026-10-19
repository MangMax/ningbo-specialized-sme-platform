import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { useDb } from '@db'
import { getParse105, parseRead105 } from '../../utils/parse-maintenance-105'
export default defineMcpTool({
  name: 'get_file_parse_result', title: '读取解析段/状态及并发版本',
  description: '按稳定fileId只读解析状态、全部有效段(origin/hasConflict)、version。修改前用此version作为expectedVersion;不回填、不修改OCR/名录。',
  annotations: { readOnlyHint: true, openWorldHint: false }, inputSchema: parseRead105.shape,
  handler: input => getParse105(useDb(), input.fileId),
})
