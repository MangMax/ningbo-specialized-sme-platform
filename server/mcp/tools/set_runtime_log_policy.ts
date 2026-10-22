import { z } from 'zod'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { writeGuard } from '../../utils/mcp-guard'
import { loggingMcpResult } from '../../utils/logging-mcp'
export default defineMcpTool({ name: 'set_runtime_log_policy', description: '修改独立日志保留策略；需MCP token。等价PATCH /api/logs/policy，仅影响运行日志。', enabled: writeGuard, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }, inputSchema: { retentionDays: z.number().int().min(1).max(365), maxBytes: z.number().int().min(1048576).max(4294967296) }, handler: input => loggingMcpResult('setPolicy', input) })
