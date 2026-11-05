import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { z } from 'zod'
import { physicalFileForAgent } from '../../utils/file-physical-agent'
import { fileRefShape } from '../../utils/mcp-files'
import { fileMaintenanceControlShape } from '../../utils/file-maintenance-contract'
import { writeGuard } from '../../utils/mcp-guard'
export default defineMcpTool({
  name: 'recover_file', title: 'recover_file', description: '按 intentId 从隔离区验证登记 SHA+bytes，恢复同一文件，不覆盖原路径。必须完整维护封套。',
  enabled: writeGuard,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inputSchema: { ...fileRefShape, ...fileMaintenanceControlShape, intentId: z.string().min(1).max(100), }, handler: input => physicalFileForAgent('recover', input),
})
