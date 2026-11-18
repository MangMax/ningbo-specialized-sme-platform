import type { LogContext } from '../../../lib/logging'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { maintainFileForAgent } from '../../utils/file-maintenance-agent'
import { fileRefShape } from '../../../../../server/utils/mcp-files'
import { fileMaintenanceControlShape } from '../../utils/file-maintenance-contract'
import { writeGuard } from '../../../../../server/utils/mcp-guard'
export default defineMcpTool({
  name: 'restore_file', title: '恢复已移出的文件', enabled: writeGuard,
  description: '复用 POST /api/files/:id/restore，核验库内原文件存在性、字节数、SHA-256 和状态。保留原 ID，不重导正式事件。必须同时提供 expectedRevision/idempotencyKey/actor/basis，并使用 MCP token。',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inputSchema: { ...fileRefShape, ...fileMaintenanceControlShape }, handler: (input, extra) => maintainFileForAgent('restore', input, (extra as { logContext?: LogContext } | undefined)?.logContext),
})
