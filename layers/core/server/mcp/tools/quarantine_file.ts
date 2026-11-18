import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { physicalFileForAgent } from '../../utils/file-physical-agent'
import { fileRefShape } from '../../utils/file-agent-reference'
import { fileMaintenanceControlShape } from '../../utils/file-maintenance-contract'
import { writeGuard } from '../../utils/mcp-guard'
export default defineMcpTool({
  name: 'quarantine_file', title: 'quarantine_file', description: '显式隔离原文件；保留原 ID/路径和字节。正式出处引用禁止隔离。必须完整维护封套；同键返回原完成回执。',
  enabled: writeGuard,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  inputSchema: { ...fileRefShape, ...fileMaintenanceControlShape, }, handler: input => physicalFileForAgent('quarantine', input),
})
