import { z } from 'zod'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { writeGuard } from '../../utils/mcp-guard'
import { loggingMcpResult } from '../../utils/logging-mcp'
import { LOG_FIELD_PROFILES } from '../../../lib/logging/field-controls'
import { LOG_LEVELS, LOG_SOURCES, LOG_SUPPORTED_INTEGRATIONS } from '../../../lib/logging/contract'
// Every level and field comes from the implemented catalog; each object stays closed.
const fieldControls = z.strictObject(Object.fromEntries(LOG_FIELD_PROFILES.map(profile => [profile.key,
  z.strictObject(Object.fromEntries(profile.levels.map(level => [level,
    z.strictObject(Object.fromEntries(profile.fields.map(field => [field.key, z.boolean().optional()]))).optional(),
  ]))).optional(),
])))
const rule = z.strictObject({ enabled: z.boolean(), minLevel: z.enum(LOG_LEVELS) })
export default defineMcpTool({
  name: 'set_runtime_log_policy', description: '修改独立日志保留、双维采集和HTTP字段策略；需MCP token。等价PATCH /api/logs/policy。retentionDays/maxBytes必填；省略规则或字段保留已有值，关闭不删除历史。策略arguments序列化UTF-8最多4096字节，不含JSON-RPC封装。',
  enabled: writeGuard,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  inputSchema: {
    retentionDays: z.number().int().min(1).max(365), maxBytes: z.number().int().min(1048576).max(4294967296),
    fieldControls: fieldControls.optional(),
    collection: z.strictObject({
      sources: z.partialRecord(z.enum(LOG_SOURCES), rule).optional(),
      integrations: z.partialRecord(z.enum(LOG_SUPPORTED_INTEGRATIONS), rule).optional(),
    }).optional(),
  },
  handler: input => loggingMcpResult('setPolicy', input),
})
