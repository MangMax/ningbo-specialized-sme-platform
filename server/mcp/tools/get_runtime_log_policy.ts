import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { writeGuard } from '../../utils/mcp-guard'
import { loggingMcpResult } from '../../utils/logging-mcp'
export default defineMcpTool({ name: 'get_runtime_log_policy', description: '受保护日志保留策略、容量与drop/不可用计数；需MCP token。等价GET /api/logs/policy。', enabled: writeGuard, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, inputSchema: {}, handler: () => loggingMcpResult('policy', {}) })
