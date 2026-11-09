import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { useDb } from '@db'
import { getParse105, parseRead105 } from '../../utils/parse-maintenance-105'
export default defineMcpTool({
  name: 'get_file_parse_result', title: '读取解析段/状态及并发版本',
  description: '另返回#669 declarations稳定声明身份/修订/文件SHA/内容epoch/范围;null未知,[]显式清空;范围历史见get_file_parse_history。按稳定fileId只读解析状态、全部有效段(origin/hasConflict)、输出version和inputLineage(bound或unknown)。历史缺血缘不补当前hash。version仅保护输出,不是输入依据;当前解析走preflight_file_parse_result→commit_file_parse_result。状态更正仍用此version;不回填、不修改OCR/名录。',
  annotations: { readOnlyHint: true, openWorldHint: false }, inputSchema: parseRead105.shape,
  handler: input => getParse105(useDb(), input.fileId),
})
