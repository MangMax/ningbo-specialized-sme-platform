import { z } from 'zod'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { writeGuard } from '../../../../../server/utils/mcp-guard'
import { loggingMcpResult } from '../../utils/logging-mcp'
export default defineMcpTool({ name: 'get_runtime_log', description: '受保护脱敏运行日志详情；需MCP token。事件UUID精确读取，等价GET /api/logs/{id}。', enabled: writeGuard, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, inputSchema: { id: z.string().uuid() }, handler: input => loggingMcpResult('detail', input) })
