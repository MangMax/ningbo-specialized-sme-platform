import type { LogContext } from '../../../lib/logging'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { maintainFileForAgent } from '../../utils/file-maintenance-agent'
import { fileRefShape } from '../../utils/mcp-files'
import { fileMaintenanceControlShape } from '../../utils/file-maintenance-contract'
import { writeGuard } from '../../utils/mcp-guard'
export default defineMcpTool({
  name: 'remove_file', title: '移出文件库', enabled: writeGuard,
  description: '只做软移出，保留磁盘字节、稳定 ID 和正式出处。没有磁盘删除能力。必须同时提供 expectedRevision/idempotencyKey/actor/basis，并使用 MCP token。',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inputSchema: { ...fileRefShape, ...fileMaintenanceControlShape }, handler: (input, extra) => maintainFileForAgent('remove', input, (extra as { logContext?: LogContext } | undefined)?.logContext),
})
