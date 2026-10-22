import type { LogContext } from '../../../lib/logging'
import { z } from 'zod'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { maintainFileForAgent } from '../../utils/file-maintenance-agent'
import { fileRefShape } from '../../utils/mcp-files'
import { fileMaintenanceControlShape } from '../../utils/file-maintenance-contract'
import { writeGuard } from '../../utils/mcp-guard'
export default defineMcpTool({
  name: 'update_file', title: '维护文件元数据或显示名称', enabled: writeGuard,
  description: '复用 PATCH /api/files/:id。patch 白名单 source/kind/year/batch/titleCode 或单独 displayName。显示名不改 ID、路径、字节、OCR 或出处。必须同时提供 expectedRevision/idempotencyKey/actor/basis，并使用 MCP token。',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inputSchema: { ...fileRefShape, ...fileMaintenanceControlShape, patch: z.record(z.string(), z.unknown()) },
  handler: (input, extra) => maintainFileForAgent('update', input, (extra as { logContext?: LogContext } | undefined)?.logContext),
})
