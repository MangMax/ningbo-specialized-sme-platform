import { z } from 'zod'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { writeGuard } from '../../utils/mcp-guard'
import { loggingMcpResult } from '../../utils/logging-mcp'
import { LOG_LEVELS, LOG_SOURCES, LOG_SUPPORTED_INTEGRATIONS } from '../../../lib/logging/contract'
const rule = z.strictObject({ enabled: z.boolean(), minLevel: z.enum(LOG_LEVELS) })
export default defineMcpTool({
  name: 'set_runtime_log_policy', description: '修改独立日志保留和双维采集策略；需MCP token。等价PATCH /api/logs/policy。省略采集规则保留已有值，关闭不删除历史。',
  enabled: writeGuard,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  inputSchema: {
    retentionDays: z.number().int().min(1).max(365), maxBytes: z.number().int().min(1048576).max(4294967296),
    collection: z.strictObject({
      sources: z.partialRecord(z.enum(LOG_SOURCES), rule).optional(),
      integrations: z.partialRecord(z.enum(LOG_SUPPORTED_INTEGRATIONS), rule).optional(),
    }).optional(),
  },
  handler: input => loggingMcpResult('setPolicy', input),
})
