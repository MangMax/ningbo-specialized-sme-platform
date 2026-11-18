import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { useDb } from '@db'
import { parsePreflightMcp310, preflightRanges669 } from '../../../layers/sme-roster/server/utils/parse-maintenance-105'
import { writeGuard } from '../../../layers/core/server/utils/mcp-guard'
export default defineMcpTool({
  name: 'preflight_file_parse_result', title: '冻结名单解析文件/OCR输入',
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  enabled: writeGuard,
  description: '可选verifyPhysicalPages=true核实实际PDF物理页数及内容epoch;返回inputRef.physicalSource,Office不支持。当前解析先预检。fileId+kind=file核实实际磁盘hash与登记一致;kind=ocr必须提交实际读过的pages:[{page,version}]版本(id:revision),不自动采用最新页。返回独立expectedVersion与inputRef,仅核所选页;输入改变409要求重读。解析后将原inputRef交commit_file_parse_result。不写文件/OCR/名录。需NUXT_MCP_TOKEN。',
  inputSchema: parsePreflightMcp310.shape,
  handler: ({ fileId, ...input }) => preflightRanges669(useDb(), fileId, input, useRuntimeConfig().filesDir),
})
