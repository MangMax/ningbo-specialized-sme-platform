import { z } from 'zod'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { writeGuard } from '../../utils/mcp-guard'
import { logFilterSchema, loggingMcpResult } from '../../utils/logging-mcp'
export default defineMcpTool({ name: 'clear_runtime_logs', description: '确认范围清理运行日志；需MCP token。from/to/confirm:true必填，最多1000条一次，hasMore提示重复。等价POST /api/logs/clear，不删除审计/源文件/产物。', enabled: writeGuard, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }, inputSchema: { ...logFilterSchema, from: z.string().max(32), to: z.string().max(32), confirm: z.literal(true) }, handler: input => loggingMcpResult('clear', input) })
